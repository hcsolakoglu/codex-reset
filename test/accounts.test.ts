import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  decodeJwtPayload,
  discoverAccounts,
  extractIdentity,
  findAccount,
  resolveCodexHome,
} from '../src/core/accounts.ts';
import { setHttpTransport } from '../src/core/http.ts';
import type { TransportResponse } from '../src/core/http.ts';
import type { Account, AuthFile } from '../src/core/types.ts';
import {
  captureOutput,
  fakeTransport,
  jsonResponse,
  oauthAuthFile,
  patAuthFile,
  withTempCodexHome,
} from './helpers.ts';

// Never let one test's injected transport leak into the next on failure.
afterEach(() => setHttpTransport(null));

// A minimal JWT with email and auth claims for testing
function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

const testClaims = {
  email: 'test@example.com',
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-123',
    chatgpt_plan_type: 'team',
    chatgpt_user_id: 'user-456',
  },
};

const testJwt = makeJwt(testClaims);

const testAuthFile: AuthFile = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    access_token: 'access',
    refresh_token: 'refresh',
    id_token: testJwt,
    account_id: 'acct-123',
  },
  last_refresh: '2026-06-22T00:00:00Z',
};

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT', () => {
    const payload = decodeJwtPayload(testJwt);
    assert.strictEqual(payload.email, 'test@example.com');
  });

  it('returns empty object for invalid token', () => {
    const payload = decodeJwtPayload('not-a-jwt');
    assert.deepEqual(payload, {});
  });

  it('returns empty object for empty string', () => {
    const payload = decodeJwtPayload('');
    assert.deepEqual(payload, {});
  });
});

describe('extractIdentity', () => {
  it('extracts email, accountId, and planType', () => {
    const { email, accountId, planType } = extractIdentity(testAuthFile);
    assert.strictEqual(email, 'test@example.com');
    assert.strictEqual(accountId, 'acct-123');
    assert.strictEqual(planType, 'team');
  });

  it('falls back to tokens.account_id when JWT lacks claim', () => {
    const authFile: AuthFile = {
      ...testAuthFile,
      tokens: {
        ...testAuthFile.tokens,
        id_token: makeJwt({ email: 'test2@example.com' }),
      },
    };
    const { accountId } = extractIdentity(authFile);
    assert.strictEqual(accountId, 'acct-123');
  });
});

describe('resolveCodexHome', () => {
  it('uses CODEX_HOME before HOME and USERPROFILE', () => {
    const originalCodexHome = process.env['CODEX_HOME'];
    const originalHome = process.env['HOME'];
    const originalUserProfile = process.env['USERPROFILE'];

    try {
      process.env['CODEX_HOME'] = '/tmp/custom-codex-home';
      process.env['HOME'] = '/tmp/home';
      process.env['USERPROFILE'] = 'C:\\Users\\alice';

      assert.strictEqual(resolveCodexHome(), '/tmp/custom-codex-home');
    } finally {
      if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = originalCodexHome;

      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;

      if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = originalUserProfile;
    }
  });
});

describe('discoverAccounts', () => {
  it('loads codex-auth managed accounts and registry metadata', async () => {
    await withTempCodexHome({}, async (codexHome) => {
      const accountsDir = join(codexHome, 'accounts');
      await mkdir(accountsDir, { recursive: true });
      await writeFile(join(accountsDir, 'acct.auth.json'), JSON.stringify(testAuthFile));
      await writeFile(
        join(accountsDir, 'registry.json'),
        JSON.stringify({
          accounts: [
            {
              account_key: 'acct',
              chatgpt_account_id: 'acct-123',
              chatgpt_user_id: 'user-456',
              email: 'test@example.com',
              alias: 'work',
              account_name: 'Example Org',
              plan: 'business',
            },
          ],
        }),
      );

      const accounts = await discoverAccounts(codexHome);

      assert.strictEqual(accounts.length, 1);
      assert.strictEqual(accounts[0]?.email, 'test@example.com');
      assert.strictEqual(accounts[0]?.accountId, 'acct-123');
      assert.strictEqual(accounts[0]?.planType, 'team');
      assert.strictEqual(accounts[0]?.alias, 'work');
      assert.strictEqual(accounts[0]?.accountName, 'Example Org');
    });
  });

  it('falls back to live auth.json when accounts directory is absent', async () => {
    await withTempCodexHome({}, async (codexHome) => {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify(testAuthFile));

      const accounts = await discoverAccounts(codexHome);

      assert.strictEqual(accounts.length, 1);
      assert.strictEqual(accounts[0]?.email, 'test@example.com');
      assert.strictEqual(accounts[0]?.accountId, 'acct-123');
      assert.strictEqual(accounts[0]?.alias, null);
      assert.strictEqual(accounts[0]?.accountName, null);
    });
  });
});

describe('findAccount', () => {
  const accounts: Account[] = [
    {
      email: 'alice@example.com',
      planType: 'team',
      accountId: 'acct-001',
      authFile: testAuthFile,
      alias: 'work',
      accountName: 'Shared Account',
    },
    {
      email: 'bob@example.com',
      planType: 'plus',
      accountId: 'acct-002',
      authFile: testAuthFile,
      alias: null,
      accountName: null,
    },
  ];

  it('finds by index (1-based)', () => {
    const result = findAccount(accounts, '2');
    assert.strictEqual(result?.email, 'bob@example.com');
  });

  it('finds by exact email', () => {
    const result = findAccount(accounts, 'alice@example.com');
    assert.strictEqual(result?.accountId, 'acct-001');
  });

  it('finds by alias', () => {
    const result = findAccount(accounts, 'work');
    assert.strictEqual(result?.email, 'alice@example.com');
  });

  it('finds by account_id prefix', () => {
    const result = findAccount(accounts, 'acct-002');
    assert.strictEqual(result?.email, 'bob@example.com');
  });

  it('finds by partial email', () => {
    const result = findAccount(accounts, 'alice');
    assert.strictEqual(result?.email, 'alice@example.com');
  });

  it('returns undefined for a malformed numeric query instead of truncating it', () => {
    assert.equal(findAccount(accounts, '2abc'), undefined);
  });

  it('returns undefined for no match', () => {
    const result = findAccount(accounts, 'nonexistent');
    assert.strictEqual(result, undefined);
  });
});

describe('auth-mode fixture matrix', () => {
  // A transport that fails the test if any non-PAT mode touches the network.
  function offlineTransport() {
    const { transport } = fakeTransport(() => {
      throw new Error('network must not be used in offline discovery modes');
    });
    setHttpTransport(transport);
  }

  it('discovers a personal access token account via whoami hydration', async () => {
    const { transport, requests } = fakeTransport(
      (req): TransportResponse => {
        assert.equal(req.hostname, 'auth.openai.com');
        assert.equal(req.path, '/api/accounts/v1/user-auth-credential/whoami');
        return jsonResponse(200, {
          email: 'pat-user@example.com',
          chatgpt_user_id: 'user-pat',
          chatgpt_account_id: 'acct-pat',
          chatgpt_plan_type: 'pro',
          chatgpt_account_is_fedramp: true,
        });
      },
    );
    setHttpTransport(transport);

    await withTempCodexHome(
      { 'accounts/pat.auth.json': JSON.stringify(patAuthFile('pat-token-1')) },
      async () => {
        const accounts = await discoverAccounts();
        assert.equal(accounts.length, 1);
        const acct = accounts[0]!;
        assert.equal(acct.email, 'pat-user@example.com');
        assert.equal(acct.accountId, 'acct-pat');
        assert.equal(acct.planType, 'pro');
        assert.equal(acct.isFedramp, true);
        assert.equal(acct.authMode, 'personalAccessToken');
        assert.equal(requests[0]!.headers['Authorization'], 'Bearer pat-token-1');
      },
    );
    setHttpTransport(null);
  });

  it('skips a PAT account whose whoami lookup fails, with a warning', async () => {
    const { transport } = fakeTransport(() => jsonResponse(403, {}));
    setHttpTransport(transport);
    const { stderr } = await captureOutput(async () => {
      const accounts = await withTempCodexHome(
        { 'accounts/pat.auth.json': JSON.stringify(patAuthFile()) },
        () => discoverAccounts(),
      );
      assert.equal(accounts.length, 0);
    });
    assert.match(stderr, /personal access token could not be verified/);
    setHttpTransport(null);
  });

  it('skips API-key accounts with a warning and no network calls', async () => {
    offlineTransport();
    const { stderr } = await captureOutput(async () => {
      const accounts = await withTempCodexHome(
        {
          'accounts/sk.auth.json': JSON.stringify({
            auth_mode: 'apikey',
            OPENAI_API_KEY: 'sk-test',
          }),
        },
        () => discoverAccounts(),
      );
      assert.equal(accounts.length, 0);
    });
    assert.match(stderr, /API-key accounts/);
    setHttpTransport(null);
  });

  it('skips agent-identity accounts with a warning', async () => {
    offlineTransport();
    const { stderr } = await captureOutput(async () => {
      const accounts = await withTempCodexHome(
        {
          'accounts/agent.auth.json': JSON.stringify({
            auth_mode: 'agentIdentity',
            agent_identity: 'agent-jwt',
          }),
        },
        () => discoverAccounts(),
      );
      assert.equal(accounts.length, 0);
    });
    assert.match(stderr, /agent-identity/);
    setHttpTransport(null);
  });

  it('skips Bedrock accounts with a warning', async () => {
    offlineTransport();
    const { stderr } = await captureOutput(async () => {
      const accounts = await withTempCodexHome(
        {
          'accounts/bedrock.auth.json': JSON.stringify({
            auth_mode: 'bedrockApiKey',
            bedrock_api_key: { region: 'us-east-1' },
          }),
        },
        () => discoverAccounts(),
      );
      assert.equal(accounts.length, 0);
    });
    assert.match(stderr, /Bedrock/);
    setHttpTransport(null);
  });

  it('skips a token-less credential-free file without crashing', async () => {
    offlineTransport();
    const { stderr } = await captureOutput(async () => {
      const accounts = await withTempCodexHome(
        { 'accounts/empty.auth.json': JSON.stringify({ auth_mode: 'chatgpt' }) },
        () => discoverAccounts(),
      );
      assert.equal(accounts.length, 0);
    });
    assert.match(stderr, /no usable credentials/);
    setHttpTransport(null);
  });

  it('carries the FedRAMP claim onto the account', async () => {
    offlineTransport();
    const accounts = await withTempCodexHome(
      { 'accounts/fed.auth.json': JSON.stringify(oauthAuthFile({ fedramp: true })) },
      () => discoverAccounts(),
    );
    assert.equal(accounts[0]?.isFedramp, true);
    setHttpTransport(null);
  });

  it('still discovers an account whose access token is expired (refresh is reactive)', async () => {
    offlineTransport();
    const accounts = await withTempCodexHome(
      { 'accounts/exp.auth.json': JSON.stringify(oauthAuthFile({ accessExp: 1_000_000_000 })) },
      () => discoverAccounts(),
    );
    assert.equal(accounts.length, 1);
    setHttpTransport(null);
  });

  it('falls back to the profile.email claim when top-level email is absent', async () => {
    const authFile = oauthAuthFile();
    const claims = decodeJwtPayload(authFile.tokens!.id_token);
    delete claims.email!;
    claims['https://api.openai.com/profile'] = { email: 'profile@example.com' };
    const idToken = `${authFile.tokens!.id_token.split('.')[0]}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}.sig`;
    offlineTransport();
    const accounts = await withTempCodexHome(
      {
        'accounts/prof.auth.json': JSON.stringify({
          ...authFile,
          tokens: { ...authFile.tokens!, id_token: idToken },
        }),
      },
      () => discoverAccounts(),
    );
    assert.equal(accounts[0]?.email, 'profile@example.com');
    setHttpTransport(null);
  });

  it('falls back to the default organization id when the account-id claim is absent', async () => {
    const authFile = oauthAuthFile();
    const claims = decodeJwtPayload(authFile.tokens!.id_token);
    const auth = claims['https://api.openai.com/auth'] as Record<string, unknown>;
    delete auth.chatgpt_account_id;
    auth.organizations = [{ id: 'org-2' }, { id: 'org-1', is_default: true }];
    const idToken = `${authFile.tokens!.id_token.split('.')[0]}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}.sig`;
    offlineTransport();
    const accounts = await withTempCodexHome(
      {
        'accounts/org.auth.json': JSON.stringify({
          ...authFile,
          tokens: { ...authFile.tokens!, id_token: idToken, account_id: null },
        }),
      },
      () => discoverAccounts(),
    );
    assert.equal(accounts[0]?.accountId, 'org-1');
    setHttpTransport(null);
  });

  it('prefers tokens.account_id over the claim, matching upstream request auth', async () => {
    const authFile = oauthAuthFile(); // claim says acct-123
    offlineTransport();
    const accounts = await withTempCodexHome(
      {
        'accounts/forced.auth.json': JSON.stringify({
          ...authFile,
          tokens: { ...authFile.tokens!, account_id: 'forced-workspace-9' },
        }),
      },
      () => discoverAccounts(),
    );
    assert.equal(accounts[0]?.accountId, 'forced-workspace-9');
    setHttpTransport(null);
  });

  it('normalizes an empty-string registry alias to null', async () => {
    offlineTransport();
    const accounts = await withTempCodexHome(
      {
        'accounts/acct.auth.json': JSON.stringify(oauthAuthFile()),
        'accounts/registry.json': JSON.stringify({
          accounts: [
            {
              account_key: 'user-456::acct-123',
              chatgpt_account_id: 'acct-123',
              chatgpt_user_id: 'user-456',
              email: 'test@example.com',
              alias: '',
              account_name: null,
              plan: null,
            },
          ],
        }),
      },
      () => discoverAccounts(),
    );
    assert.equal(accounts[0]?.alias, null);
    setHttpTransport(null);
  });
});
