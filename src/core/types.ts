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

/** A single rate-limit window (5h or 7d). */
export interface UsageWindow {
  used_percent: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

/** GET /wham/usage response. */
export interface UsageResponse {
  user_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: UsageWindow;
    secondary_window: UsageWindow;
  };
  rate_limit_reset_credits?: {
    available_count: number;
  };
  rate_limit_reached_type?: {
    type: string;
    details: string | null;
  };
}

/** Individual reset credit from GET /wham/rate-limit-reset-credits. */
export interface ResetCredit {
  id: string;
  reset_type: string;
  status: string;
  granted_at: string;
  expires_at: string;
  redeemed_at: string | null;
  profile_image_url: string | null;
  profile_user_id: string | null;
  title: string | null;
  description: string | null;
}

/** GET /wham/rate-limit-reset-credits response. */
export interface CreditsResponse {
  credits: ResetCredit[];
}

/** POST /wham/rate-limit-reset-credits/consume response. */
export interface ConsumeResponse {
  code: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
  credit: {
    id: string;
    reset_type: string;
    status: string;
    granted_at: string;
    expires_at: string;
    redeemed_at: string;
  };
  windows_reset: number;
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

/** Normalized usage snapshot for display. */
export interface AccountUsage {
  account: Account;
  primaryPercent: number;
  secondaryPercent: number;
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
