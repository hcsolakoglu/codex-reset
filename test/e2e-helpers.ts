/**
 * Shared command-level (end-to-end) harness: runs real command functions
 * against a fixture CODEX_HOME and an injected fake transport.
 * Not a test file — imported by e2e-weekly.test.ts and idempotency.test.ts.
 * @module test/e2e-helpers
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setHttpTransport, TransportError } from '../src/core/http.ts';
import type { TransportResponse } from '../src/core/http.ts';
import { resetCommand } from '../src/commands/reset.ts';
import {
  captureOutput,
  fakeTransport,
  jsonResponse,
  oauthAuthFile,
  withTempCodexHome,
} from './helpers.ts';

/** The live weekly shape: weekly primary, absent secondary. */
export const WEEKLY_USAGE = {
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: 1_755_000_000 },
    secondary_window: null,
  },
  rate_limit_reset_credits: { available_count: 2 },
};

export const CREDITS_OK = {
  credits: [
    {
      id: 'credit-1',
      reset_type: 'global',
      status: 'available',
      granted_at: '2026-08-01T00:00:00Z',
      expires_at: '2027-01-01T00:00:00Z',
    },
  ],
  available_count: 1,
};

export function fixtureHome(): Record<string, string> {
  return {
    'accounts/acct.auth.json': JSON.stringify(oauthAuthFile({ plan: 'plus' }), null, 2),
    'accounts/registry.json': JSON.stringify({
      accounts: [
        {
          account_key: 'user-456::acct-123',
          chatgpt_account_id: 'acct-123',
          chatgpt_user_id: 'user-456',
          email: 'test@example.com',
          alias: 'work',
          account_name: null,
          plan: null,
        },
      ],
    }),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full two-run redemption: the first consume times out (ambiguous outcome),
 * the second succeeds. Returns every consume body sent plus whether the
 * pending-redemption record was cleared after success.
 */
export async function e2eResetScenario(): Promise<{
  consumeBodies: string[];
  pendingCleared: boolean;
  firstError: unknown;
  secondStdout: string;
}> {
  let consumeAttempts = 0;
  const consumeBodies: string[] = [];
  const { transport } = fakeTransport((req): TransportResponse => {
    if (req.path.endsWith('/rate-limit-reset-credits/consume')) {
      consumeBodies.push(req.body ?? '');
      consumeAttempts += 1;
      if (consumeAttempts === 1) throw new TransportError('Request timed out');
      return jsonResponse(200, { code: 'reset', windows_reset: 1 });
    }
    if (req.path.endsWith('/rate-limit-reset-credits')) return jsonResponse(200, CREDITS_OK);
    return jsonResponse(200, WEEKLY_USAGE);
  });

  let firstError: unknown = null;
  let secondStdout = '';
  let pendingCleared = false;

  await withTempCodexHome(fixtureHome(), async (codexHome) => {
    setHttpTransport(transport);
    try {
      await resetCommand({ json: true, yes: true, all: false, query: 'test@example.com' });
    } catch (err) {
      firstError = err;
    }
    // The timed-out send must leave a pending record for the retry to reuse.
    const pendingPath = join(codexHome, `pending-redeem.${Buffer.from('acct-123').toString('base64url')}.json`);
    const pendingAfterTimeout = await readFile(pendingPath, 'utf-8');
    const parsed = JSON.parse(pendingAfterTimeout) as { redeemRequestId?: string };
    if (typeof parsed.redeemRequestId !== 'string' || consumeBodies.length < 1) {
      throw new Error('pending redemption record missing after ambiguous send');
    }

    const { stdout } = await captureOutput(() =>
      resetCommand({ json: true, yes: true, all: false, query: 'test@example.com' }),
    );
    secondStdout = stdout;
    pendingCleared = !(await fileExists(pendingPath));
  }).finally(() => setHttpTransport(null));

  return { consumeBodies, pendingCleared, firstError, secondStdout };
}
