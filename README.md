<div align="center">

# codex-reset

**Inspect and redeem Codex rate-limit reset credits from the command line**

[![npm](https://img.shields.io/npm/v/codex-reset.svg)](https://www.npmjs.com/package/codex-reset)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/codex-reset.svg)](https://nodejs.org)

</div>

---

## What it does

OpenAI may expose rate-limit reset credits for Codex accounts. `codex-reset`
lists those credits, shows current usage windows, and redeems a credit when the
backend says one is available.

Use it only with accounts you own or are authorized to operate. Availability is
determined by your account's live API response; the tool does not promise support
for any specific plan or account class.

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

# Reset an account (interactive picker)
codex-reset reset

# Reset all exhausted accounts, no prompts
codex-reset reset --all --yes
```

## Commands

### `codex-reset list`

Shows all discovered accounts with usage bars and credit count.

```
   1  main          <dev@example.com>       Plus      2 reset credits  reset available
      5h limit:             [██████████████████░░] 88% left (resets 10:12)
      Weekly limit:         [████████████████████] 100% left (resets 06:22 on 29 Jun)

   2  personal      <person@example.com>    Plus      1 reset credit   ok
      5h limit:             [████████████████████] 99% left (resets 11:44)
      Weekly limit:         [██████████████░░░░░░] 70% left (resets 07:30 on 30 Jun)

Accounts: 2  •  Credits available: 3  •  Exhausted: 0  •  Lowest left: 5h 88%, weekly 70%
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

Consumes a reset credit to clear your 5h and 7d rate-limit windows.

```bash
codex-reset reset              # interactive picker
codex-reset reset 2            # by list index
codex-reset reset me@example.com # by email
codex-reset reset --all        # reset all eligible accounts
codex-reset reset --all --yes  # no confirmation prompt
```

Output shows before/after comparison:

```
  ✓ Reset successful for dev@example.com
  Windows reset: 2

  5h limit:      [░░░░░░░░░░░░░░░░░░░░] 0% left → [████████████████████] 99% left
  Weekly limit:  [░░░░░░░░░░░░░░░░░░░░] 0% left → [████████████████████] 100% left
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

## How it works

1. **Account discovery**: Reads codex-auth multi-account files and falls back to official Codex CLI/Desktop `auth.json`
2. **Usage check**: Calls `GET /backend-api/wham/usage` to fetch current rate-limit windows
3. **Credit listing**: Calls `GET /backend-api/wham/rate-limit-reset-credits` to list individual credits
4. **Credit consumption**: Calls `POST /backend-api/wham/rate-limit-reset-credits/consume` with a UUID `redeem_request_id`

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

## Roadmap

### v0.2 — Watch & Auto

- **`codex-reset watch`** — Live TUI dashboard with real-time usage bars, credit countdown timers, auto-refresh every 30s, press `r` to reset
- **`codex-reset auto`** — Auto-reset daemon with configurable thresholds (`--threshold-7d 90`), background mode, systemd service support
- **`codex-reset notify`** — Push notifications via Telegram (`--telegram <token:chat_id>`), Discord webhooks, and OS native (`--desktop`)
- **`codex-reset history`** — Local reset log at `~/.codex-reset/history.jsonl`
- **`codex-reset doctor`** — Diagnostics: auth validity, API connectivity, config check
- **`codex-reset config`** — Persistent config for notification prefs, thresholds, default account, custom API base URL

### v0.3 — Power features

- **`codex-reset alerts`** — Credit expiring soon warnings, usage critical alerts, auto-reset triggered notifications
- **`codex-reset expire`** — Show credits expiring within N days, sorted by urgency
- **Shell completions** — bash, zsh, fish, PowerShell
- **`--watch` flag on `list`** — Continuous refresh mode without full TUI

## License

[MIT](./LICENSE) © 2026 codex-reset contributors
