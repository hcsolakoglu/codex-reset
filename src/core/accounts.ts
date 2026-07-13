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
 * @module core/accounts
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Account, AuthFile } from './types.js';

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
  plan: string;
}

interface Registry {
  accounts: RegistryAccount[];
}

/** Decode the payload section of a JWT (base64url → JSON). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const decoded = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

/** Extract email and account_id from an auth file via JWT id_token claims. */
export function extractIdentity(auth: AuthFile): {
  email: string | null;
  accountId: string | null;
  planType: string | null;
} {
  const claims = decodeJwtPayload(auth.tokens.id_token);
  const email = (claims.email as string) || null;
  const authClaims = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const accountId = (authClaims?.chatgpt_account_id as string) || auth.tokens.account_id || null;
  const planType = (authClaims?.chatgpt_plan_type as string) || null;
  return { email, accountId, planType };
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

/** Try to load a single auth.json file (for CLI-only users without codex-auth). */
async function tryLoadLiveAuth(codexHome: string): Promise<Account | null> {
  const liveAuthPath = join(codexHome, 'auth.json');
  try {
    if (!(await fileExists(liveAuthPath))) return null;
    const content = await readFile(liveAuthPath, 'utf-8');
    const authFile = JSON.parse(content) as AuthFile;
    const { email, accountId, planType } = extractIdentity(authFile);
    if (!accountId) return null;
    return {
      email: email || 'unknown',
      planType: planType || 'unknown',
      accountId,
      authFile,
      alias: null,
      accountName: null,
    };
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
      const { email, accountId, planType } = extractIdentity(authFile);
      if (!accountId) continue;

      // Dedupe by email:account_id (same user can have multiple account entries)
      const key = `${email}:${accountId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const regMeta = registry.get(accountId);
      accounts.push({
        email: email || regMeta?.email || 'unknown',
        planType: planType || regMeta?.plan || 'unknown',
        accountId,
        authFile,
        alias: regMeta?.alias || null,
        accountName: regMeta?.account_name || null,
      });
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
