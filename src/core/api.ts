/**
 * ChatGPT backend API client — reads usage, lists credits, consumes credits.
 * Uses Node.js built-in https module. Zero dependencies.
 * @module core/api
 */

import https from 'node:https';
import type { Account, ConsumeResponse, CreditsResponse, UsageResponse } from './types.js';
import { ApiError } from '../utils/errors.js';

const BASE_HOST = 'chatgpt.com';
const BASE_PATH = '/backend-api/wham';
const USER_AGENT = 'codex-reset/0.1.0';
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
  return data as CreditsResponse;
}

/** Consume a reset credit — resets eligible rate-limit windows. */
export async function consumeCredit(
  account: Account,
  redeemRequestId: string,
): Promise<ConsumeResponse> {
  const { status, data } = await request({
    method: 'POST',
    path: `${BASE_PATH}/rate-limit-reset-credits/consume`,
    account,
    body: JSON.stringify({ redeem_request_id: redeemRequestId }),
  });

  if (status === 401) {
    throw new ApiError(
      `Unauthorized for ${account.email}`,
      401,
      'Token may be expired. Run `codex-auth login` to refresh, then retry.',
    );
  }
  if (status !== 200) {
    const errData = data as { error?: { message?: string } };
    throw new ApiError(
      `Consume API returned HTTP ${status}: ${errData?.error?.message ?? 'unknown error'}`,
      status,
    );
  }
  return data as ConsumeResponse;
}

/** Generate a random UUID v4 using Node.js built-in crypto. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
