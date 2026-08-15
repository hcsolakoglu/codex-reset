/**
 * Shared fixtures and harness for codex-reset tests.
 * @module test/helpers
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AuthFile } from '../src/core/types.ts';
import type { TransportRequest, TransportResponse } from '../src/core/http.ts';

/** Minimal unsigned JWT for claim-carrying tokens. */
export function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

export interface OauthFixtureOptions {
  email?: string;
  accountId?: string;
  plan?: string;
  fedramp?: boolean;
  /** exp claim (unix seconds) for the access token. */
  accessExp?: number;
  /** exp claim for the id token (defaults to far future). */
  idExp?: number;
  refreshToken?: string;
}

const AUTH_NS = 'https://api.openai.com/auth';

/** ChatGPT-OAuth auth.json fixture with realistic JWT claims. */
export function oauthAuthFile(opts: OauthFixtureOptions = {}): AuthFile {
  const idClaims: Record<string, unknown> = {
    email: opts.email ?? 'test@example.com',
    [AUTH_NS]: {
      chatgpt_account_id: opts.accountId ?? 'acct-123',
      chatgpt_plan_type: opts.plan ?? 'plus',
      chatgpt_user_id: 'user-456',
      ...(opts.fedramp ? { chatgpt_account_is_fedramp: true } : {}),
    },
    exp: opts.idExp ?? 4_102_444_800,
  };
  const accessClaims: Record<string, unknown> = {
    exp: opts.accessExp ?? 4_102_444_800,
  };
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: makeJwt(accessClaims),
      refresh_token: opts.refreshToken ?? 'refresh-token-1',
      id_token: makeJwt(idClaims),
      account_id: opts.accountId ?? 'acct-123',
    },
    last_refresh: '2026-08-01T00:00:00Z',
  };
}

/** An Account matching oauthAuthFile(). */
export function oauthAccount(opts: OauthFixtureOptions = {}, filepath: string | null = null): Account {
  const authFile = oauthAuthFile(opts);
  return {
    email: opts.email ?? 'test@example.com',
    planType: opts.plan ?? 'plus',
    accountId: opts.accountId ?? 'acct-123',
    authFile,
    alias: null,
    accountName: null,
    filepath,
    isFedramp: opts.fedramp === true,
    authMode: 'chatgpt',
  };
}

/** Personal-access-token auth.json fixture. */
export function patAuthFile(pat = 'pat-token-1'): AuthFile {
  return {
    auth_mode: 'personalAccessToken',
    OPENAI_API_KEY: null,
    personal_access_token: pat,
    last_refresh: null,
  };
}

/** Recorded request available to handlers and assertions. */
export interface RecordedRequest extends TransportRequest {
  bodyText?: string;
}

export type RouteHandler = (
  req: RecordedRequest,
) => TransportResponse | Promise<TransportResponse>;

/** JSON response helper. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, bodyText: JSON.stringify(body) };
}

/** Build a recording fake transport. */
export function fakeTransport(handler: RouteHandler) {
  const requests: RecordedRequest[] = [];
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const recorded: RecordedRequest = { ...req, bodyText: req.body };
    requests.push(recorded);
    return handler(recorded);
  };
  return { transport, requests };
}

/** Capture everything a function writes to stdout (and optionally stderr). */
export async function captureOutput<T>(
  fn: () => Promise<T>,
): Promise<{ stdout: string; stderr: string; result: T }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    outChunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    errChunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  try {
    const result = await fn();
    return { stdout: outChunks.join(''), stderr: errChunks.join(''), result };
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  }
}

/** Run a function with CODEX_HOME pointed at a populated temp dir. */
export async function withTempCodexHome<T>(
  files: Record<string, string>,
  fn: (codexHome: string) => Promise<T>,
): Promise<T> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-reset-test-'));
  const prev = process.env['CODEX_HOME'];
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(codexHome, relPath);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, content);
    }
    process.env['CODEX_HOME'] = codexHome;
    return await fn(codexHome);
  } finally {
    if (prev === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = prev;
    await rm(codexHome, { recursive: true, force: true });
  }
}

/** Run a function with environment variables set, restoring them after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  try {
    for (const [key, value] of Object.entries(vars)) {
      prev[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
