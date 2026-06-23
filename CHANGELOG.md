# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for v0.2

- `watch` command — live TUI dashboard with real-time usage bars and credit countdowns
- `auto` command — auto-reset daemon with configurable thresholds
- `notify` command — push notifications (Telegram, Discord, desktop)
- `history` command — local reset log
- `doctor` command — diagnostics
- `config` command — persistent configuration

### Planned for v0.3

- `alerts` command — credit expiry and usage critical alerts
- `expire` command — credits expiring within N days
- Shell completions (bash, zsh, fish, PowerShell)
- `--watch` flag on `list` for continuous refresh

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
