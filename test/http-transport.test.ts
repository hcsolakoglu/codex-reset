/**
 * Tests for the real production transport (nodeHttpTransport) against a live
 * localhost server. Every networked invocation of the CLI goes through this
 * code; the injected-transport tests elsewhere cannot catch regressions here.
 * Skips gracefully when local sockets are unavailable (e.g. hardened CI).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { nodeHttpTransport, TransportError } from '../src/core/http.ts';

interface Served {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base: { protocol: 'http:'; hostname: string; port: number };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url?.endsWith('/slow')) {
        return; // never respond
      }
      if (req.url?.endsWith('/teapot')) {
        res.statusCode = 418;
        res.end("short and stout");
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Retry-After', '12');
      res.end(
        JSON.stringify({ served: { method: req.method, url: req.url, headers: req.headers, body } }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = { protocol: 'http:', hostname: addr.address, port: addr.port };
});

after(() => {
  server.close();
});

function servedBody(bodyText: string): { served: Served } {
  return JSON.parse(bodyText) as { served: Served };
}

describe('nodeHttpTransport (production path)', () => {
  it('delivers method, path, headers, and body to the server', async () => {
    const res = await nodeHttpTransport({
      method: 'POST',
      ...base,
      path: '/backend-api/wham/rate-limit-reset-credits/consume',
      headers: {
        Authorization: 'Bearer tok',
        'ChatGPT-Account-Id': 'acct-1',
        'X-OpenAI-Fedramp': 'true',
        'Content-Type': 'application/json',
      },
      body: '{"redeem_request_id":"r1"}',
      timeoutMs: 5_000,
    });

    assert.equal(res.status, 200);
    const { served } = servedBody(res.bodyText);
    assert.equal(served.method, 'POST');
    assert.equal(served.url, '/backend-api/wham/rate-limit-reset-credits/consume');
    assert.equal(served.headers['authorization'], 'Bearer tok');
    assert.equal(served.headers['chatgpt-account-id'], 'acct-1');
    assert.equal(served.headers['x-openai-fedramp'], 'true');
    assert.equal(served.body, '{"redeem_request_id":"r1"}');
    // Response headers are flattened to lower-cased names.
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['retry-after'], '12');
  });

  it('reports the HTTP status of error responses', async () => {
    const res = await nodeHttpTransport({
      method: 'GET',
      ...base,
      path: '/teapot',
      headers: {},
      timeoutMs: 5_000,
    });
    assert.equal(res.status, 418);
    assert.equal(res.bodyText, 'short and stout');
  });

  it('destroys the request on timeout and rejects with TransportError', async () => {
    const t0 = Date.now();
    await assert.rejects(
      nodeHttpTransport({
        method: 'GET',
        ...base,
        path: '/slow',
        headers: {},
        timeoutMs: 250,
      }),
      (err: unknown) => {
        assert.ok(err instanceof TransportError);
        assert.match(err.message, /timed out/i);
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 5_000, 'timeout must fire near the configured deadline');
  });
});
