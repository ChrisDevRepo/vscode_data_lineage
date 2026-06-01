# Unit tests

> Folder inventory and descriptions live in [`../README.md`](../README.md).
> Canonical test strategy lives in [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
> This file covers only folder-specific notes for `tests/unit/`.

## Tiers (commands defined in `package.json`)

| Tier | Command | What runs |
|------|---------|-----------|
| Full unit | `npm test` | `test:core` + `test:support` + `test:ui` |
| Core | `npm run test:core` | Parser + BFS/orchestration |
| Parsing | `npm run test:parser` | Parser edge cases, SQL fixtures, parser snapshot baseline |
| BFS / orchestration | `npm run test:bfs` | Graph analysis, NavigationEngine, traversal/schema guards |
| Support | `npm run test:support` | Utility, policy, support-contract, and support-hook tests |
| UI | `npm run test:ui` | React hook and component tests matched by `vitest.config.ts` |
| Baseline | `npm run test:baseline` | Parser TSV + graph-analysis JSON regression net |
| Snapshot | `npm run test:snapshot` | Parser baseline TSV (refresh: `:update`) |
| Discovery audit | `npm run test:list` | Lists Vitest-discovered `tests/unit/**/*.test.ts(x)` membership |

## Conventions

- Plain Node tests use the helpers in [`helpers/testUtils.ts`](helpers/testUtils.ts) (`assert`, `assertEq`, `printSummary`, `rootPath`) and run through the Vitest node tier runners under [`runners/`](runners/).
- New top-level `tests/unit/*.test.ts` files are discovered into the support tier by default. Promote them into parser or BFS by adding them to the corresponding tier runner.
- React hook/component tests use vitest + `@testing-library/react` and must match the include patterns in [`../../vitest.config.ts`](../../vitest.config.ts).
- AI behavior beyond pure-function surface (prompt content, classification semantics, narrative quality) is verified through UAT baseline captures (`tmp/baseline/`), not unit tests — there is no in-process LM to assert against.

## Mandatory pre-merge gates

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `npm run test:snapshot` zero diff (or `:update` only when the change is intentional and documented in commit message)

## Test data

Only AdventureWorks dacpacs are allowed in [`../fixtures/`](../fixtures/). Customer/proprietary data must never be committed; see the repository security policy in [`../../AGENTS.md`](../../AGENTS.md).
