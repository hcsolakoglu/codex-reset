/**
 * Command-level end-to-end tests against the live weekly shape:
 * weekly (604800s) primary window with an absent secondary. Commands run
 * for real against a fixture CODEX_HOME; HTTP is a routed fake transport.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setHttpTransport } from '../src/core/http.ts';
import type { TransportResponse } from '../src/core/http.ts';
import { listCommand } from '../src/commands/list.ts';
import { resetCommand } from '../src/commands/reset.ts';
import {
  captureOutput,
  fakeTransport,
  jsonResponse,
  withTempCodexHome,
} from './helpers.ts';
import { CREDITS_OK, WEEKLY_USAGE, fixtureHome } from './e2e-helpers.ts';

afterEach(() => {
  setHttpTransport(null);
});

describe('list command — weekly primary, absent secondary', () => {
  it('renders text output with weekly labels and an unavailable secondary', async () => {
    const { transport } = fakeTransport((): TransportResponse => jsonResponse(200, WEEKLY_USAGE));
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => listCommand({ json: false })),
    );

    assert.match(stdout, /1\s+work\s+<test@example\.com>/);
    assert.match(stdout, /Weekly limit:\s+\[+\u2588*.*58% left/);
    assert.match(stdout, /Secondary limit:\s+unavailable/);
    assert.match(stdout, /Lowest left: Weekly 58%, Secondary n\/a/);
    assert.match(stdout, /2 reset credits/);
  });

  it('emits machine-readable JSON with the weekly window shape', async () => {
    const { transport } = fakeTransport((): TransportResponse => jsonResponse(200, WEEKLY_USAGE));
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => listCommand({ json: true })),
    );

    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 1);
    const entry = parsed[0]!;
    assert.equal(entry['alias'], 'work');
    const usage = entry['usage'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(usage['primary'], {
      percentUsed: 42,
      percentLeft: 58,
      windowSeconds: 604800,
      resetsAt: 1_755_000_000,
    });
    assert.deepEqual(usage['secondary'], {
      percentUsed: null,
      percentLeft: null,
      windowSeconds: null,
      resetsAt: null,
    });
    assert.deepEqual(entry['credits'], { available: 2 });
  });
});

describe('reset command — weekly shape', () => {
  function resetTransport(): { transport: ReturnType<typeof fakeTransport>['transport'] } {
    let consumed = false;
    const { transport } = fakeTransport((req): TransportResponse => {
      if (req.path.endsWith('/rate-limit-reset-credits/consume')) {
        consumed = true;
        return jsonResponse(200, { code: 'reset', windows_reset: 1 });
      }
      if (req.path.endsWith('/rate-limit-reset-credits')) return jsonResponse(200, CREDITS_OK);
      // After the reset the window clears and one credit is spent.
      if (consumed) {
        return jsonResponse(200, {
          rate_limit: {
            primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1_755_000_000 },
            secondary_window: null,
          },
          rate_limit_reset_credits: { available_count: 1 },
        });
      }
      return jsonResponse(200, WEEKLY_USAGE);
    });
    return { transport };
  }

  it('refuses JSON mode without --yes before any network work', async () => {
    const { transport, requests } = fakeTransport((): TransportResponse => jsonResponse(200, WEEKLY_USAGE));
    setHttpTransport(transport);
    await withTempCodexHome(fixtureHome(), async () => {
      await assert.rejects(
        resetCommand({ json: true, yes: false, all: false, query: 'test@example.com' }),
        /Refusing to redeem/,
      );
    });
    assert.equal(requests.length, 0);
  });

  it('redemption with --json --yes reports before/after around the consume', async () => {
    const { transport } = resetTransport();
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => resetCommand({ json: true, yes: true, all: false, query: 'test@example.com' })),
    );

    const result = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(result['outcome'], 'reset');
    assert.equal(result['windowsReset'], 1);
    assert.equal(result['account'], 'test@example.com');
    assert.equal(result['creditId'], 'credit-1');
    assert.deepEqual(result['before'], { primary: 42, secondary: null, credits: 2 });
    assert.deepEqual(result['after'], { primary: 0, secondary: null, credits: 1 });
  });

  it('text mode shows before → after bars and the credit delta', async () => {
    const { transport } = resetTransport();
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => resetCommand({ json: false, yes: true, all: false, query: 'test@example.com' })),
    );

    assert.match(stdout, /Reset successful for work/);
    assert.match(stdout, /Windows reset: 1/);
    assert.match(stdout, /Weekly limit:.*→/);
    assert.match(stdout, /Credits:\s+2 → 1 left/);
  });

  it('refuses to reset when both usage windows are absent', async () => {
    const { transport } = fakeTransport(
      (): TransportResponse => jsonResponse(200, { rate_limit: null }),
    );
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => resetCommand({ json: true, yes: true, all: false, query: 'test@example.com' })),
    );
    assert.deepEqual(JSON.parse(stdout), { outcome: 'usageUnavailable', account: 'test@example.com' });
  });

  it('--all reports noEligibleAccounts when nothing needs a reset', async () => {
    const { transport } = fakeTransport((): TransportResponse => jsonResponse(200, WEEKLY_USAGE));
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => resetCommand({ json: true, yes: true, all: true })),
    );
    assert.deepEqual(JSON.parse(stdout), { outcome: 'noEligibleAccounts' });
  });

  it('--all resets accounts above the eligibility threshold', async () => {
    const hot = {
      ...WEEKLY_USAGE,
      rate_limit: {
        ...WEEKLY_USAGE.rate_limit!,
        primary_window: { used_percent: 95, limit_window_seconds: 604800, reset_at: 1_755_000_000 },
      },
    };
    let consumed = false;
    const { transport } = fakeTransport((req): TransportResponse => {
      if (req.path.endsWith('/rate-limit-reset-credits/consume')) {
        consumed = true;
        return jsonResponse(200, { code: 'reset', windows_reset: 1 });
      }
      if (req.path.endsWith('/rate-limit-reset-credits')) return jsonResponse(200, CREDITS_OK);
      return jsonResponse(200, consumed ? WEEKLY_USAGE : hot);
    });
    setHttpTransport(transport);
    const { stdout } = await withTempCodexHome(fixtureHome(), () =>
      captureOutput(() => resetCommand({ json: true, yes: true, all: true })),
    );
    const parsed = JSON.parse(stdout) as { results: Array<{ outcome: string }> };
    assert.equal(parsed.results[0]?.outcome, 'reset');
  });
});
