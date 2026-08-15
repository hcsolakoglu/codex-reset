/**
 * Auth flows beyond file parsing: PAT metadata hydration and OAuth token
 * refresh. Mirrors upstream codex-rs:
 *   - login/src/auth/personal_access_token.rs  (whoami hydration)
 *   - login/src/auth/manager.rs                (refresh token grant)
 * including the same endpoints, client id, and environment overrides.
 * @module core/auth
 */

import { getHttpTransport } from './http.js';
import { decodeJwtPayload } from './accounts.js';

const DEFAULT_WHOAMI_URL = 'https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami';
const DEFAULT_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_API_BASE_ENV = 'CODEX_AUTHAPI_BASE_URL';
const REFRESH_URL_ENV = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
const CLIENT_ID_ENV = 'CODEX_APP_SERVER_LOGIN_CLIENT_ID';
const REQUEST_TIMEOUT_MS = 15_000;

/** Metadata returned by the PAT whoami endpoint. */
export interface PatMetadata {
  email: string | null;
  chatgpt_user_id: string | null;
  chatgpt_account_id: string;
  chatgpt_plan_type: string | null;
  chatgpt_account_is_fedramp: boolean;
}

function whoamiUrl(): URL {
  const base = process.env[AUTH_API_BASE_ENV];
  const raw = base && base.trim().length > 0 ? `${base.trim().replace(/\/+$/, '')}/v1/user-auth-credential/whoami` : DEFAULT_WHOAMI_URL;
  return new URL(raw);
}

/** Hydrate a personal access token into account metadata (upstream whoami flow). */
export async function fetchPatMetadata(accessToken: string): Promise<PatMetadata> {
  const transport = getHttpTransport();
  const url = whoamiUrl();
  const res = await transport({
    method: 'GET',
    protocol: url.protocol === 'http:' ? 'http:' : 'https:',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'codex-reset/0.2.1',
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Personal access token metadata request failed with status ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    throw new Error('Personal access token metadata response was not valid JSON');
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (!record || typeof record.chatgpt_account_id !== 'string') {
    throw new Error('Personal access token metadata response was missing chatgpt_account_id');
  }
  return {
    email: typeof record.email === 'string' ? record.email : null,
    chatgpt_user_id: typeof record.chatgpt_user_id === 'string' ? record.chatgpt_user_id : null,
    chatgpt_account_id: record.chatgpt_account_id,
    chatgpt_plan_type: typeof record.chatgpt_plan_type === 'string' ? record.chatgpt_plan_type : null,
    chatgpt_account_is_fedramp: record.chatgpt_account_is_fedramp === true,
  };
}

/** Tokens returned by a refresh grant; absent fields are not rotated. */
export interface RefreshedTokens {
  id_token?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
}

function classifyRefreshFailure(status: number, bodyText: string): string {
  let code: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const err = parsed['error'];
    if (typeof err === 'string') code = err;
    else if (typeof err === 'object' && err !== null) {
      const errCode = (err as Record<string, unknown>)['code'];
      if (typeof errCode === 'string') code = errCode;
    }
    if (code === null && typeof parsed['code'] === 'string') code = parsed['code'];
  } catch {
    // non-JSON error body
  }
  switch (code) {
    case 'refresh_token_expired':
      return 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';
    case 'refresh_token_reused':
      return 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    case 'refresh_token_invalidated':
      return 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';
    default:
      return status === 401
        ? 'Your access token could not be refreshed. Please log out and sign in again.'
        : `Token refresh failed with status ${status}`;
  }
}

/** Exchange a refresh token for fresh OAuth tokens (upstream refresh grant). */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  const transport = getHttpTransport();
  const url = new URL(process.env[REFRESH_URL_ENV] || DEFAULT_REFRESH_URL);
  const clientId = process.env[CLIENT_ID_ENV]?.trim() || DEFAULT_OAUTH_CLIENT_ID;

  const res = await transport({
    method: 'POST',
    protocol: url.protocol === 'http:' ? 'http:' : 'https:',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'codex-reset/0.2.1',
    },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(classifyRefreshFailure(res.status, res.bodyText));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    throw new Error('Token refresh response was not valid JSON');
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return {
    id_token: typeof record.id_token === 'string' ? record.id_token : null,
    access_token: typeof record.access_token === 'string' ? record.access_token : null,
    refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : null,
  };
}

/**
 * Whether a JWT access token's `exp` claim is in the past.
 * Returns false when the token is not a decodable JWT or has no exp —
 * callers then rely on reactive 401 handling instead of proactive refresh.
 */
export function accessTokenIsExpired(accessToken: string, nowMs = Date.now()): boolean {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  return exp * 1000 <= nowMs;
}
