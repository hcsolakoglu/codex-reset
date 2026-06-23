import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeJwtPayload,
  discoverAccounts,
  extractIdentity,
  findAccount,
  resolveCodexHome,
} from '../src/core/accounts.ts';
import type { Account, AuthFile } from '../src/core/types.ts';

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

async function withTempCodexHome<T>(fn: (codexHome: string) => Promise<T>): Promise<T> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-reset-test-'));
  try {
    return await fn(codexHome);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

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
    await withTempCodexHome(async (codexHome) => {
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
    await withTempCodexHome(async (codexHome) => {
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

  it('returns undefined for no match', () => {
    const result = findAccount(accounts, 'nonexistent');
    assert.strictEqual(result, undefined);
  });
});
