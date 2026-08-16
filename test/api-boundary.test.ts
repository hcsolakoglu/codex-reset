/**
 * Request-boundary and status/error-matrix tests. All HTTP goes through an
 * injected fake transport, so these assert the exact wire contract (method,
 * path, headers, body) without network access.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHttpTransport, TransportError } from '../src/core/http.ts';
import type { TransportResponse } from '../src/core/http.ts';
import { consumeCredit, getCredits, getUsage } from '../src/core/api.ts';
import { ApiError } from '../src/utils/errors.ts';
import { VERSION } from '../src/version.ts';
import {
  fakeTransport,
  jsonResponse,
  oauthAccount,
  oauthAuthFile,
  patAuthFile,
  withEnv,
} from './helpers.ts';

const USAGE_OK = jsonResponse(200, {
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: 1_750_000_000 },
    secondary_window: null,
  },
  rate_limit_reset_credits: { available_count: 2 },
});

let cleanupFns: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  cleanupFns = [];
});

afterEach(async () => {
  setHttpTransport(null);
  for (const fn of cleanupFns) await fn();
  cleanupFns = [];
});

describe('request boundary', () => {
  it('sends GET /backend-api/wham/usage with upstream headers', async () => {
    const { transport, requests } = fakeTransport(() => USAGE_OK);
    setHttpTransport(transport);
    await getUsage(oauthAccount());
    const req = requests[0]!;
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/backend-api/wham/usage');
    assert.equal(req.hostname, 'chatgpt.com');
    assert.equal(req.headers['Authorization'], 'Bearer ' + oauthAuthFile().tokens!.access_token);
    assert.equal(req.headers['ChatGPT-Account-Id'], 'acct-123');
    assert.equal(req.headers['Accept'], 'application/json');
    assert.equal(req.headers['User-Agent'], `codex-reset/${VERSION}`);
    assert.equal(req.headers['Content-Type'], undefined);
  });

  it('sends GET /backend-api/wham/rate-limit-reset-credits', async () => {
    const { transport, requests } = fakeTransport(() =>
      jsonResponse(200, { credits: [], available_count: 0 }),
    );
    setHttpTransport(transport);
    await getCredits(oauthAccount());
    assert.equal(requests[0]!.path, '/backend-api/wham/rate-limit-reset-credits');
  });

  it('sends POST /backend-api/wham/rate-limit-reset-credits/consume with the exact body', async () => {
    const { transport, requests } = fakeTransport(() =>
      jsonResponse(200, { code: 'reset', windows_reset: 1 }),
    );
    setHttpTransport(transport);
    await consumeCredit(oauthAccount(), 'redeem-1', 'credit-9');
    const req = requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/backend-api/wham/rate-limit-reset-credits/consume');
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(req.body!), {
      redeem_request_id: 'redeem-1',
      credit_id: 'credit-9',
    });
  });

  it('honors the CODEX_RESET_BASE_URL override', async () => {
    const { transport, requests } = fakeTransport(() => USAGE_OK);
    setHttpTransport(transport);
    await withEnv({ CODEX_RESET_BASE_URL: 'http://localhost:9/prefix' }, () => getUsage(oauthAccount()));
    assert.equal(requests[0]!.path, '/prefix/wham/usage');
    assert.equal(requests[0]!.protocol, 'http:');
    assert.equal(requests[0]!.port, 9);
  });

  it('emits X-OpenAI-Fedramp: true only for FedRAMP accounts', async () => {
    const { transport, requests } = fakeTransport(() => USAGE_OK);
    setHttpTransport(transport);
    await getUsage(oauthAccount({ fedramp: true }));
    await getUsage(oauthAccount({ fedramp: false }));
    assert.equal(requests[0]!.headers['X-OpenAI-Fedramp'], 'true');
    assert.equal(requests[1]!.headers['X-OpenAI-Fedramp'], undefined);
  });

  it('uses the personal access token as bearer for PAT accounts', async () => {
    const pat = patAuthFile('pat-token-1');
    const account = {
      ...oauthAccount(),
      authFile: pat,
      authMode: 'personalAccessToken',
    };
    const { transport, requests } = fakeTransport(() => USAGE_OK);
    setHttpTransport(transport);
    await getUsage(account);
    assert.equal(requests[0]!.headers['Authorization'], 'Bearer pat-token-1');
  });
});

describe('token refresh (upstream refresh grant)', () => {
  async function tempAuthFile(): Promise<{ path: string; content: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'codex-reset-refresh-'));
    cleanupFns.push(() => rm(dir, { recursive: true, force: true }));
    const content = JSON.stringify(oauthAuthFile({ refreshToken: 'refresh-old' }), null, 2);
    const path = join(dir, 'acct.auth.json');
    await writeFile(path, content, 'utf-8');
    return { path, content };
  }

  it('refreshes and retries once on 401, persisting rotated tokens', async () => {
    const { path } = await tempAuthFile();
    const account = oauthAccount({ refreshToken: 'refresh-old' });
    account.filepath = path;

    let usageCalls = 0;
    const { transport, requests } = fakeTransport((req) => {
      if (req.hostname === 'auth.openai.com' && req.path === '/oauth/token') {
        return jsonResponse(200, {
          id_token: 'new-id',
          access_token: 'new-access',
          refresh_token: 'refresh-rotated',
        });
      }
      usageCalls += 1;
      return usageCalls === 1 ? jsonResponse(401, { error: 'token expired' }) : USAGE_OK;
    });
    setHttpTransport(transport);

    const usage = await getUsage(account);
    assert.equal(usage.rate_limit?.primary_window?.used_percent, 42);

    const refresh = requests.find((r) => r.path === '/oauth/token')!;
    assert.equal(refresh.method, 'POST');
    assert.equal(refresh.hostname, 'auth.openai.com');
    assert.deepEqual(JSON.parse(refresh.body!), {
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    });
    // Retry uses the rotated access token.
    const retry = requests.filter((r) => r.path.endsWith('/usage'))[1]!;
    assert.equal(retry.headers['Authorization'], 'Bearer new-access');

    const persisted = JSON.parse(await readFile(path, 'utf-8'));
    assert.equal(persisted.tokens.access_token, 'new-access');
    assert.equal(persisted.tokens.refresh_token, 'refresh-rotated');
    assert.equal(persisted.tokens.id_token, 'new-id');
    assert.ok(persisted.last_refresh > '2026-08-01');
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const { path } = await tempAuthFile();
    const account = oauthAccount({ refreshToken: 'refresh-old' });
    account.filepath = path;
    let usageCalls = 0;
    const { transport } = fakeTransport((req) => {
      if (req.path === '/oauth/token') {
        return jsonResponse(200, { access_token: 'new-access' });
      }
      usageCalls += 1;
      return usageCalls === 1 ? jsonResponse(401, {}) : USAGE_OK;
    });
    setHttpTransport(transport);
    await getUsage(account);
    const persisted = JSON.parse(await readFile(path, 'utf-8'));
    assert.equal(persisted.tokens.refresh_token, 'refresh-old');
  });

  it('proactively refreshes an expired access token before the first request', async () => {
    const { path } = await tempAuthFile();
    const account = oauthAccount({ accessExp: 1_000_000_000, refreshToken: 'refresh-old' });
    account.filepath = path;
    const { transport, requests } = fakeTransport((req) => {
      if (req.path === '/oauth/token') return jsonResponse(200, { access_token: 'fresh' });
      return USAGE_OK;
    });
    setHttpTransport(transport);
    await getUsage(account);
    assert.equal(requests[0]!.path, '/oauth/token');
    assert.equal(requests[1]!.headers['Authorization'], 'Bearer fresh');
  });

  it('surfaces the classified refresh failure as the 401 hint', async () => {
    const account = oauthAccount({ refreshToken: 'refresh-old' });
    const { transport } = fakeTransport((req) => {
      if (req.path === '/oauth/token') {
        return jsonResponse(401, { error: { code: 'refresh_token_expired' } });
      }
      return jsonResponse(401, {});
    });
    setHttpTransport(transport);
    await assert.rejects(
      getUsage(account),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 401 &&
        // The upstream-parity classified message must reach the user, not the generic hint.
        (err.hint ?? '').includes('refresh token has expired'),
    );
  });

  it('refreshes and retries consumeCredit after a 401 too', async () => {
    const account = oauthAccount({ refreshToken: 'refresh-old' });
    let consumeCalls = 0;
    const { transport, requests } = fakeTransport((req) => {
      if (req.path === '/oauth/token') {
        return jsonResponse(200, { access_token: 'new-access' });
      }
      consumeCalls += 1;
      if (consumeCalls === 1) return jsonResponse(401, {});
      return jsonResponse(200, { code: 'reset', windows_reset: 1 });
    });
    setHttpTransport(transport);
    const result = await consumeCredit(account, 'redeem-9', 'credit-9');
    assert.equal(result.code, 'reset');
    const consumeAttempts = requests.filter((r) => r.path.endsWith('/consume'));
    assert.equal(consumeAttempts.length, 2);
    assert.equal(consumeAttempts[1]!.headers['Authorization'], 'Bearer new-access');
  });
});

describe('status/error matrix', () => {
  async function usageError(status: number, bodyText: string, headers: Record<string, string> = {}): Promise<unknown> {
    const { transport } = fakeTransport(
      (): TransportResponse => ({ status, headers, bodyText }),
    );
    setHttpTransport(transport);
    return getUsage(oauthAccount({ refreshToken: undefined })).catch((err: unknown) => err);
  }

  it('401 produces an Unauthorized error with a login hint', async () => {
    const err = (await usageError(401, '{}')) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 401);
    assert.match(err.message, /Unauthorized for test@example.com/);
    // Either the upstream classified refresh message or the generic login hint.
    assert.match(err.hint ?? '', /sign in again|codex login|codex-auth login/);
  });

  it('403 names the account and scopes the hint', async () => {
    const err = (await usageError(403, '{}')) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 403);
    assert.match(err.message, /HTTP 403 for test@example.com/);
    assert.match(err.hint ?? '', /workspace|feature/);
  });

  it('403 mentions FedRAMP routing for FedRAMP accounts', async () => {
    const { transport } = fakeTransport(() => jsonResponse(403, {}));
    setHttpTransport(transport);
    const err = (await getUsage(oauthAccount({ fedramp: true })).catch((e: unknown) => e)) as ApiError;
    assert.match(err.hint ?? '', /FedRAMP/);
  });

  it('429 preserves a numeric Retry-After', async () => {
    const err = (await usageError(429, '{}', { 'retry-after': '30' })) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 429);
    assert.equal(err.hint, 'Retry after 30 seconds.');
  });

  it('429 preserves an HTTP-date Retry-After', async () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    const err = (await usageError(429, '{}', { 'retry-after': when })) as ApiError;
    assert.match(err.hint ?? '', /^Retry after \d{4}-\d{2}-\d{2}T/);
  });

  it('5xx points at the backend', async () => {
    const err = (await usageError(503, 'maintenance')) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 503);
    assert.match(err.hint ?? '', /backend/i);
  });

  it('treats a 200 HTML body as an invalid response', async () => {
    const err = (await usageError(200, '<html>login page</html>')) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /invalid response/);
  });

  it('treats an empty 200 body as an invalid response', async () => {
    const err = (await usageError(200, '')) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /invalid response/);
  });

  it('treats truncated JSON as an invalid response', async () => {
    const err = (await usageError(200, '{"rate_limit": {')) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /invalid response/);
  });

  it('survives an oversized response body', async () => {
    const err = (await usageError(200, 'x'.repeat(2 * 1024 * 1024))) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /invalid response/);
  });

  it('wraps network failures with a connectivity hint', async () => {
    const { transport } = fakeTransport(() => {
      throw new TransportError('Request timed out');
    });
    setHttpTransport(transport);
    const err = (await getUsage(oauthAccount()).catch((e: unknown) => e)) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 0);
    assert.equal(err.message, 'Request timed out');
    assert.match(err.hint ?? '', /network/);
  });

  it('rejects an unknown consume result code', async () => {
    const { transport } = fakeTransport(() => jsonResponse(200, { code: 'what_is_this' }));
    setHttpTransport(transport);
    const err = (await consumeCredit(oauthAccount(), 'r1').catch((e: unknown) => e)) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 200);
    assert.match(err.message, /unknown result code/);
  });

  it('accepts authoritative snake_case consume codes and legacy camelCase aliases', async () => {
    for (const [wire, normalized] of [
      ['nothing_to_reset', 'nothingToReset'],
      ['no_credit', 'noCredit'],
      ['already_redeemed', 'alreadyRedeemed'],
      ['nothingToReset', 'nothingToReset'],
    ] as const) {
      const { transport } = fakeTransport(() =>
        jsonResponse(200, { code: wire, windows_reset: 0 }),
      );
      setHttpTransport(transport);
      const result = await consumeCredit(oauthAccount(), 'r1');
      assert.equal(result.code, normalized, wire);
    }
  });

  it('surfaces nested error messages from a failed consume', async () => {
    const { transport } = fakeTransport(() =>
      jsonResponse(409, { error: { message: 'credit already spent' } }),
    );
    setHttpTransport(transport);
    const err = (await consumeCredit(oauthAccount(), 'r1').catch((e: unknown) => e)) as ApiError;
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /credit already spent/);
  });
});
