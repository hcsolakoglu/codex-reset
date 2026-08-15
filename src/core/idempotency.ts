/**
 * Idempotent consume support.
 *
 * A credit consume is a destructive POST: if the request times out or the
 * response is lost, retrying with a *new* idempotency key can spend a second
 * credit. Upstream's TUI avoids this by reusing one idempotency key for the
 * whole redemption flow (tui/src/chatwidget/usage.rs). This module persists
 * the key before the send and keeps it until the outcome is resolved, so a
 * retry of an ambiguous send — including across CLI invocations — reuses it.
 *
 * @module core/idempotency
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../utils/errors.js';

/** A consume that was sent but whose outcome is (or may be) unresolved. */
export interface PendingRedemption {
  redeemRequestId: string;
  accountId: string;
  creditId: string | null;
  savedAt: string;
}

/** How long an unresolved send may be retried with the same key. */
export const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

function pendingFile(codexHome: string, accountId: string): string {
  // base64url is injective and filesystem-safe: distinct account ids can
  // never collide onto the same pending file.
  const safe = Buffer.from(accountId, 'utf-8').toString('base64url');
  return join(codexHome, `pending-redeem.${safe}.json`);
}

/** Load the persisted pending redemption for an account, if any. */
export async function loadPendingRedemption(
  codexHome: string,
  accountId: string,
): Promise<PendingRedemption | null> {
  try {
    const content = await readFile(pendingFile(codexHome, accountId), 'utf-8');
    const parsed = JSON.parse(content) as Partial<PendingRedemption>;
    if (
      typeof parsed.redeemRequestId !== 'string' ||
      typeof parsed.accountId !== 'string' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    return { ...parsed, creditId: typeof parsed.creditId === 'string' ? parsed.creditId : null } as PendingRedemption;
  } catch {
    return null;
  }
}

/** Persist a pending redemption before the consume request is sent. */
export async function savePendingRedemption(
  codexHome: string,
  pending: PendingRedemption,
): Promise<void> {
  const target = pendingFile(codexHome, pending.accountId);
  await mkdir(join(codexHome), { recursive: true });
  await writeFile(target, JSON.stringify(pending, null, 2) + '\n', 'utf-8');
}

/** Remove the pending record once the outcome is resolved. */
export async function clearPendingRedemption(codexHome: string, accountId: string): Promise<void> {
  await rm(pendingFile(codexHome, accountId), { force: true });
}

/**
 * Whether a persisted pending redemption may be retried with the same key:
 * it must target the same account + credit and still be inside the reuse window.
 */
export function isReusablePending(
  pending: PendingRedemption,
  accountId: string,
  creditId: string | null,
  nowMs = Date.now(),
): boolean {
  if (pending.accountId !== accountId) return false;
  if (pending.creditId !== creditId) return false;
  const savedAt = Date.parse(pending.savedAt);
  if (Number.isNaN(savedAt)) return false;
  return nowMs - savedAt <= REUSE_WINDOW_MS;
}

/**
 * Whether a consume failure leaves the outcome ambiguous (the server may or
 * may not have spent the credit). Ambiguous failures keep the idempotency key
 * so a retry cannot double-spend:
 *   - status 0: no HTTP response (timeout, connection reset, DNS)
 *   - status 200 with an error: 2xx body that failed to parse — consumed but unreadable
 *   - status >= 500: server-side failure after an unknown amount of processing
 * Definitive 4xx answers mean the server did not accept the redemption.
 */
export function isAmbiguousConsumeFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.statusCode === 0 || err.statusCode === 200 || err.statusCode >= 500;
}
