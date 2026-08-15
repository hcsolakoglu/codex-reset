/**
 * Idempotent-consume tests: the redeem_request_id is persisted before the
 * POST, reused when retrying an unresolved send, and cleared only on a
 * definitive outcome (mirrors upstream TUI idempotency-key semantics).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import {
  clearPendingRedemption,
  isAmbiguousConsumeFailure,
  isReusablePending,
  loadPendingRedemption,
  REUSE_WINDOW_MS,
  savePendingRedemption,
} from '../src/core/idempotency.ts';
import { ApiError } from '../src/utils/errors.ts';
import { e2eResetScenario } from './e2e-helpers.ts';

describe('pending redemption persistence', () => {
  it('round-trips save/load and clear removes the record', async () => {
    const home = `/tmp/codex-reset-pending-${process.pid}-${Date.now()}`;
    const pending = {
      redeemRequestId: 'r-1',
      accountId: 'acct-123',
      creditId: 'credit-1',
      savedAt: new Date().toISOString(),
    };
    await savePendingRedemption(home, pending);
    assert.deepEqual(await loadPendingRedemption(home, 'acct-123'), pending);

    await clearPendingRedemption(home, 'acct-123');
    assert.equal(await loadPendingRedemption(home, 'acct-123'), null);
    const encoded = Buffer.from('acct-123').toString('base64url');
    await assert.rejects(access(`${home}/pending-redeem.${encoded}.json`));
  });

  it('encodes filenames injectively so distinct account ids never collide', async () => {
    const { readdir, rm } = await import('node:fs/promises');
    const home = `/tmp/codex-reset-pending-${process.pid}-${Date.now()}`;
    await savePendingRedemption(home, {
      redeemRequestId: 'r-1',
      accountId: 'acct:1',
      creditId: null,
      savedAt: new Date().toISOString(),
    });
    await savePendingRedemption(home, {
      redeemRequestId: 'r-2',
      accountId: 'acct/1',
      creditId: null,
      savedAt: new Date().toISOString(),
    });
    try {
      const files = (await readdir(home)).filter((f) => f.startsWith('pending-redeem.'));
      assert.equal(files.length, 2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns null for a corrupted pending file', async () => {
    const home = `/tmp/codex-reset-pending-${process.pid}-${Date.now()}`;
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    await mkdir(home, { recursive: true });
    await writeFile(`${home}/pending-redeem.acct-123.json`, 'not json', 'utf-8');
    try {
      assert.equal(await loadPendingRedemption(home, 'acct-123'), null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reuses only fresh pending redemptions for the same account and credit', () => {
    const now = Date.now();
    const pending = {
      redeemRequestId: 'r-1',
      accountId: 'acct-123',
      creditId: 'credit-1',
      savedAt: new Date(now - 1000).toISOString(),
    };
    assert.equal(isReusablePending(pending, 'acct-123', 'credit-1', now), true);
    assert.equal(isReusablePending(pending, 'acct-999', 'credit-1', now), false);
    assert.equal(isReusablePending(pending, 'acct-123', 'credit-2', now), false);
    assert.equal(isReusablePending(pending, 'acct-123', null, now), false);

    const stale = { ...pending, savedAt: new Date(now - REUSE_WINDOW_MS - 1).toISOString() };
    assert.equal(isReusablePending(stale, 'acct-123', 'credit-1', now), false);
  });

  it('classifies only unresolved-outcome failures as ambiguous', () => {
    assert.equal(isAmbiguousConsumeFailure(new ApiError('Request timed out', 0)), true);
    assert.equal(isAmbiguousConsumeFailure(new ApiError('unknown result code', 200)), true);
    assert.equal(isAmbiguousConsumeFailure(new ApiError('backend', 500)), true);
    assert.equal(isAmbiguousConsumeFailure(new ApiError('bad request', 400)), false);
    assert.equal(isAmbiguousConsumeFailure(new ApiError('unauthorized', 401)), false);
    assert.equal(isAmbiguousConsumeFailure(new ApiError('conflict', 409)), false);
    assert.equal(isAmbiguousConsumeFailure(new ApiError('rate limited', 429)), false);
    assert.equal(isAmbiguousConsumeFailure(new Error('not an ApiError')), false);
  });
});

describe('idempotent retry across CLI invocations', () => {
  it('reuses the same redeem_request_id after a timeout and clears it on success', async () => {
    const { consumeBodies, pendingCleared } = await e2eResetScenario();
    assert.equal(consumeBodies.length, 2);
    const first = JSON.parse(consumeBodies[0]!) as { redeem_request_id: string };
    const second = JSON.parse(consumeBodies[1]!) as { redeem_request_id: string };
    assert.equal(second.redeem_request_id, first.redeem_request_id);
    assert.equal(pendingCleared, true);
  });
});
