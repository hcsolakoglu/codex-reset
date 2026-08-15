/**
 * Minimal JWT helpers (no external dependencies).
 * @module core/jwt
 */

/** Decode the payload section of a JWT (base64url → JSON). Returns {} on failure. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const decoded = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}
