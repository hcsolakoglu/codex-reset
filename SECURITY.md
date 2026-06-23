# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

Please report vulnerabilities through GitHub Security Advisories or by opening a private security issue with the repository owner.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within 48 hours.

## Scope

This project handles OAuth tokens for OpenAI/ChatGPT accounts. Security considerations:

- Tokens are read from `~/.codex/accounts/*.auth.json` (managed by [codex-auth](https://github.com/Loongphy/codex-auth))
- Tokens are never written to disk by this tool
- Tokens are never logged or printed
- All API requests use HTTPS
- No telemetry or analytics are collected
- Zero runtime dependencies reduces supply chain risk

## Best practices for users

- Keep your `~/.codex/` directory permissions restrictive (`chmod 700`)
- Do not share your auth files
- Use `codex-auth` for token management and refresh
- Report suspicious activity immediately
