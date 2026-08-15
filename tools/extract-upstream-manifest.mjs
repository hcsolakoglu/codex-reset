#!/usr/bin/env node
/**
 * Extract the semantic wire contract from a pinned openai/codex checkout.
 *
 * Emits test/fixtures/upstream-manifest.json. The contract test asserts
 * codex-reset's behavior against that manifest, so upstream drift shows up
 * as a test failure (or a regenerated manifest diff in the drift CI job).
 *
 * Usage:
 *   node tools/extract-upstream-manifest.mjs [--src DIR] [--out FILE]
 *
 * --src defaults to $CODEX_UPSTREAM_DIR or /tmp/codex-upstream and must be a
 * checkout of openai/codex containing codex-rs/.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SRC = process.env.CODEX_UPSTREAM_DIR || '/tmp/codex-upstream';
const DEFAULT_OUT = 'test/fixtures/upstream-manifest.json';

function parseArgs(argv) {
  const args = { src: DEFAULT_SRC, out: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src') args.src = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function read(src, rel) {
  const full = path.join(src, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`missing upstream file: ${full}`);
  }
  return fs.readFileSync(full, 'utf8');
}

/** Slice a Rust item from its declaration to its closing brace.
 * `close` selects item-level ('\n}') or fn-inside-impl ('\n    }') ends. */
function blockAfter(text, decl, what, close = '\n}') {
  const start = text.indexOf(decl);
  if (start === -1) throw new Error(`cannot find ${what ?? decl}`);
  const end = text.indexOf(close, start);
  if (end === -1) throw new Error(`cannot find end of ${what ?? decl}`);
  return text.slice(start, end);
}

function toSnakeCase(variant) {
  return variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Field names of a struct, honoring #[serde(rename)] and flattening. */
function serdeStructFields(block) {
  const fields = [];
  let pendingRename = null;
  let pendingFlattened = false;
  for (const line of block.split('\n')) {
    const rename = line.match(/rename\s*=\s*"([^"]+)"/);
    if (rename) {
      pendingRename = rename[1];
      continue;
    }
    if (line.includes('#[serde(flatten)]')) {
      pendingFlattened = true;
      continue;
    }
    // Struct fields may be private (no `pub`); attrs never look like fields.
    const field = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?([a-z_][a-z0-9_]*)\s*:/);
    if (field) {
      fields.push({
        name: pendingRename ?? field[1],
        optional: line.includes('Option<') || line.includes('skip_serializing_if'),
        flattened: pendingFlattened,
      });
      pendingRename = null;
      pendingFlattened = false;
    }
  }
  return fields;
}

function extractManifest(src) {
  const manifest = { source: { repo: 'openai/codex', extractedFrom: [] } };
  const track = (rel) => manifest.source.extractedFrom.push(rel);

  // --- Endpoints (backend-client, PathStyle::ChatGptApi) ---
  const rlRel = 'codex-rs/backend-client/src/client/rate_limit_resets.rs';
  const rl = read(src, rlRel);
  track(rlRel);
  const chatgptPaths = [...rl.matchAll(/PathStyle::ChatGptApi\s*=>\s*(?:\{\s*)?format!\(\s*"\{\}\/([^"]+)"/g)].map((m) => m[1]);
  if (chatgptPaths.length !== 3) {
    throw new Error(`expected 3 ChatGptApi endpoints, found ${chatgptPaths.length}: ${chatgptPaths}`);
  }
  const bySuffix = Object.fromEntries(chatgptPaths.map((p) => [path.basename(p), `/${p}`]));
  manifest.endpoints = {
    usage: bySuffix['usage'],
    credits: bySuffix['rate-limit-reset-credits'],
    consume: bySuffix['consume'],
  };

  // --- Consume request/response + codes + credit details (backend-client types) ---
  const typesRel = 'codex-rs/backend-client/src/types.rs';
  const types = read(src, typesRel);
  track(typesRel);

  const consumeReq = blockAfter(rl, 'struct ConsumeRateLimitResetCreditRequest', 'consume request struct');
  manifest.consumeRequest = {
    fields: serdeStructFields(consumeReq).map((f) => ({
      name: f.name,
      optionalWhenAbsent: f.optional,
    })),
  };

  const codeEnum = blockAfter(types, 'pub enum ConsumeRateLimitResetCreditCode', 'consume code enum');
  const enumHeader = types.slice(types.indexOf('pub enum ConsumeRateLimitResetCreditCode') - 200, types.indexOf('pub enum ConsumeRateLimitResetCreditCode'));
  const snakeRename = /rename_all\s*=\s*"snake_case"/.test(enumHeader);
  const variants = [...codeEnum.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm)].map((m) => m[1]);
  if (variants.length === 0) throw new Error('no consume code variants found');
  manifest.consumeCodes = {
    casing: snakeRename ? 'snake_case' : 'verbatim',
    values: variants.map((v) => (snakeRename ? toSnakeCase(v) : v)),
  };

  const consumeResp = blockAfter(types, 'pub struct ConsumeRateLimitResetCreditResponse', 'consume response struct');
  manifest.consumeResponse = { fields: serdeStructFields(consumeResp).map((f) => f.name) };

  const creditDetails = blockAfter(types, 'pub struct RateLimitResetCreditDetails', 'credit details struct');
  const creditFields = serdeStructFields(creditDetails);
  manifest.creditFields = {
    required: creditFields.filter((f) => !f.optional).map((f) => f.name),
    optional: creditFields.filter((f) => f.optional).map((f) => f.name),
  };
  const creditList = blockAfter(types, 'pub struct RateLimitResetCreditsDetails', 'credits list struct');
  manifest.creditsResponse = { fields: serdeStructFields(creditList).map((f) => f.name) };

  // --- Usage payload (openapi models) ---
  const payloadRel = 'codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs';
  const payload = read(src, payloadRel);
  track(payloadRel);
  const statusPayload = blockAfter(payload, 'pub struct RateLimitStatusPayload', 'usage payload struct');
  manifest.usageResponse = {
    fields: serdeStructFields(statusPayload).map((f) => f.name),
    reachedTypeKinds: [...blockAfter(payload, 'pub enum RateLimitReachedKind', 'reached kind enum').matchAll(/rename\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
    planTypeValues: [...blockAfter(payload, 'pub enum PlanType', 'plan type enum').matchAll(/rename\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  };

  const detailsRel = 'codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs';
  const details = read(src, detailsRel);
  track(detailsRel);
  const statusDetails = blockAfter(details, 'pub struct RateLimitStatusDetails', 'rate limit details struct');
  manifest.rateLimitDetails = { fields: serdeStructFields(statusDetails).map((f) => f.name) };

  const windowRel = 'codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs';
  const window = read(src, windowRel);
  track(windowRel);
  const windowSnapshot = blockAfter(window, 'pub struct RateLimitWindowSnapshot', 'window snapshot struct');
  manifest.windowFields = serdeStructFields(windowSnapshot).map((f) => f.name);

  const usageWithCredits = blockAfter(types, 'struct RateLimitStatusWithResetCredits', 'usage-with-credits struct');
  manifest.usageResponse.fields.push(
    ...serdeStructFields(usageWithCredits)
      .filter((f) => !f.flattened)
      .map((f) => f.name),
  );

  // --- Plan display names (protocol) ---
  const authRel = 'codex-rs/protocol/src/auth.rs';
  const auth = read(src, authRel);
  track(authRel);
  const fromRaw = blockAfter(auth, 'pub fn from_raw_value', 'from_raw_value', '\n    }');
  const rawToVariant = new Map();
  // Accept both inline arms and rustfmt-wrapped block arms:
  //   "raw" => Self::Known(KnownPlan::V)
  //   "raw" => { Self::Known(KnownPlan::V) }
  for (const m of fromRaw.matchAll(
    /((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=>\s*(?:\{\s*)?Self::Known\(KnownPlan::(\w+)\)/g,
  )) {
    for (const raw of [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])) {
      rawToVariant.set(raw, m[2]);
    }
  }
  const displayName = blockAfter(auth, 'pub fn display_name', 'display_name', '\n    }');
  const variantToName = new Map();
  for (const m of displayName.matchAll(/Self::(\w+)\s*=>\s*"([^"]*)"/g)) {
    variantToName.set(m[1], m[2]);
  }
  manifest.planDisplayNames = Object.fromEntries(
    [...rawToVariant.entries()].map(([raw, variant]) => [raw, variantToName.get(variant) ?? null]),
  );
  // KnownPlan currently has 14 variants with 15+ raw aliases; fewer means the
  // arm regex silently dropped block-formatted arms again.
  if (Object.keys(manifest.planDisplayNames).length < 14) {
    throw new Error(
      `suspiciously few plan display names extracted (${Object.keys(manifest.planDisplayNames).length}) — arm regex likely dropped entries`,
    );
  }

  const authModeEnumDecl = auth.indexOf('pub enum AuthMode');
  const authModeAttrs = auth.slice(Math.max(0, authModeEnumDecl - 300), authModeEnumDecl);
  const authModeRenameAll = authModeAttrs.match(/rename_all\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const authModeBlock = blockAfter(auth, 'pub enum AuthMode', 'auth mode enum');
  const modes = {};
  let pendingModeRename = null;
  for (const line of authModeBlock.split('\n')) {
    const rename = line.match(/rename\s*=\s*"([^"]+)"/);
    if (rename) {
      pendingModeRename = rename[1];
      continue;
    }
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (variant) {
      const v = variant[1];
      modes[v] = pendingModeRename ?? (authModeRenameAll === 'lowercase' ? v.toLowerCase() : v);
      pendingModeRename = null;
    }
  }
  manifest.authModes = modes;

  // --- JWT claim layout (login token_data) ---
  const tokenRel = 'codex-rs/login/src/token_data.rs';
  const token = read(src, tokenRel);
  track(tokenRel);
  const idClaims = blockAfter(token, 'struct IdClaims', 'IdClaims');
  manifest.jwtClaims = {
    topLevelEmail: /email:\s*Option<String>/.test(blockAfter(token, 'struct IdClaims', 'IdClaims')),
    namespaces: [...idClaims.matchAll(/rename\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
    authClaimKeys: serdeStructFields(blockAfter(token, 'struct AuthClaims', 'AuthClaims')).map((f) => f.name),
    profileClaimKeys: serdeStructFields(blockAfter(token, 'struct ProfileClaims', 'ProfileClaims')).map((f) => f.name),
    expClaim: serdeStructFields(blockAfter(token, 'struct StandardJwtClaims', 'StandardJwtClaims')).map((f) => f.name),
  };

  // --- Auth-file schema (login storage) ---
  const storageRel = 'codex-rs/login/src/auth/storage.rs';
  const storage = read(src, storageRel);
  track(storageRel);
  manifest.authFile = {
    fields: serdeStructFields(blockAfter(storage, 'pub struct AuthDotJson', 'AuthDotJson')).map((f) => ({
      name: f.name,
      optional: f.optional,
    })),
  };

  // --- Request headers (model-provider bearer provider) ---
  const bearerRel = 'codex-rs/model-provider/src/bearer_auth_provider.rs';
  const bearer = read(src, bearerRel);
  track(bearerRel);
  manifest.headers = {
    authorizationScheme: bearer.includes('format!("Bearer {token}")') ? 'Bearer' : null,
    accountIdHeader: bearer.match(/headers\.insert\("([^"]*Account[^"]*)",/)?.[1] ?? null,
    literals: [...bearer.matchAll(/headers\.insert\("([^"]+)",\s*HeaderValue::from_static\("([^"]+)"\)\)/g)].map((m) => ({ name: m[1], value: m[2] })),
  };

  // --- OAuth refresh (login manager) ---
  const managerRel = 'codex-rs/login/src/auth/manager.rs';
  const manager = read(src, managerRel);
  track(managerRel);
  const refreshUrl = manager.match(/REFRESH_TOKEN_URL:\s*&str\s*=\s*"([^"]+)"/)?.[1];
  const clientId = manager.match(/pub const CLIENT_ID:\s*&str\s*=\s*"([^"]+)"/)?.[1];
  const grantType = manager.match(/grant_type:\s*"([^"]+)"/)?.[1];
  const refreshReq = blockAfter(manager, 'struct RefreshRequest', 'RefreshRequest');
  const refreshResp = blockAfter(manager, 'struct RefreshResponse', 'RefreshResponse');
  manifest.refresh = {
    url: refreshUrl ?? null,
    clientId: clientId ?? null,
    grantType: grantType ?? null,
    requestFields: serdeStructFields(refreshReq).map((f) => f.name),
    responseFields: serdeStructFields(refreshResp).map((f) => f.name),
    failureCodes: [...manager.matchAll(/Some\("(refresh_token_\w+)"\)/g)].map((m) => m[1]),
  };
  if (!refreshUrl || !clientId || grantType !== 'refresh_token') {
    throw new Error('refresh contract extraction incomplete');
  }

  // --- PAT whoami (login personal_access_token) ---
  const patRel = 'codex-rs/login/src/auth/personal_access_token.rs';
  const pat = read(src, patRel);
  track(patRel);
  manifest.patWhoami = {
    baseUrl: pat.match(/PROD_AUTHAPI_BASE_URL:\s*&str\s*=\s*"([^"]+)"/)?.[1] ?? null,
    path: pat.match(/WHOAMI_PATH:\s*&str\s*=\s*"([^"]+)"/)?.[1] ?? null,
    metadataFields: serdeStructFields(blockAfter(pat, 'struct PersonalAccessTokenMetadata', 'PAT metadata')).map((f) => f.name),
  };

  return manifest;
}

export { extractManifest, DEFAULT_SRC, DEFAULT_OUT };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  const args = parseArgs(process.argv);
  try {
    const manifest = extractManifest(args.src);
    const out = path.resolve(args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`upstream manifest written to ${out} (${manifest.source.extractedFrom.length} source files)`);
  } catch (err) {
    console.error(`extract-upstream-manifest: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
