/**
 * Account discovery — cross-platform auth file detection.
 *
 * Resolution order (matching openai/codex + codex-auth behavior):
 *   1. CODEX_HOME env var → {CODEX_HOME}/accounts/*.auth.json
 *   2. HOME env var → {HOME}/.codex/accounts/*.auth.json
 *   3. USERPROFILE env var (Windows) → {USERPROFILE}/.codex/accounts/*.auth.json
 *   4. os.homedir() fallback → {homedir}/.codex/accounts/*.auth.json
 *
 * Also checks {codex_home}/auth.json directly for CLI-only users
 * (no codex-auth installed — single account mode).
 *
 * Auth-mode policy (mirrors upstream AuthMode::has_chatgpt_account()):
 *   - chatgpt (OAuth tokens)       → discovered via id_token claims
 *   - personalAccessToken          → discovered after whoami hydration
 *   - apikey / agentIdentity /
 *     bedrockApiKey / token-less   → skipped with a stderr warning
 *
 * @module core/accounts
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Account, AuthFile } from './types.js';
import { decodeJwtPayload } from './jwt.js';
import { fetchPatMetadata } from './auth.js';

/** Resolve the Codex home directory across platforms. */
export function resolveCodexHome(): string {
  // 1. CODEX_HOME env var (explicit override, same as openai/codex)
  const envCodexHome = process.env['CODEX_HOME'];
  if (envCodexHome && envCodexHome.length > 0) {
    return envCodexHome;
  }

  // 2. HOME (Linux, macOS)
  const envHome = process.env['HOME'];
  if (envHome && envHome.length > 0) {
    return join(envHome, '.codex');
  }

  // 3. USERPROFILE (Windows native)
  const userProfile = process.env['USERPROFILE'];
  if (userProfile && userProfile.length > 0) {
    return join(userProfile, '.codex');
  }

  // 4. os.homedir() fallback (handles all platforms via Node's built-in logic)
  return join(homedir(), '.codex');
}

interface RegistryAccount {
  account_key: string;
  chatgpt_account_id: string;
  chatgpt_user_id: string;
  email: string;
  alias: string;
  account_name: string | null;
  plan: string | null;
}

interface Registry {
  accounts: RegistryAccount[];
}

export { decodeJwtPayload };

/** Identity extracted from an auth file via JWT id_token claims. */
export interface Identity {
  email: string | null;
  accountId: string | null;
  planType: string | null;
  isFedramp: boolean;
}

/** Extract identity from an OAuth auth file via JWT id_token claims. */
export function extractIdentity(auth: AuthFile): Identity {
  const idToken = auth.tokens?.id_token;
  const claims = typeof idToken === 'string' ? decodeJwtPayload(idToken) : {};
  const authClaims = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const profileClaims = claims['https://api.openai.com/profile'] as Record<string, unknown> | undefined;

  const email =
    (typeof claims.email === 'string' && claims.email) ||
    (typeof profileClaims?.email === 'string' && profileClaims.email) ||
    null;

  // Upstream precedence (login/src/auth/manager.rs): tokens.account_id (a
  // forced workspace override) wins over the id_token claim. The default
  // organization id is a last-resort discovery fallback used by the codex-auth
  // producer; upstream request auth never substitutes it.
  const accountId =
    auth.tokens?.account_id ||
    (typeof authClaims?.chatgpt_account_id === 'string' && authClaims.chatgpt_account_id) ||
    organizationAccountId(authClaims) ||
    null;

  const planType = (typeof authClaims?.chatgpt_plan_type === 'string' && authClaims.chatgpt_plan_type) || null;
  const isFedramp = authClaims?.chatgpt_account_is_fedramp === true;

  return { email, accountId, planType, isFedramp };
}

/** Fallback the producer also accepts: default (or first) organization id. */
function organizationAccountId(authClaims: Record<string, unknown> | undefined): string | null {
  const orgs = authClaims?.organizations;
  if (!Array.isArray(orgs)) return null;
  const records = orgs.filter(
    (org): org is Record<string, unknown> => typeof org === 'object' && org !== null,
  );
  const preferred = records.find((org) => org.is_default === true) ?? records[0];
  return typeof preferred?.id === 'string' ? preferred.id : null;
}

/** Build a map of account_id → registry metadata for quick lookup. */
async function readRegistry(codexHome: string): Promise<Map<string, RegistryAccount>> {
  const map = new Map<string, RegistryAccount>();
  try {
    const content = await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8');
    const registry = JSON.parse(content) as Registry;
    for (const acct of registry.accounts) {
      map.set(acct.chatgpt_account_id, acct);
    }
  } catch {
    // Registry might not exist — that's fine, we fall back to JWT-only data
  }
  return map;
}

/** Check if a file exists (non-throwing). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Non-fatal discovery note; stderr keeps `--json` stdout machine-readable. */
function warn(message: string): void {
  process.stderr.write(`! ${message}\n`);
}

function registryMetaFor(
  registry: Map<string, RegistryAccount>,
  accountId: string,
): Partial<Pick<RegistryAccount, 'email' | 'alias' | 'account_name' | 'plan'>> {
  const meta = registry.get(accountId);
  return {
    email: meta?.email,
    alias: meta?.alias,
    account_name: meta?.account_name,
    plan: meta?.plan,
  };
}

function buildAccount(
  authFile: AuthFile,
  filepath: string | null,
  identity: Identity,
  registry: Map<string, RegistryAccount>,
): Account {
  const meta = registryMetaFor(registry, identity.accountId!);
  return {
    email: identity.email || meta.email || 'unknown',
    planType: identity.planType || meta.plan || 'unknown',
    accountId: identity.accountId!,
    authFile,
    // The producer stores "" for "no alias" — normalize to null.
    alias: meta.alias ? meta.alias : null,
    accountName: meta.account_name ?? null,
    filepath,
    isFedramp: identity.isFedramp,
    authMode: authFile.auth_mode ?? null,
  };
}

/** Load one auth file into an Account, or explain why it was skipped. */
async function loadAuthFile(
  authFile: AuthFile,
  filepath: string | null,
  registry: Map<string, RegistryAccount>,
  label: string,
): Promise<Account | null> {
  // ChatGPT OAuth: identity comes from the id_token JWT.
  if (authFile.tokens?.id_token) {
    const identity = extractIdentity(authFile);
    if (!identity.accountId) {
      warn(`${label}: no ChatGPT account id in token claims — skipping`);
      return null;
    }
    return buildAccount(authFile, filepath, identity, registry);
  }

  // Personal access token: a real ChatGPT account per upstream
  // AuthMode::has_chatgpt_account(), hydrated via the whoami endpoint.
  if (typeof authFile.personal_access_token === 'string' && authFile.personal_access_token.length > 0) {
    try {
      const metadata = await fetchPatMetadata(authFile.personal_access_token);
      return buildAccount(
        authFile,
        filepath,
        {
          email: metadata.email,
          accountId: metadata.chatgpt_account_id,
          planType: metadata.chatgpt_plan_type,
          isFedramp: metadata.chatgpt_account_is_fedramp,
        },
        registry,
      );
    } catch (err) {
      warn(
        `${label}: personal access token could not be verified (${
          err instanceof Error ? err.message : String(err)
        }) — skipping`,
      );
      return null;
    }
  }

  if (authFile.bedrock_api_key) {
    warn(`${label}: Bedrock API-key accounts have no ChatGPT rate limits — skipping`);
    return null;
  }
  if (authFile.agent_identity) {
    warn(`${label}: agent-identity accounts have no ChatGPT rate limits — skipping`);
    return null;
  }
  if (authFile.OPENAI_API_KEY) {
    warn(`${label}: API-key accounts have no ChatGPT rate limits — skipping`);
    return null;
  }
  warn(`${label}: auth file has no usable credentials — skipping`);
  return null;
}

/** Try to load a single auth.json file (for CLI-only users without codex-auth). */
async function tryLoadLiveAuth(codexHome: string): Promise<Account | null> {
  const liveAuthPath = join(codexHome, 'auth.json');
  try {
    if (!(await fileExists(liveAuthPath))) return null;
    const content = await readFile(liveAuthPath, 'utf-8');
    const authFile = JSON.parse(content) as AuthFile;
    return await loadAuthFile(authFile, liveAuthPath, new Map(), liveAuthPath);
  } catch {
    return null;
  }
}

/** Discover all accounts from {codex_home}/accounts/*.auth.json. */
export async function discoverAccounts(codexHome = resolveCodexHome()): Promise<Account[]> {
  const accountsDir = join(codexHome, 'accounts');
  const registry = await readRegistry(codexHome);
  const accounts: Account[] = [];
  const seen = new Set<string>();

  // 1. Try codex-auth managed accounts directory
  let files: string[];
  try {
    files = await readdir(accountsDir);
  } catch {
    files = [];
  }

  for (const filename of files) {
    if (!filename.endsWith('.auth.json')) continue;
    const filepath = join(accountsDir, filename);
    try {
      const content = await readFile(filepath, 'utf-8');
      const authFile = JSON.parse(content) as AuthFile;
      const account = await loadAuthFile(authFile, filepath, registry, filename);
      if (!account) continue;

      // Dedupe by email:account_id (same user can have multiple account entries)
      const key = `${account.email}:${account.accountId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      accounts.push(account);
    } catch {
      // Skip unreadable / invalid auth files
    }
  }

  // 2. Fallback: try live auth.json for CLI-only users (no codex-auth)
  if (accounts.length === 0) {
    const liveAccount = await tryLoadLiveAuth(codexHome);
    if (liveAccount) {
      accounts.push(liveAccount);
    }
  }

  return accounts;
}

/** Find a single account by fuzzy query (email, alias, account_id prefix, or index). */
export function findAccount(accounts: Account[], query: string): Account | undefined {
  // Try index (1-based)
  if (/^[1-9]\d*$/.test(query)) {
    const idx = Number(query);
    if (Number.isSafeInteger(idx) && idx <= accounts.length) {
      return accounts[idx - 1];
    }
  }

  const q = query.toLowerCase();
  for (const acct of accounts) {
    if (
      acct.email.toLowerCase() === q ||
      acct.alias?.toLowerCase() === q ||
      acct.accountId.toLowerCase().startsWith(q) ||
      acct.accountName?.toLowerCase() === q
    ) {
      return acct;
    }
  }

  // Partial match
  for (const acct of accounts) {
    if (
      acct.email.toLowerCase().includes(q) ||
      acct.alias?.toLowerCase().includes(q) ||
      acct.accountName?.toLowerCase().includes(q)
    ) {
      return acct;
    }
  }

  return undefined;
}
