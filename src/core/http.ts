/**
 * Injectable HTTP transport seam.
 *
 * Production behavior is unchanged: Node's built-in https module against the
 * ChatGPT backend. Tests replace the transport via `setHttpTransport()` so the
 * exact request boundary (method, path, headers, body) can be asserted without
 * network access, and can point the base URL at a local fixture server via the
 * `CODEX_RESET_BASE_URL` environment variable.
 *
 * @module core/http
 */

import http from 'node:http';
import https from 'node:https';

/** A single outbound request, fully described. */
export interface TransportRequest {
  method: 'GET' | 'POST';
  protocol: 'https:' | 'http:';
  hostname: string;
  port?: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** A complete inbound response. Header names are lower-cased. */
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

/** Transport function; throws on network-level failures (DNS, connect, timeout). */
export type HttpTransport = (req: TransportRequest) => Promise<TransportResponse>;

/** Network-level failure (no HTTP response was received). */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

/** Default transport: Node built-in http/https, preserving historical behavior. */
export async function nodeHttpTransport(req: TransportRequest): Promise<TransportResponse> {
  const mod = req.protocol === 'http:' ? http : https;
  return new Promise<TransportResponse>((resolve, reject) => {
    const outgoing = mod.request(
      {
        hostname: req.hostname,
        port: req.port,
        path: req.path,
        method: req.method,
        headers: req.headers,
        timeout: req.timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenHeaders(res.headers),
            bodyText: data,
          });
        });
      },
    );

    outgoing.on('timeout', () => {
      outgoing.destroy(new TransportError('Request timed out'));
    });

    outgoing.on('error', (err: Error) => {
      reject(err instanceof TransportError ? err : new TransportError(err.message));
    });

    if (req.body) outgoing.write(req.body);
    outgoing.end();
  });
}

let activeTransport: HttpTransport | null = null;

/** Replace the transport (tests) or restore the default (pass null). */
export function setHttpTransport(transport: HttpTransport | null): void {
  activeTransport = transport;
}

/** The active transport — injected if set, otherwise the Node built-in client. */
export function getHttpTransport(): HttpTransport {
  return activeTransport ?? nodeHttpTransport;
}
