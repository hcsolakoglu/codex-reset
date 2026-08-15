/**
 * ChatGPT backend API client — reads usage, lists credits, consumes credits.
 * Talks through the injectable transport in core/http (zero dependencies).
 * @module core/api
 */

import { randomUUID } from 'node:crypto';
import type {
  Account,
  AccountUsage,
  ConsumeResponse,
  CreditsResponse,
  ResetCredit,
  UsageResponse,
  UsageWindow,
} from './types.js';
import { ApiError } from '../utils/errors.js';
import { getHttpTransport, TransportError } from './http.js';
import { accessTokenIsExpired, refreshAccessToken } from './auth.js';

// Upstream builds these as {base}/wham/... with base = chatgpt.com/backend-api
// (PathStyle::ChatGptApi); endpoint paths below mirror that split exactly.
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const BASE_URL_ENV = 'CODEX_RESET_BASE_URL';
const USER_AGENT = 'codex-reset/0.2.1';
const TIMEOUT_MS = 15_000;
const REFRESH_LOGIN_HINT =
  'Token may be expired and could not be refreshed automatically. Run `codex login` or `codex-auth login`, then retry.';

/** Resolve the backend base URL (override for tests via CODEX_RESET_BASE_URL). */
export function resolveBaseUrl(): URL {
  const raw = process.env[BASE_URL_ENV];
  return new URL(raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_BASE_URL);
}

/** Bearer credential: personal access token when present, else the OAuth access token. */
export function bearerToken(account: Account): string {
  return account.authFile.personal_access_token || account.authFile.tokens?.access_token || '';
}

/** Exact request headers for an API call (upstream BearerAuthProvider contract). */
export function buildRequestHeaders(account: Account, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken(account)}`,
    'ChatGPT-Account-Id': account.accountId,
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  if (account.isFedramp) {
    headers['X-OpenAI-Fedramp'] = 'true';
  }
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  account: Account;
  body?: string;
}

/** Make a single request to the ChatGPT backend through the active transport. */
async function request(opts: RequestOptions): Promise<{
  status: number;
  headers: Record<string, string>;
  data: unknown;
}> {
  const base = resolveBaseUrl();
  const transport = getHttpTransport();
  let res;
  try {
    res = await transport({
      method: opts.method,
      protocol: base.protocol === 'http:' ? 'http:' : 'https:',
      hostname: base.hostname,
      port: base.port ? Number(base.port) : undefined,
      path: `${base.pathname.replace(/\/+$/, '')}${opts.path}`,
      headers: buildRequestHeaders(opts.account, opts.body !== undefined),
      body: opts.body,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      throw new ApiError(err.message, 0, 'Check your network connection and try again.');
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(res.bodyText);
  } catch {
    data = res.bodyText;
  }
  return { status: res.status, headers: res.headers, data };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWindow(window: UsageWindow | null | undefined): {
  percent: number | null;
  windowSeconds: number | null;
  resetAt: number | null;
} {
  return {
    percent: finiteNumber(window?.used_percent),
    windowSeconds: finiteNumber(window?.limit_window_seconds),
    resetAt: finiteNumber(window?.reset_at),
  };
}

/** Convert the live backend response into a null-safe display snapshot. */
export function normalizeUsage(account: Account, usage: UsageResponse): AccountUsage {
  const primary = normalizeWindow(usage.rate_limit?.primary_window);
  const secondary = normalizeWindow(usage.rate_limit?.secondary_window);
  const availableCount = finiteNumber(usage.rate_limit_reset_credits?.available_count);
  const reachedType = usage.rate_limit_reached_type?.type;

  return {
    account,
    primaryPercent: primary.percent,
    secondaryPercent: secondary.percent,
    primaryWindowSeconds: primary.windowSeconds,
    secondaryWindowSeconds: secondary.windowSeconds,
    primaryResetAt: primary.resetAt,
    secondaryResetAt: secondary.resetAt,
    availableCredits: availableCount === null ? 0 : Math.max(0, Math.floor(availableCount)),
    rateLimitReachedType: typeof reachedType === 'string' ? reachedType : null,
    fetchedAt: Date.now(),
  };
}

function normalizeCredit(value: unknown): ResetCredit {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.reset_type !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.granted_at !== 'string'
  ) {
    throw new ApiError('Credits API returned an invalid credit record', 200);
  }

  return {
    id: record.id,
    reset_type: record.reset_type,
    status: record.status,
    granted_at: record.granted_at,
    expires_at: typeof record.expires_at === 'string' ? record.expires_at : null,
    redeemed_at: typeof record.redeemed_at === 'string' ? record.redeemed_at : null,
    profile_image_url:
      typeof record.profile_image_url === 'string' ? record.profile_image_url : null,
    profile_user_id: typeof record.profile_user_id === 'string' ? record.profile_user_id : null,
    title: typeof record.title === 'string' ? record.title : null,
    description: typeof record.description === 'string' ? record.description : null,
  };
}

function normalizeCredits(data: unknown): CreditsResponse {
  const record = asRecord(data);
  if (!record || !Array.isArray(record.credits)) {
    throw new ApiError('Credits API returned an invalid response', 200);
  }

  const availableCount = finiteNumber(record.available_count);
  return {
    credits: record.credits.map(normalizeCredit),
    ...(availableCount === null
      ? {}
      : { available_count: Math.max(0, Math.floor(availableCount)) }),
  };
}

/** Generate the exact consume request payload. Exported for regression tests. */
export function createConsumeRequestBody(redeemRequestId: string, creditId?: string): string {
  const body: { redeem_request_id: string; credit_id?: string } = {
    redeem_request_id: redeemRequestId,
  };
  if (creditId) body.credit_id = creditId;
  return JSON.stringify(body);
}

/** Format a Retry-After header value (delta seconds or HTTP-date) for display. */
export function describeRetryAfter(value: string | undefined): string | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return `Retry after ${Math.ceil(seconds)} seconds.`;
  }
  const at = Date.parse(value);
  if (!Number.isNaN(at)) {
    return `Retry after ${new Date(at).toISOString()}.`;
  }
  return null;
}

function unauthorizedError(account: Account, refreshError?: Error): ApiError {
  // When a refresh was attempted and failed, its classified message (upstream
  // parity: expired / reused / revoked) is the actionable hint.
  return new ApiError(
    `Unauthorized for ${account.email}`,
    401,
    refreshError?.message ?? REFRESH_LOGIN_HINT,
  );
}

/**
 * Run a request with upstream-style token refresh: proactively refresh an
 * expired access token, then retry once after a reactive 401. Refreshed
 * tokens (including rotation) are persisted back to the account's auth file.
 * A failed refresh is returned as `refreshError` rather than thrown.
 */
async function requestWithRefresh(opts: RequestOptions): Promise<{
  status: number;
  headers: Record<string, string>;
  data: unknown;
  refreshError?: Error;
}> {
  const account = opts.account;
  const tokens = account.authFile.tokens;

  let refreshError: Error | undefined;
  if (tokens?.refresh_token && accessTokenIsExpired(bearerToken(account))) {
    refreshError = (await tryRefreshTokens(account)) ?? undefined;
  }

  const first = await request(opts);
  if (first.status !== 401 || !tokens?.refresh_token) {
    return { ...first, refreshError };
  }

  const failure = await tryRefreshTokens(account);
  if (failure) return { ...first, refreshError: failure };
  return request(opts);
}

/** Best-effort refresh; mutates the account's tokens and persists them. Returns the failure, or null on success. */
async function tryRefreshTokens(account: Account): Promise<Error | null> {
  const refreshToken = account.authFile.tokens?.refresh_token;
  if (!refreshToken) return new Error('No refresh token available.');
  try {
    const refreshed = await refreshAccessToken(refreshToken);
    const tokens = account.authFile.tokens;
    if (!tokens) return new Error('Stored auth has no token block.');
    if (refreshed.id_token) tokens.id_token = refreshed.id_token;
    if (refreshed.access_token) tokens.access_token = refreshed.access_token;
    // Rotation: the old refresh token stays valid when no new one is returned.
    if (refreshed.refresh_token) tokens.refresh_token = refreshed.refresh_token;
    account.authFile.last_refresh = new Date().toISOString();
    await persistAuthFile(account);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Write an account's (possibly refreshed) auth file back to disk atomically. */
async function persistAuthFile(account: Account): Promise<void> {
  if (!account.filepath) return;
  try {
    const { rename, writeFile } = await import('node:fs/promises');
    // temp + rename so a crash mid-write can never leave a truncated auth file.
    const temp = `${account.filepath}.codex-reset-tmp`;
    await writeFile(temp, JSON.stringify(account.authFile, null, 2) + '\n', 'utf-8');
    await rename(temp, account.filepath);
  } catch {
    // Persisting refreshed tokens is best-effort; the in-process token still works.
  }
}

/** Fetch current usage state for an account. */
export async function getUsage(account: Account): Promise<UsageResponse> {
  const { status, headers, data, refreshError } = await requestWithRefresh({
    method: 'GET',
    path: '/wham/usage',
    account,
  });

  if (status === 401) {
    throw unauthorizedError(account, refreshError);
  }
  if (status === 403) {
    throw new ApiError(
      `Usage API returned HTTP 403 for ${account.email}`,
      403,
      account.isFedramp
        ? 'The request was sent with FedRAMP routing. The account may not have access to this feature or workspace.'
        : 'The account may not have access to this feature or workspace.',
    );
  }
  if (status === 429) {
    const retry = describeRetryAfter(headers['retry-after']);
    throw new ApiError(`Usage API rate limited (HTTP 429)`, 429, retry ?? 'Try again later.');
  }
  if (status >= 500) {
    throw new ApiError(
      `Usage API returned HTTP ${status}`,
      status,
      'The ChatGPT backend is having issues. Try again shortly.',
    );
  }
  if (status !== 200) {
    throw new ApiError(`Usage API returned HTTP ${status}`, status);
  }
  if (!asRecord(data)) {
    throw new ApiError('Usage API returned an invalid response', status);
  }
  return data as UsageResponse;
}

/** Fetch all reset credits (available + redeemed) for an account. */
export async function getCredits(account: Account): Promise<CreditsResponse> {
  const { status, data, refreshError } = await requestWithRefresh({
    method: 'GET',
    path: '/wham/rate-limit-reset-credits',
    account,
  });

  if (status === 401) {
    throw unauthorizedError(account, refreshError);
  }
  if (status !== 200) {
    throw new ApiError(`Credits API returned HTTP ${status}`, status);
  }
  return normalizeCredits(data);
}

function normalizeConsumeCode(value: unknown): ConsumeResponse['code'] {
  switch (value) {
    case 'reset':
      return 'reset';
    case 'nothingToReset':
    case 'nothing_to_reset':
      return 'nothingToReset';
    case 'noCredit':
    case 'no_credit':
      return 'noCredit';
    case 'alreadyRedeemed':
    case 'already_redeemed':
      return 'alreadyRedeemed';
    default:
      throw new ApiError('Consume API returned an unknown result code', 200);
  }
}

export function normalizeConsumeResponse(data: unknown): ConsumeResponse {
  const record = asRecord(data);
  if (!record) throw new ApiError('Consume API returned an invalid response', 200);
  const windowsReset = finiteNumber(record.windows_reset);
  return {
    code: normalizeConsumeCode(record.code),
    windows_reset: windowsReset === null ? 0 : Math.max(0, Math.floor(windowsReset)),
  };
}

/** Consume a reset credit — resets eligible rate-limit windows. */
export async function consumeCredit(
  account: Account,
  redeemRequestId: string,
  creditId?: string,
): Promise<ConsumeResponse> {
  const { status, data, refreshError } = await requestWithRefresh({
    method: 'POST',
    path: '/wham/rate-limit-reset-credits/consume',
    account,
    body: createConsumeRequestBody(redeemRequestId, creditId),
  });

  if (status === 401) {
    throw unauthorizedError(account, refreshError);
  }
  if (status < 200 || status >= 300) {
    const errData = asRecord(data);
    const nestedError = asRecord(errData?.error);
    throw new ApiError(
      `Consume API returned HTTP ${status}: ${typeof nestedError?.message === 'string' ? nestedError.message : 'unknown error'}`,
      status,
    );
  }
  return normalizeConsumeResponse(data);
}

/** Generate a random UUID v4 using Node.js built-in crypto. */
export function generateRequestId(): string {
  return randomUUID();
}
