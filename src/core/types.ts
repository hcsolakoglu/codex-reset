/**
 * Shared type definitions for codex-reset.
 * @module core/types
 */

/** Raw auth.json token block. */
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id: string;
}

/** Raw ~/.codex/accounts/*.auth.json structure. */
export interface AuthFile {
  auth_mode: string;
  OPENAI_API_KEY: string | null;
  tokens: AuthTokens;
  last_refresh: string;
}

/** A single rate-limit window. Codex may omit either window for some plans. */
export interface UsageWindow {
  used_percent: number;
  limit_window_seconds?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
}

/** GET /wham/usage response. */
export interface UsageResponse {
  user_id?: string;
  account_id?: string;
  email?: string;
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  } | null;
  rate_limit_reset_credits?: {
    available_count?: number | null;
  } | null;
  rate_limit_reached_type?: {
    type?: string | null;
    details?: string | null;
  } | null;
}

/** Individual reset credit from GET /wham/rate-limit-reset-credits. */
export interface ResetCredit {
  id: string;
  reset_type: string;
  status: string;
  granted_at: string;
  expires_at: string | null;
  redeemed_at?: string | null;
  profile_image_url?: string | null;
  profile_user_id?: string | null;
  title?: string | null;
  description?: string | null;
}

/** GET /wham/rate-limit-reset-credits response. */
export interface CreditsResponse {
  credits: ResetCredit[];
  available_count?: number;
}

/** POST /wham/rate-limit-reset-credits/consume response. */
export interface ConsumeResponse {
  code: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
  windows_reset?: number;
  credit?: {
    id: string;
    reset_type: string;
    status: string;
    granted_at: string;
    expires_at: string | null;
    redeemed_at?: string | null;
  };
}

/** A discovered account ready for API calls. */
export interface Account {
  email: string;
  planType: string;
  accountId: string;
  authFile: AuthFile;
  alias: string | null;
  accountName: string | null;
}

/** Normalized usage snapshot for display. `null` means the backend did not report that window. */
export interface AccountUsage {
  account: Account;
  primaryPercent: number | null;
  secondaryPercent: number | null;
  primaryWindowSeconds: number | null;
  secondaryWindowSeconds: number | null;
  primaryResetAt: number | null;
  secondaryResetAt: number | null;
  availableCredits: number;
  rateLimitReachedType: string | null;
  fetchedAt: number;
}

/** Normalized credit for display. */
export interface AccountCredits {
  account: Account;
  credits: ResetCredit[];
}
