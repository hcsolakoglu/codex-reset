# Contributing to codex-reset

Thanks for your interest in contributing! This guide covers the basics.

## Prerequisites

- Node.js >= 22.13.0
- npm

## Setup

```bash
git clone <repo-url>
cd codex-reset
npm install
```

## Development

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Watch mode
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint
npm run format       # Prettier format
npm test             # Run tests
```

## Code style

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- Prettier + ESLint enforced
- Zero runtime dependencies — Node.js built-ins only
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`

## Pull request process

1. Fork and create a feature branch: `git checkout -b feat/my-feature`
2. Write tests for new functionality
3. Ensure all checks pass: `npm run typecheck && npm run lint && npm test && npm run build`
4. Update CHANGELOG.md under `[Unreleased]`
5. Open a PR with a clear description

## Project structure

```
src/
  cli.ts          Entry point, arg parsing
  commands/       Command implementations (list, credits, reset)
  core/           Core logic (api, accounts, types)
  utils/          Utilities (colors, format, errors)
test/             Unit and integration tests
bin/              CLI wrapper
```

## License

MIT — see [LICENSE](./LICENSE)
