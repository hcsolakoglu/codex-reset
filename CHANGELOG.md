# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- `watch` command — live TUI dashboard with real-time usage bars and credit countdowns
- `auto` command — auto-reset daemon with configurable thresholds
- `notify` command — push notifications (Telegram, Discord, desktop)
- `history` command — local reset log
- `doctor` command — diagnostics
- `config` command — persistent configuration
- `alerts` command — credit expiry and usage critical alerts
- `expire` command — credits expiring within N days
- Shell completions (bash, zsh, fish, PowerShell)
- `--watch` flag on `list` for continuous refresh

## [0.3.0] - 2026-08-16

Upstream-compatibility release: the wire contract with `openai/codex` is now
pinned by tests generated from the upstream source, and the auth/routing/retry
defects found during that verification are fixed. Test suite grew from 52 to
123 tests; production HTTP behavior is verified end to end.

### Added

- Idempotent credit redemption: the `redeem_request_id` is persisted before the
  consume POST and reused across CLI invocations after ambiguous outcomes
  (timeout, connection reset, unparseable 2xx, 5xx); a warning is shown when a
  different credit or a >24h-old record forces a fresh request id.
- Personal-access-token (PAT) account support, hydrated via the upstream whoami
  endpoint; PATs are used as the Bearer credential.
- FedRAMP routing: `X-OpenAI-Fedramp: true` is sent for accounts whose id_token
  carries `chatgpt_account_is_fedramp`.
- OAuth token refresh — proactive (expired access token) and reactive (401 →
  refresh → retry once) — with rotation persisted atomically back to the auth
  file and upstream-parity failure messages (expired / reused / revoked).
- Official upstream plan display names (`ent26` → "Enterprise",
  `enterprise_cbp_automation` → "Enterprise (Automation)", …) with a graceful
  fallback for unknown values.
- Upstream wire-contract test suite: the HTTP request boundary (method, path,
  headers, body) is asserted against a manifest generated from the
  openai/codex Rust sources; a weekly non-blocking `upstream-drift` CI workflow
  regenerates it and opens an issue when the contract moves.
- Richer error messages: 403 account-scope hints, 429 with preserved
  `Retry-After`, 5xx backend hints, and invalid-response diagnostics for
  HTML/empty/oversized bodies.

### Changed

- Account-id resolution matches upstream Codex: `tokens.account_id` → id_token
  claim → default organization as a last-resort discovery fallback.
- Non-ChatGPT auth files (API key, agent identity, Bedrock) are skipped with a
  stderr warning instead of silently.
- Window labels are derived from backend-reported durations (weekly primary is
  now the common shape; the 5-hour window was retired by OpenAI).

### Fixed

- Retrying an interrupted redemption can no longer silently spend a second
  credit in the common case (same account and credit; see the README's
  "Idempotent redemption" for the exact guarantee and its limits).
- Token refresh no longer risks truncating the auth file (atomic temp-file +
  rename), and unknown fields in existing auth files are preserved on write.

## [0.2.1] - 2026-07-13

### Fixed

- `reset --json` emits machine-readable output (single valid JSON document for
  batch results).

## [0.2.0] - 2026-07-05

### Changed

- Updated reset-credit flow for the then-current Codex backend API
  (rate-limit reset credits endpoints, credit selection by id).

## [0.1.0] - 2026-06-22

### Added

- `list` command — overview of all accounts with usage bars and credit count
- `credits` command — detailed credit breakdown with individual expiry dates and countdowns
- `reset` command — consume an available rate-limit reset credit after confirmation
- Interactive account picker for `reset` command
- `reset --all` flag to reset all eligible accounts
- `reset --yes` flag for non-interactive confirmation
- `--json` flag for machine-readable output on all commands
- `--help` and `--version` flags
- ANSI color output with `NO_COLOR` / `FORCE_COLOR` / `CI` support
- Auto-discovers accounts from `~/.codex/accounts/` (codex-auth compatible)
- Zero runtime dependencies — pure Node.js built-ins
- Cross-platform: macOS, Linux, Windows
