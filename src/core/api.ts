/**
 * ChatGPT backend API client — reads usage, lists credits, consumes credits.
 * Uses Node.js built-in https module. Zero dependencies.
 * @module core/api
 */

import https from 'node:https';
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

const BASE_HOST = 'chatgpt.com';
const BASE_PATH = '/backend-api/wham';
const USER_AGENT = 'codex-reset/0.2.1';
const TIMEOUT_MS = 15_000;

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  account: Account;
  body?: string;
}

/** Make a single HTTPS request to the ChatGPT backend. */
function request(opts: RequestOptions): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.account.authFile.tokens.access_token}`,
      'ChatGPT-Account-Id': opts.account.accountId,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };

    if (opts.body) {
      headers['Content-Type'] = 'application/json';
    }

    const req = https.request(
      {
        hostname: BASE_HOST,
        path: opts.path,
        method: opts.method,
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          try {
            resolve({ status, data: JSON.parse(data) });
          } catch {
            resolve({ status, data });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err: Error) => {
      reject(new ApiError(err.message, 0, 'Check your network connection and try again.'));
    });

    if (opts.body) req.write(opts.body);
    req.end();
  });
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

/** Fetch current usage state for an account. */
export async function getUsage(account: Account): Promise<UsageResponse> {
  const { status, data } = await request({
    method: 'GET',
    path: `${BASE_PATH}/usage`,
    account,
  });

  if (status === 401) {
    throw new ApiError(
      `Unauthorized for ${account.email}`,
      401,
      'Token may be expired. Run `codex-auth login` to refresh, then retry.',
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
  const { status, data } = await request({
    method: 'GET',
    path: `${BASE_PATH}/rate-limit-reset-credits`,
    account,
  });

  if (status === 401) {
    throw new ApiError(
      `Unauthorized for ${account.email}`,
      401,
      'Token may be expired. Run `codex-auth login` to refresh, then retry.',
    );
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
  const { status, data } = await request({
    method: 'POST',
    path: `${BASE_PATH}/rate-limit-reset-credits/consume`,
    account,
    body: createConsumeRequestBody(redeemRequestId, creditId),
  });

  if (status === 401) {
    throw new ApiError(
      `Unauthorized for ${account.email}`,
      401,
      'Token may be expired. Run `codex-auth login` to refresh, then retry.',
    );
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
