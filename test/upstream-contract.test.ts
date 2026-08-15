/**
 * Upstream wire-contract tests. Every assertion is driven by
 * test/fixtures/upstream-manifest.json, which is generated from a pinned
 * openai/codex checkout by tools/extract-upstream-manifest.mjs — never
 * hand-edited. When CODEX_UPSTREAM_DIR (or /tmp/codex-upstream) exists, the
 * manifest is also re-extracted and compared live, so local drift checkouts
 * fail here immediately.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import manifest from './fixtures/upstream-manifest.json' with { type: 'json' };
import { setHttpTransport } from '../src/core/http.ts';
import { consumeCredit, getCredits, getUsage, normalizeUsage, normalizeConsumeResponse, resolveBaseUrl } from '../src/core/api.ts';
import { refreshAccessToken, fetchPatMetadata, accessTokenIsExpired } from '../src/core/auth.ts';
import { discoverAccounts, extractIdentity } from '../src/core/accounts.ts';
import { ApiError } from '../src/utils/errors.ts';
import { planDisplayName } from '../src/utils/format.ts';
import { fakeTransport, jsonResponse, makeJwt, oauthAccount, withTempCodexHome, withEnv } from './helpers.ts';

afterEach(() => {
  setHttpTransport(null);
});

describe('manifest integrity', () => {
  it('is generated from the expected upstream surfaces', () => {
    assert.equal(manifest.source.repo, 'openai/codex');
    for (const rel of manifest.source.extractedFrom) {
      assert.match(rel, /^codex-rs\//);
    }
  });

  it('matches a live extraction when an upstream checkout is available', async () => {
    const dir = process.env['CODEX_UPSTREAM_DIR'] ?? '/tmp/codex-upstream';
    if (!existsSync(dir)) return; // drift check runs where the checkout exists
    const { extractManifest } = await import('../tools/extract-upstream-manifest.mjs');
    const live = extractManifest(dir);
    assert.deepEqual(live, manifest);
  });
});

describe('endpoints', () => {
  it('requests exactly the manifest ChatGptApi paths under the default base', async () => {
    // Pin the env: this test must hold regardless of ambient CODEX_RESET_BASE_URL.
    await withEnv({ CODEX_RESET_BASE_URL: undefined }, async () => {
      assert.equal(resolveBaseUrl().hostname, 'chatgpt.com');
      const base = resolveBaseUrl().pathname.replace(/\/+$/, '');
      // Pin the absolute production URLs literally. If upstream ever moves,
      // the manifest changes and this forces a human to acknowledge the new
      // location instead of base+endpoint cancelling each other out.
      assert.equal(`https://chatgpt.com${base}${manifest.endpoints.usage}`, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(`https://chatgpt.com${base}${manifest.endpoints.credits}`, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
      assert.equal(`https://chatgpt.com${base}${manifest.endpoints.consume}`, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');

      const paths: string[] = [];
      const { transport } = fakeTransport((req) => {
        paths.push(req.path);
        if (req.method === 'POST') return jsonResponse(200, { code: 'reset', windows_reset: 1 });
        if (req.path.endsWith('/rate-limit-reset-credits')) {
          return jsonResponse(200, { credits: [], available_count: 0 });
        }
        return jsonResponse(200, { rate_limit: null });
      });
      setHttpTransport(transport);
      const account = oauthAccount();
      await getUsage(account);
      await getCredits(account);
      await consumeCredit(account, 'r1');
      assert.equal(paths[0], `${base}${manifest.endpoints.usage}`);
      assert.equal(paths[1], `${base}${manifest.endpoints.credits}`);
      assert.equal(paths[2], `${base}${manifest.endpoints.consume}`);
      setHttpTransport(null);
    });
  });
});

describe('consume request and response', () => {
  it('body uses exactly the manifest request fields', async () => {
    const { transport, requests } = fakeTransport(() =>
      jsonResponse(200, { code: 'reset', windows_reset: 1 }),
    );
    setHttpTransport(transport);
    await consumeCredit(oauthAccount(), 'redeem-1', 'credit-1');
    const body = JSON.parse(requests[0]!.body ?? '') as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      manifest.consumeRequest.fields.map((f) => f.name).sort(),
    );
    const creditId = manifest.consumeRequest.fields.find((f) => f.optionalWhenAbsent)!;
    assert.equal(body[creditId.name], 'credit-1');
  });

  it('omits the optional credit_id field when absent', async () => {
    const { transport, requests } = fakeTransport(() =>
      jsonResponse(200, { code: 'reset', windows_reset: 0 }),
    );
    setHttpTransport(transport);
    await consumeCredit(oauthAccount(), 'redeem-2');
    const body = JSON.parse(requests[0]!.body ?? '') as Record<string, unknown>;
    assert.equal('credit_id' in body, false);
    assert.deepEqual(Object.keys(body), ['redeem_request_id']);
  });

  it('accepts every manifest snake_case result code and rejects unknowns', () => {
    assert.equal(manifest.consumeCodes.casing, 'snake_case');
    for (const value of manifest.consumeCodes.values) {
      const result = normalizeConsumeResponse({ code: value, windows_reset: 0 });
      assert.ok(result.code, value);
    }
    assert.throws(() => normalizeConsumeResponse({ code: 'made_up_code' }), ApiError);
  });

  it('response fields match the manifest', () => {
    const result = normalizeConsumeResponse({ code: 'reset', windows_reset: 2 });
    assert.deepEqual(Object.keys(result).sort(), [...manifest.consumeResponse.fields].sort());
    assert.equal(result.windows_reset, 2);
  });
});

describe('usage payload shape', () => {
  it('normalizes every manifest window field', () => {
    const window: Record<string, number> = {};
    for (const field of manifest.windowFields) window[field] = field === 'used_percent' ? 10 : 604800;
    window['reset_at'] = 1_755_000_000;
    const result = normalizeUsage(oauthAccount(), {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: window,
        secondary_window: window,
      } as never,
      rate_limit_reset_credits: { available_count: 1 },
    });
    assert.equal(result.primaryPercent, 10);
    assert.equal(result.primaryWindowSeconds, 604800);
    assert.equal(result.primaryResetAt, 1_755_000_000);
  });

  it('tolerates every additive top-level field the payload may carry', () => {
    const additive: Record<string, unknown> = {};
    for (const field of manifest.usageResponse.fields) additive[field] = null;
    additive['rate_limit'] = null;
    const result = normalizeUsage(oauthAccount(), additive as never);
    assert.equal(result.primaryPercent, null);
    assert.equal(result.availableCredits, 0);
  });

  it('requires the manifest-required credit fields and optional ones default to null', async () => {
    const required = manifest.creditFields.required;
    const good: Record<string, string> = Object.fromEntries(required.map((f) => [f, `v-${f}`]));
    const { transport } = fakeTransport(() => jsonResponse(200, { credits: [good], available_count: 1 }));
    setHttpTransport(transport);
    const credits = await getCredits(oauthAccount());
    assert.equal(credits.credits[0]!.title, null);
    assert.equal(credits.credits[0]!.expires_at, null);

    const bad = { ...good };
    delete bad[required[0]!];
    const { transport: badTransport } = fakeTransport(() =>
      jsonResponse(200, { credits: [bad], available_count: 1 }),
    );
    setHttpTransport(badTransport);
    await assert.rejects(getCredits(oauthAccount()), /invalid credit record/);
  });
});

describe('plan display names', () => {
  it('matches every official upstream display name', () => {
    for (const [raw, display] of Object.entries(manifest.planDisplayNames)) {
      assert.equal(planDisplayName(raw), display, raw);
    }
  });

  it('falls back gracefully for unknown plan values', () => {
    assert.equal(planDisplayName('brand_new_plan'), 'Brand New Plan');
  });
});

describe('auth file and JWT claims', () => {
  it('tolerates the complete manifest AuthDotJson field set', async () => {
    const authFile: Record<string, unknown> = {};
    for (const field of manifest.authFile.fields) {
      authFile[field.name] = field.name === 'tokens' ? undefined : null;
    }
    const idToken = makeJwt({
      email: 'manifest@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-m',
        chatgpt_plan_type: 'plus',
        chatgpt_account_is_fedramp: false,
      },
    });
    authFile['auth_mode'] = 'chatgpt';
    authFile['tokens'] = {
      access_token: 'a',
      refresh_token: 'r',
      id_token: idToken,
      account_id: 'acct-m',
    };
    const accounts = await withTempCodexHome(
      { 'accounts/m.auth.json': JSON.stringify(authFile) },
      () => discoverAccounts(),
    );
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.accountId, 'acct-m');
  });

  it('reads identity from the manifest claim namespaces', () => {
    const authKeys = manifest.jwtClaims.authClaimKeys;
    const authClaims: Record<string, unknown> = {
      chatgpt_account_id: 'acct-claims',
      chatgpt_plan_type: 'pro',
      chatgpt_account_is_fedramp: true,
    };
    void authKeys;
    const identity = extractIdentity({
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: makeJwt({
          email: 'claims@example.com',
          'https://api.openai.com/auth': authClaims,
        }),
        account_id: null,
      },
    });
    assert.equal(identity.accountId, 'acct-claims');
    assert.equal(identity.planType, 'pro');
    assert.equal(identity.isFedramp, true);
  });

  it('uses the manifest profile namespace as the email fallback', () => {
    const identity = extractIdentity({
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: makeJwt({ 'https://api.openai.com/profile': { email: 'p@example.com' } }),
        account_id: 'acct-x',
      },
    });
    assert.equal(identity.email, 'p@example.com');
    assert.equal(identity.accountId, 'acct-x');
  });

  it('uses the exp claim for proactive refresh decisions', () => {
    const expired = makeJwt({ exp: 1_000 });
    const valid = makeJwt({ exp: 4_102_444_800 });
    assert.equal(accessTokenIsExpired(expired), true);
    assert.equal(accessTokenIsExpired(valid), false);
    assert.equal(accessTokenIsExpired('not-a-jwt'), false);
  });
});

describe('request headers', () => {
  it('uses the manifest bearer scheme, account-id header, and FedRAMP literal', async () => {
    assert.equal(manifest.headers.authorizationScheme, 'Bearer');
    const expectedAccountHeader = manifest.headers.accountIdHeader!.toLowerCase();
    const fedramp = manifest.headers.literals.find((h) => /fedramp/i.test(h.name))!;
    const { transport, requests } = fakeTransport(() => jsonResponse(200, { rate_limit: null }));
    setHttpTransport(transport);
    await getUsage(oauthAccount({ fedramp: true }));
    const headers = requests[0]!.headers;
    assert.match(headers['Authorization'] ?? '', /^Bearer /);
    const accountHeader = Object.keys(headers).find((h) => h.toLowerCase() === expectedAccountHeader)!;
    assert.equal(headers[accountHeader], 'acct-123');
    const fedrampHeader = Object.keys(headers).find((h) => h.toLowerCase() === fedramp.name.toLowerCase())!;
    assert.equal(headers[fedrampHeader], fedramp.value);
  });
});

describe('oauth refresh contract', () => {
  it('posts the manifest grant to the manifest endpoint', async () => {
    const url = new URL(manifest.refresh.url);
    const { transport, requests } = fakeTransport(() =>
      jsonResponse(200, { id_token: 'i', access_token: 'a', refresh_token: 'r2' }),
    );
    setHttpTransport(transport);
    await withEnv({ CODEX_REFRESH_TOKEN_URL_OVERRIDE: manifest.refresh.url }, () =>
      refreshAccessToken('rt-1'),
    );
    const req = requests[0]!;
    assert.equal(req.hostname, url.hostname);
    assert.equal(req.path, url.pathname);
    const body = JSON.parse(req.body ?? '') as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      manifest.refresh.requestFields.slice().sort(),
    );
    assert.equal(body['grant_type'], manifest.refresh.grantType);
    assert.equal(body['client_id'], manifest.refresh.clientId);
  });

  it('classification covers the manifest failure codes', async () => {
    for (const code of manifest.refresh.failureCodes) {
      const { transport } = fakeTransport(() => jsonResponse(400, { error: { code } }));
      setHttpTransport(transport);
      const err = (await refreshAccessToken('rt').catch((e: unknown) => e)) as Error;
      assert.match(err.message, /sign in again|refresh/i, code);
    }
  });
});

describe('pat whoami contract', () => {
  it('hydrates from the manifest endpoint using its metadata fields', async () => {
    const { transport, requests } = fakeTransport(() =>
      jsonResponse(200, {
        email: 'pat@example.com',
        chatgpt_user_id: 'u',
        chatgpt_account_id: 'acct-p',
        chatgpt_plan_type: 'pro',
        chatgpt_account_is_fedramp: true,
      }),
    );
    setHttpTransport(transport);
    const metadata = await fetchPatMetadata('pat-1');
    const req = requests[0]!;
    const whoamiBase = new URL(manifest.patWhoami.baseUrl);
    assert.equal(req.hostname, whoamiBase.hostname);
    assert.equal(req.path, `${whoamiBase.pathname}${manifest.patWhoami.path}`);
    assert.equal(req.headers['Authorization'], 'Bearer pat-1');
    assert.equal(metadata.chatgpt_account_id, 'acct-p');
    assert.equal(metadata.chatgpt_account_is_fedramp, true);
  });
});
