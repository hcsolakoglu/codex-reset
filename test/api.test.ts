import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConsumeRequestBody,
  normalizeConsumeResponse,
  normalizeUsage,
} from '../src/core/api.ts';
import type { Account } from '../src/core/types.ts';

const account: Account = {
  email: 'test@example.com',
  planType: 'business',
  accountId: 'acct-123',
  authFile: {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      account_id: 'acct-123',
    },
    last_refresh: '2026-07-14T00:00:00Z',
  },
  alias: null,
  accountName: null,
};

describe('normalizeUsage', () => {
  it('accepts the current one-window response with a null secondary window', () => {
    const result = normalizeUsage(account, {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 604800,
          reset_at: 1_750_000_000,
        },
        secondary_window: null,
      },
      rate_limit_reset_credits: { available_count: 3 },
    });

    assert.equal(result.primaryPercent, 42);
    assert.equal(result.primaryWindowSeconds, 604800);
    assert.equal(result.secondaryPercent, null);
    assert.equal(result.secondaryResetAt, null);
    assert.equal(result.availableCredits, 3);
  });

  it('treats a missing rate-limit object as unavailable rather than crashing', () => {
    const result = normalizeUsage(account, { rate_limit: null });
    assert.equal(result.primaryPercent, null);
    assert.equal(result.secondaryPercent, null);
    assert.equal(result.availableCredits, 0);
  });
});

describe('createConsumeRequestBody', () => {
  it('normalizes the current snake_case consume response', () => {
    assert.deepEqual(normalizeConsumeResponse({ code: 'nothing_to_reset', windows_reset: 0 }), {
      code: 'nothingToReset',
      windows_reset: 0,
    });
  });

  it('includes a selected credit id when provided', () => {
    assert.deepEqual(JSON.parse(createConsumeRequestBody('request-1', 'credit-1')), {
      redeem_request_id: 'request-1',
      credit_id: 'credit-1',
    });
  });

  it('preserves compatibility when no credit id is available', () => {
    assert.deepEqual(JSON.parse(createConsumeRequestBody('request-1')), {
      redeem_request_id: 'request-1',
    });
  });
});
