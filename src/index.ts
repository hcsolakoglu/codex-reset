/**
 * codex-reset — library entry point for programmatic use.
 * @module index
 */

export {
  discoverAccounts,
  findAccount,
  resolveCodexHome,
  decodeJwtPayload,
  extractIdentity,
} from './core/accounts.js';
export {
  getUsage,
  getCredits,
  consumeCredit,
  generateRequestId,
  bearerToken,
  buildRequestHeaders,
  createConsumeRequestBody,
} from './core/api.js';
export {
  setHttpTransport,
  getHttpTransport,
  nodeHttpTransport,
} from './core/http.js';
export type { TransportRequest, TransportResponse, HttpTransport } from './core/http.js';
export {
  fetchPatMetadata,
  refreshAccessToken,
  accessTokenIsExpired,
} from './core/auth.js';
export type { PatMetadata, RefreshedTokens } from './core/auth.js';
export {
  loadPendingRedemption,
  savePendingRedemption,
  clearPendingRedemption,
  isReusablePending,
  isAmbiguousConsumeFailure,
} from './core/idempotency.js';
export type { PendingRedemption } from './core/idempotency.js';
export type {
  Account,
  AccountUsage,
  AccountCredits,
  AuthFile,
  AuthTokens,
  UsageResponse,
  UsageWindow,
  ResetCredit,
  CreditsResponse,
  ConsumeResponse,
} from './core/types.js';
export { CliError, AuthError, ApiError } from './utils/errors.js';
