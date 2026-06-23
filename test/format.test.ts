import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBar,
  formatDate,
  formatCountdown,
  formatDuration,
  formatLimitLine,
  formatResetTime,
  percentLeft,
  planDisplayName,
  truncate,
  pad,
  planBadge,
} from '../src/utils/format.ts';

describe('percentLeft', () => {
  it('inverts backend used_percent', () => {
    assert.strictEqual(percentLeft(0), 100);
    assert.strictEqual(percentLeft(100), 0);
    assert.strictEqual(percentLeft(55), 45);
  });

  it('clamps invalid percentages', () => {
    assert.strictEqual(percentLeft(150), 0);
    assert.strictEqual(percentLeft(-10), 100);
  });
});

describe('formatBar', () => {
  it('renders 100% left for 0% used', () => {
    const bar = formatBar(0, 10);
    assert.ok(bar.includes('[██████████]'));
    assert.ok(bar.includes('100% left'));
  });

  it('renders 0% left for 100% used', () => {
    const bar = formatBar(100, 10);
    assert.ok(bar.includes('[░░░░░░░░░░]'));
    assert.ok(bar.includes('0% left'));
  });

  it('clamps above 100 used', () => {
    const bar = formatBar(150, 10);
    assert.ok(bar.includes('0% left'));
  });

  it('clamps below 0 used', () => {
    const bar = formatBar(-10, 10);
    assert.ok(bar.includes('100% left'));
  });

  it('renders 50% left with correct fill', () => {
    const bar = formatBar(50, 10);
    assert.ok(bar.includes('[█████░░░░░]'));
    assert.ok(bar.includes('50% left'));
  });
});

describe('formatResetTime', () => {
  it('formats same-day reset as time only', () => {
    const now = new Date(2026, 5, 22, 9, 0);
    const reset = new Date(2026, 5, 22, 10, 12);
    assert.strictEqual(formatResetTime(Math.floor(reset.getTime() / 1000), now), '10:12');
  });

  it('formats later reset with date', () => {
    const now = new Date(2026, 5, 22, 9, 0);
    const reset = new Date(2026, 5, 29, 6, 22);
    assert.strictEqual(formatResetTime(Math.floor(reset.getTime() / 1000), now), '06:22 on 29 Jun');
  });
});

describe('formatLimitLine', () => {
  it('renders Codex CLI-style usage row', () => {
    const reset = Math.floor(new Date(2026, 5, 22, 10, 12).getTime() / 1000);
    const line = formatLimitLine('5h limit', 1, reset, 12);
    assert.ok(line.startsWith('5h limit:'));
    assert.ok(line.includes('[████████████████████] 99% left'));
    assert.ok(line.includes('(resets'));
  });
});

describe('formatDate', () => {
  it('formats an ISO date string', () => {
    const result = formatDate('2026-06-22T12:00:00Z');
    assert.ok(result.includes('2026'));
    assert.ok(result.includes('Jun'));
    assert.ok(result.includes('22'));
  });
});

describe('formatCountdown', () => {
  it('returns expired for past dates', () => {
    const result = formatCountdown('2020-01-01T00:00:00Z');
    assert.ok(result.includes('expired'));
  });

  it('returns days left for future dates', () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const result = formatCountdown(future);
    assert.ok(result.includes('d left'));
  });
});

describe('formatDuration', () => {
  it('formats seconds', () => {
    assert.strictEqual(formatDuration(30), '30s');
  });

  it('formats minutes', () => {
    assert.strictEqual(formatDuration(120), '2m');
  });

  it('formats hours and minutes', () => {
    assert.strictEqual(formatDuration(3661), '1h 1m');
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    assert.strictEqual(truncate('hello', 10), 'hello');
  });

  it('truncates long strings with ellipsis', () => {
    const result = truncate('hello world this is long', 10);
    assert.ok(result.length <= 10);
    assert.ok(result.endsWith('\u2026'));
  });
});

describe('pad', () => {
  it('pads short strings', () => {
    assert.strictEqual(pad('hi', 5), 'hi   ');
  });

  it('does not pad strings at or beyond width', () => {
    assert.strictEqual(pad('hello', 5), 'hello');
    assert.strictEqual(pad('hello world', 5), 'hello');
  });
});

describe('planDisplayName', () => {
  it('formats common personal plan names', () => {
    assert.strictEqual(planDisplayName('plus'), 'Plus');
    assert.strictEqual(planDisplayName('pro'), 'Pro');
    assert.strictEqual(planDisplayName('prolite'), 'Pro Lite');
    assert.strictEqual(planDisplayName('custom_plan'), 'Custom Plan');
  });
});

describe('planBadge', () => {
  it('returns the display plan name', () => {
    const result = planBadge('plus');
    assert.ok(result.includes('Plus'));
  });
});
