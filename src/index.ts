/**
 * codex-reset — library entry point for programmatic use.
 * @module index
 */

export {
  discoverAccounts,
  findAccount,
  decodeJwtPayload,
  extractIdentity,
} from './core/accounts.js';
export { getUsage, getCredits, consumeCredit, generateRequestId } from './core/api.js';
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
