<div align="center">

# codex-reset

**Inspect and redeem OpenAI Codex rate-limit reset credits from the command line — multi-account usage bars, credit expiry, idempotent resets, JSON output**

[![npm](https://img.shields.io/npm/v/codex-reset.svg)](https://www.npmjs.com/package/codex-reset)
[![npm downloads](https://img.shields.io/npm/dm/codex-reset.svg)](https://www.npmjs.com/package/codex-reset)
[![CI](https://github.com/hcsolakoglu/codex-reset/actions/workflows/ci.yml/badge.svg)](https://github.com/hcsolakoglu/codex-reset/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/codex-reset.svg)](https://nodejs.org)

</div>

---

## What it does

OpenAI grants some Codex accounts **rate-limit reset credits** — one-shot
credits that clear your usage windows when you hit the ChatGPT plan limits for
Codex. `codex-reset` makes those credits visible and redeemable from the
terminal:

- **`list`** — every account with live usage bars (5h / daily / weekly /
  monthly windows, labeled from what the backend actually reports), remaining
  capacity, and reset-credit counts
- **`credits`** — individual credits with grant dates, expiry dates, and
  countdowns, so nothing expires unused
- **`reset`** — redeem a credit interactively, by account, or in batch, with
  before/after usage comparison

Works with single-account [Codex CLI](https://github.com/openai/codex) installs
and multi-account [codex-auth](https://github.com/Loongphy/codex-auth) setups,
refreshes OAuth tokens itself, and mirrors the official client's wire contract
(pinned by tests against the upstream source).

Use it only with accounts you own or are authorized to operate. Availability is
determined by your account's live API response; the tool does not promise support
for any specific plan or account class.

## Why not just the Codex TUI?

The official Codex TUI's `/usage` flow can redeem a credit for the account
you're signed in with. `codex-reset` exists for everything around that:

| | Codex TUI `/usage` | `codex-reset` |
| --- | --- | --- |
| Multiple accounts at a glance | ✗ (one at a time) | ✓ aggregates every discovered account |
| Non-interactive / `--json` output for scripts, cron, CI | ✗ | ✓ |
| Batch reset of all exhausted accounts | ✗ | ✓ `reset --all --yes` |
| Credit expiry & countdown tracking | partial | ✓ `credits` |
| Idempotent retry after a timeout | ✓ (session) | ✓ across CLI invocations |

## Install

```bash
npm install -g codex-reset
```

Or run without installing:

```bash
npx codex-reset list
```

## Quick start

```bash
# See all your accounts with live usage
codex-reset list

# Check available credits with expiry dates
codex-reset credits

# Reset an account (interactive picker; selects a specific credit when available)
codex-reset reset

# Reset all exhausted accounts, no prompts
codex-reset reset --all --yes
```

## Commands

### `codex-reset list`

Shows all discovered accounts with usage bars and credit count. Window labels
(5h / Daily / Weekly / Monthly) are derived from what the backend reports —
since OpenAI retired the 5-hour rolling window, most plans now show a Weekly
primary with the secondary unavailable.

```
   1  main          <dev@example.com>       Plus      2 reset credits  reset available
      Weekly limit:        [██████████████████░░] 88% left (resets 22:35 on 22 Aug)
      Secondary limit:     unavailable

   2  personal      <person@example.com>    Plus      1 reset credit   ok
      Weekly limit:        [████████████████████] 99% left (resets 06:22 on 29 Aug)
      Secondary limit:     unavailable

Accounts: 2  •  Credits available: 3  •  Exhausted: 0  •  Lowest left: Weekly 88%, Secondary n/a
```

### `codex-reset credits`

Shows individual credits with grant date, expiry date, and countdown.

```
  dev@example.com (Plus)  2 available
    #b4f53a61d614  granted Jun 12, 2026  expires Jul 12, 2026  20d left
    #2815139a8ea0  granted Jun 18, 2026  expires Jul 18, 2026  26d left

  Total available credits: 5
```

### `codex-reset reset [query]`

Consumes a reset credit to clear the usage window(s) reported by the backend.
Some plans expose only one window, and reset scope can be weekly, five-hour,
monthly, or another backend-defined scope.

```bash
codex-reset reset              # interactive picker
codex-reset reset 2            # by list index
codex-reset reset me@example.com # by email
codex-reset reset --all        # reset all eligible accounts
codex-reset reset --all --yes  # no confirmation prompt
codex-reset reset --json --yes # confirmed non-interactive JSON mode
```

`--json` never confirms a destructive operation by itself. Passing `--json`
without `--yes` exits safely before any network request or consume request.
Batch mode emits exactly one JSON document with a `results` array.

Output shows before/after comparison:

```
  ✓ Reset successful for dev@example.com
  Windows reset: 1

  Weekly limit:      [░░░░░░░░░░░░░░░░░░] 0% left → [████████████████████] 99% left
  Secondary limit:   unavailable
  Credits:  2  →  1  left
```

## Global options

| Flag              | Description                                 |
| ----------------- | ------------------------------------------- |
| `--json`          | Machine-readable JSON output (all commands) |
| `--help`, `-h`    | Show help                                   |
| `--version`, `-V` | Show version                                |
| `NO_COLOR=1`      | Disable colored output                      |
| `FORCE_COLOR=1`   | Force colored output                        |

Environment overrides used mostly by tests and local development:
`CODEX_RESET_BASE_URL` (ChatGPT backend base, default
`https://chatgpt.com/backend-api`), plus the upstream-honored
`CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_APP_SERVER_LOGIN_CLIENT_ID`, and
`CODEX_AUTHAPI_BASE_URL`.

## How it works

1. **Account discovery**: Reads codex-auth multi-account files and falls back to official Codex CLI/Desktop `auth.json`
2. **Usage check**: Calls `GET /backend-api/wham/usage` to fetch current rate-limit windows; missing windows are displayed as unavailable
3. **Credit listing**: Calls `GET /backend-api/wham/rate-limit-reset-credits` to list individual credits, expiry, and reset scope
4. **Credit consumption**: Calls `POST /backend-api/wham/rate-limit-reset-credits/consume` with a UUID `redeem_request_id` and the selected `credit_id` when the backend provides one. The idempotency key is persisted before the request so a retry of the *same* redemption reuses it (see [Idempotent redemption](#idempotent-redemption)).

All requests use HTTPS with your existing OAuth access token. No credentials are stored or logged.

## Account discovery

`codex-reset` auto-discovers Codex auth files without configuration. It follows
the same Codex home resolution used by the official Codex CLI and codex-auth:

1. `CODEX_HOME` when set
2. `$HOME/.codex` on Linux/macOS
3. `%USERPROFILE%\.codex` on Windows when `HOME` is unavailable
4. Node's `os.homedir()/.codex` fallback

Within Codex home it checks:

- `accounts/*.auth.json` plus `accounts/registry.json` from
  [`codex-auth`](https://github.com/Loongphy/codex-auth), supporting multiple
  accounts and aliases.
- `auth.json` from the official Codex CLI / Codex Desktop App, supporting
  single-account installs that do not use codex-auth.

This matches the storage shape used by `codex-auth`. `codex-switch` stores its
own copies under `~/.codex-switch/profiles/<alias>/auth.json`; those files are
not treated as source of truth because they can go stale after codex-auth refreshes
tokens.

## Supported auth modes and credential storage

The auth-file schema mirrors upstream `AuthDotJson` (openai/codex
`login/src/auth/storage.rs`), which is also what codex-auth snapshots verbatim.

| Auth mode | Behavior |
| --------- | -------- |
| `chatgpt` (OAuth tokens) | Fully supported. Tokens are refreshed automatically (see below) and rotated tokens are written back to the same file. |
| `personalAccessToken` | Supported. The token is verified against `auth.openai.com …/user-auth-credential/whoami` (the same call upstream makes) to resolve email, account id, plan, and FedRAMP status, then used as the Bearer credential. |
| `apikey`, `agentIdentity`, `bedrockApiKey` | Skipped with a warning — these have no ChatGPT rate limits to inspect or reset. |
| Missing/unreadable credentials | Skipped with a warning; never crashes discovery. |

**Credential storage is file-based only.** If you configured the official Codex
CLI to store credentials in the OS keyring (`storage_mode = "keyring"` or
`preferred_auth_mode` keyring settings in upstream Codex), `codex-reset` will
not find them — it reads `auth.json` / `accounts/*.auth.json` only. Keep at
least one file-based account, or run `codex login` with file storage.

**Token refresh.** When the stored access token is expired (JWT `exp` claim) or
the backend answers `401`, codex-reset performs the upstream refresh grant
(`POST https://auth.openai.com/oauth/token`, client id
`app_EMoamEEZ73f0CkXaXp7hrann`, overridable via
`CODEX_APP_SERVER_LOGIN_CLIENT_ID` / `CODEX_REFRESH_TOKEN_URL_OVERRIDE`) and
persists any rotated tokens before retrying the request once. If the refresh
token itself is expired, revoked, or reused, you are told to sign in again.

**FedRAMP.** Accounts whose id_token carries `chatgpt_account_is_fedramp: true`
send `X-OpenAI-Fedramp: true` on every backend request, matching upstream
routing.

## Idempotent redemption

Consuming a credit is destructive, and a network timeout after the server
processed the request risks spending a second credit on retry. The redemption
id (`redeem_request_id`) is written to `{CODEX_HOME}/pending-redeem.<account>.json`
**before** the POST and kept until the outcome is resolved:

- a 2xx response with a known result code, or a 4xx rejection → record cleared
- timeout / connection reset / 5xx / a 2xx body with an *unknown* result code
  (consumed but unreadable) → record kept as unresolved
- rerunning `reset` for the **same account and same credit** within 24h reuses
  the original id (surfacing `retrying unresolved redemption with its original
  request id`), so the server's idempotency deduplicates the retry

Limits of the guarantee, both announced on stderr when they occur: if the retry
selects a **different credit** (e.g. the original one is no longer listed) or
the unresolved record is older than 24h, a fresh id is minted — with the
warning `a previous redemption attempt did not complete and may already have
used a credit`. The server-side `nothing_to_reset`/`already_redeemed` codes
usually neutralize such a retry, but the tool cannot rule out a second spend,
which is why it warns instead of staying silent. This mirrors the
idempotency-key retry semantics of the official TUI's
`/usage → Redeem usage limit reset` flow.

## Troubleshooting

**`No Codex accounts found`** — there is no readable auth file. Run
`codex login` (official Codex CLI) or `codex-auth login` (multi-account), or
point `CODEX_HOME` at the directory holding `auth.json` /
`accounts/*.auth.json`. API-key, agent-identity, and Bedrock auth files are
skipped on purpose: those accounts have no ChatGPT rate limits to inspect.

**`Unauthorized` / token expired** — codex-reset refreshes OAuth tokens
automatically (and persists rotation). If the refresh token itself is expired,
reused, or revoked, the error tells you which — sign in again with
`codex login` or `codex-auth login`.

**A keyring-backed `auth.json` is not found** — credential storage is
file-based only; see [Supported auth modes and credential storage](#supported-auth-modes-and-credential-storage).

**`Secondary limit: unavailable`** — not an error. OpenAI retired the 5-hour
rolling window; most plans now report a single weekly (or daily/monthly)
window, and absent windows render as unavailable. If OpenAI reintroduces a
short window, labels pick it up automatically from the reported duration.

**A personal-access-token (PAT) account is missing** — PAT accounts are
verified against OpenAI's whoami endpoint during discovery; if that call fails
(expired/revoked PAT, network), the account is skipped with a warning on
stderr.

**`429` responses** — the error carries the server's `Retry-After`; wait and
rerun.

**Where do redeemed credits go?** — consume is idempotent: a retry after a
timeout reuses the original request id, so an ambiguous failure cannot silently
spend a second credit. See [Idempotent redemption](#idempotent-redemption).

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | Success                                       |
| 1    | General error                                 |
| 2    | Auth error (no accounts found, token expired) |
| 3    | API/network error                             |

## Requirements

- Node.js >= 22.13.0
- [Codex CLI](https://github.com/openai/codex) installed and logged in
- [codex-auth](https://github.com/Loongphy/codex-auth) for account management (recommended)

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and security practices.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and PR process.

### Maintaining the upstream contract

`test/fixtures/upstream-manifest.json` is the machine-readable wire contract,
generated from a pinned openai/codex checkout — never edit it by hand:

```bash
git clone --filter=blob:none --no-checkout --depth 1 \
  https://github.com/openai/codex.git /tmp/codex-upstream
cd /tmp/codex-upstream && git sparse-checkout set codex-rs && git checkout
cd <codex-reset checkout> && npm run manifest -- --src /tmp/codex-upstream
```

`test/upstream-contract.test.ts` asserts this tool's request boundary against
the manifest, and re-extracts it live when `/tmp/codex-upstream` (or
`$CODEX_UPSTREAM_DIR`) exists. A weekly non-blocking
[`upstream-drift`](.github/workflows/upstream-drift.yml) workflow regenerates
the manifest from upstream HEAD and opens an issue on drift.

## Roadmap

### Next — Watch & Auto

- **`codex-reset watch`** — Live TUI dashboard with real-time usage bars, credit countdown timers, auto-refresh every 30s, press `r` to reset
- **`codex-reset auto`** — Auto-reset daemon with configurable thresholds (`--threshold-7d 90`), background mode, systemd service support
- **`codex-reset notify`** — Push notifications via Telegram (`--telegram <token:chat_id>`), Discord webhooks, and OS native (`--desktop`)
- **`codex-reset history`** — Local reset log at `~/.codex-reset/history.jsonl`
- **`codex-reset doctor`** — Diagnostics: auth validity, API connectivity, config check
- **`codex-reset config`** — Persistent config for notification prefs, thresholds, default account, custom API base URL

### Later — Power features

- **`codex-reset alerts`** — Credit expiring soon warnings, usage critical alerts, auto-reset triggered notifications
- **`codex-reset expire`** — Show credits expiring within N days, sorted by urgency
- **Shell completions** — bash, zsh, fish, PowerShell
- **`--watch` flag on `list`** — Continuous refresh mode without full TUI

## License

[MIT](./LICENSE) © 2026 codex-reset contributors
