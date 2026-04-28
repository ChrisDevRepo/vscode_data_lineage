# Unit tests

> Folder inventory and descriptions live in [`../README.md`](../README.md).
> Canonical test strategy lives in [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
> This file covers only folder-specific notes for `tests/unit/`.

## Tiers (commands defined in `package.json`)

| Tier | Command | What runs |
|------|---------|-----------|
| Core | `npm test` | Parser, dacpac, graph, DMV, snapshot, AI tool registration, repeat-reject guard, classification, session-stale, schema-boundary, message envelope, SM robustness, refine loop |
| AI-heavy | `npm run test:unit:ai` | NavigationEngine + cascade + bipartite + supplement |
| Hooks (vitest) | `npm run test:hooks` | React hook tests under `tests/unit/hooks/` |
| Snapshot | `npm run test:snapshot` | Parser baseline TSV (refresh: `:update`) |
| Integration | `npm run test:integration` | Live SQL Server (requires `.env`) |

## Conventions

- Plain Node tests use the helpers in [`helpers/testUtils.ts`](helpers/testUtils.ts) (`assert`, `assertEq`, `printSummary`, `rootPath`).
- React hook tests use vitest + `@testing-library/react` (see [`../../vitest.config.ts`](../../vitest.config.ts)).
- AI behavior beyond pure-function surface (prompt content, classification semantics, narrative quality) is verified through UAT cases under [`../cases/`](../cases/), not unit tests — there is no in-process LM to assert against.

## Mandatory pre-merge gates

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` passes
- [ ] `npm run test:snapshot` zero diff (or `:update` only when the change is intentional and documented in commit message)

## Test data

Only AdventureWorks dacpacs are allowed in [`../fixtures/`](../fixtures/). Customer/proprietary data must never be committed (see [`../../.claude/rules/test-data.md`](../../.claude/rules/test-data.md)).
