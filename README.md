<div align="center">

# codex-reset

**Open-source CLI for inspecting Codex usage limits and safely redeeming OpenAI-issued rate-limit reset credits across one or multiple accounts.**

[![npm](https://img.shields.io/npm/v/codex-reset.svg)](https://www.npmjs.com/package/codex-reset)
[![npm downloads](https://img.shields.io/npm/dm/codex-reset.svg)](https://www.npmjs.com/package/codex-reset)
[![CI](https://github.com/hcsolakoglu/codex-reset/actions/workflows/ci.yml/badge.svg)](https://github.com/hcsolakoglu/codex-reset/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/codex-reset.svg)](https://nodejs.org)

[Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Security](#security) · [Contributing](#contributing)

</div>

---

`codex-reset` is an independent open-source companion for the official [OpenAI Codex CLI](https://github.com/openai/codex). It exposes account usage windows and OpenAI-issued reset credits in a scriptable terminal workflow, with multi-account discovery, JSON output, expiry tracking, and idempotent redemption safeguards.

It **does not create credits, bypass plan limits, increase quotas, or unlock access that an account does not already have**. Credit availability and reset scope come directly from the account's live OpenAI response.

## Why this project exists

Codex users can inspect usage from the official client, but automation and multi-account workflows need a small, auditable CLI surface. `codex-reset` focuses on that operational gap:

- inspect live Codex usage windows and remaining capacity
- list OpenAI-issued reset credits and expiration dates
- work with official single-account Codex auth and `codex-auth` multi-account setups
- redeem credits interactively or non-interactively with explicit confirmation
- produce stable JSON for scripts and automation
- preserve redemption idempotency across process restarts after ambiguous network failures

The project tracks the upstream Codex wire contract with a pinned machine-readable manifest and a weekly drift workflow. CI runs on Linux, macOS, and Windows across supported Node releases. npm releases use GitHub Actions OIDC trusted publishing with provenance.

## What it does

OpenAI grants some Codex accounts **rate-limit reset credits**. `codex-reset` makes those credits visible and redeemable from the terminal:

- **`list`** — show discovered accounts, live usage windows, remaining capacity, reset times, and credit counts
- **`credits`** — list individual credits with grant dates, expiry dates, countdowns, and reset scope
- **`reset`** — redeem a credit interactively, by account, or in batch, with before/after usage comparison

It refreshes supported OAuth credentials when needed and mirrors the official client's request boundary through upstream-contract tests.

Use it only with accounts you own or are authorized to operate.

## Why not just the Codex TUI?

The official Codex TUI can handle the signed-in account. `codex-reset` is aimed at visibility and automation around that flow:

| Capability | Codex TUI | `codex-reset` |
| --- | --- | --- |
| Multiple accounts at a glance | One at a time | Aggregates discovered accounts |
| Scriptable JSON output | Limited | Yes |
| Credit expiry tracking | Limited | Yes |
| Batch operation | No | `reset --all --yes` |
| Idempotent retry across CLI invocations | Session-scoped | Persisted redemption identity |
| Upstream contract drift check | N/A | Weekly automated check |

## Install

```bash
npm install -g codex-reset
```

Or run without a global install:

```bash
npx codex-reset list
```

## Quick start

```bash
# Show live Codex usage for discovered accounts
codex-reset list

# List available OpenAI-issued reset credits and expirations
codex-reset credits

# Redeem a credit with an interactive account picker
codex-reset reset

# Redeem for all currently eligible accounts without prompts
codex-reset reset --all --yes

# Machine-readable output
codex-reset list --json
```

## Commands

### `codex-reset list`

Shows discovered accounts with usage windows and credit counts. Window labels are derived from the backend response instead of being hard-coded to a particular plan shape.

```text
   1  main          <dev@example.com>       Plus      2 reset credits  reset available
      Weekly limit:        [██████████████████░░] 88% left (resets 22:35 on 22 Aug)
      Secondary limit:     unavailable

Accounts: 1  •  Credits available: 2  •  Exhausted: 0  •  Lowest left: Weekly 88%
```

### `codex-reset credits`

Shows each available reset credit with grant and expiry information.

```text
  dev@example.com (Plus)  2 available
    #b4f53a61d614  granted Jun 12, 2026  expires Jul 12, 2026  20d left
    #2815139a8ea0  granted Jun 18, 2026  expires Jul 18, 2026  26d left
```

### `codex-reset reset [query]`

Consumes a reset credit for the selected account when the live backend marks it eligible.

```bash
codex-reset reset
codex-reset reset 2
codex-reset reset me@example.com
codex-reset reset --all
codex-reset reset --all --yes
codex-reset reset --json --yes
```

`--json` never confirms a destructive operation by itself. Without `--yes`, non-interactive reset exits before a consume request is sent.

## Global options

| Flag | Description |
| --- | --- |
| `--json` | Machine-readable JSON output |
| `--help`, `-h` | Show help |
| `--version`, `-V` | Show version |
| `NO_COLOR=1` | Disable colored output |
| `FORCE_COLOR=1` | Force colored output |

## How it works

1. **Account discovery** — reads `codex-auth` multi-account files and falls back to the official Codex CLI/Desktop `auth.json` file.
2. **Usage inspection** — queries the live account usage endpoint and renders the windows returned by the backend.
3. **Credit listing** — queries the account's available rate-limit reset credits and their expiry/reset scope.
4. **Credit redemption** — sends the selected credit with a persisted `redeem_request_id` so retries of the same ambiguous redemption can reuse the same identity.

All network requests use HTTPS with existing supported Codex credentials. The project does not maintain its own account database and does not log credentials.

### Account discovery

`codex-reset` resolves Codex home in this order:

1. `CODEX_HOME` when set
2. `$HOME/.codex` on Linux/macOS
3. `%USERPROFILE%\.codex` on Windows when `HOME` is unavailable
4. Node's `os.homedir()/.codex` fallback

It checks:

- `accounts/*.auth.json` and `accounts/registry.json` from [`codex-auth`](https://github.com/Loongphy/codex-auth)
- `auth.json` from the official Codex CLI / Codex Desktop App

### Supported auth modes

| Auth mode | Behavior |
| --- | --- |
| `chatgpt` OAuth tokens | Supported, including refresh and token rotation persistence |
| `personalAccessToken` | Supported when account identity can be resolved by the upstream-compatible flow |
| API-key / agent-identity / Bedrock modes | Skipped because they do not expose ChatGPT plan usage/reset credits |
| Missing or unreadable credentials | Skipped with a warning |

File-backed Codex credentials are required. If the official CLI is configured for keyring-only storage, `codex-reset` cannot read those credentials.

## Redemption safety and idempotency

Credit consumption is destructive, so ambiguous failures are handled conservatively. Before a consume request, `codex-reset` persists the redemption identity to `{CODEX_HOME}/pending-redeem.<account>.json`.

- known success or a definitive client rejection clears the pending record
- timeout, connection reset, server error, or unknown success payload keeps it unresolved
- retrying the same account and credit within the bounded retry window reuses the original redemption identity

If the retry targets a different credit or the unresolved record is too old, the CLI warns before generating a fresh identity. The goal is to avoid silently spending a second credit after a network failure.

## Upstream compatibility

`codex-reset` intentionally treats the official [`openai/codex`](https://github.com/openai/codex) implementation as the upstream contract rather than inventing a parallel protocol.

`test/fixtures/upstream-manifest.json` is generated from a pinned Codex checkout and captures the request boundary used by this project. `test/upstream-contract.test.ts` checks the implementation against that manifest.

A weekly [`upstream-drift`](.github/workflows/upstream-drift.yml) workflow regenerates the manifest against upstream HEAD and opens an issue when the relevant contract changes.

This makes compatibility work visible, reviewable, and maintainable instead of relying on undocumented assumptions.

## Quality and supply-chain practices

The repository includes:

- TypeScript type checking and ESLint
- automated unit, API-boundary, reset-safety, HTTP transport, idempotency, E2E, and upstream-contract tests
- CI on Linux, Windows, and macOS with Node 22/24 coverage
- `npm pack --dry-run` and CLI smoke checks before release
- npm Trusted Publishing through GitHub Actions OIDC
- npm provenance on published releases
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and MIT licensing

## Troubleshooting

**No Codex accounts found**

Run `codex login` or `codex-auth login`, or point `CODEX_HOME` to the directory containing the supported auth files.

**Unauthorized / expired token**

The CLI attempts the same supported refresh flow used by the upstream client. If the refresh credential is revoked or expired, sign in again.

**A secondary limit is unavailable**

That is not necessarily an error. The CLI displays the windows actually returned for the account instead of assuming a fixed quota shape.

**HTTP 429**

The CLI reports the server retry guidance. Wait for the reported interval and rerun.

## Requirements

- Node.js >= 22.13.0
- OpenAI Codex CLI installed and authenticated
- `codex-auth` only if multi-account discovery is desired

## Security

This project handles authentication material that already exists on the local machine. Security-sensitive changes should be reviewed carefully.

See [SECURITY.md](./SECURITY.md) for the vulnerability-reporting process and security notes.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, testing, and pull-request expectations.

Useful contribution areas include:

- compatibility updates after upstream Codex changes
- additional regression and cross-platform coverage
- clearer diagnostics and account discovery
- safer automation surfaces
- documentation and reproducible bug reports

## Project status

The project is actively maintained as an independent community tool around Codex account usage and OpenAI-issued reset credits. It is **not an official OpenAI project** and is not endorsed by OpenAI.

For changes that affect authentication, usage reporting, or redemption semantics, compatibility is validated against the upstream Codex source and the repository's automated test suite.

## License

[MIT](./LICENSE) © 2026 codex-reset contributors
