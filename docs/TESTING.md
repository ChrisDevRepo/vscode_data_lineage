# Testing

Single source of truth for how this extension is tested. Every other file (`CONTRIBUTING.md`, `TECHNICAL_ARCHITECTURE.md`, `tests/README.md`) links here rather than duplicating tiers or commands.

## Tiers at a glance

| Tier | Folder | Command | Runs in | Scope |
|---|---|---|---|---|
| **Unit (logic)** | `tests/unit/` | `npm run test:unit` | Node (`tsx`) | Pure parsing, graph building, extractors, stores |
| **Unit (AI)** | `tests/unit/` | `npm run test:unit:ai` | Node (`tsx`) | Navigation engine, bipartite rule, supplement, tool registration |
| **Hooks** | `tests/unit/hooks/` | `npm run test:hooks` | Vitest (jsdom) | React hook behavior |
| **Snapshot baseline** | `tests/unit/snapshot-aw-baseline.ts` + `tests/fixtures/aw-baseline.tsv` | `npm run test:snapshot` (diff) / `npm run test:snapshot:update` (refresh) | Node (`tsx`) | Full parse of every SP in the AdventureWorks dacpacs; exits non-zero on any dependency diff |
| **Integration (DB)** | `tests/integration/` | `npm run test:integration` | Node (`tsx`) | Live SQL Server / Azure SQL / Fabric DW / Synapse connection + DMV extraction (requires `.env`) |
| **End-to-end** | `tests/e2e/` | `npm run test:e2e` | `@vscode/test-electron` | Launches an Extension Development Host and drives the chat / webview surfaces |

The chained script `npm test` runs the core unit suites sequentially. Heavy AI tests are split out into `npm run test:unit:ai` so they can be iterated independently.

## Triggering

| When | Run |
|---|---|
| While editing any TS file | `npx tsc --noEmit` |
| Changing parser rules (`assets/defaultParseRules.yaml`) | `npm run test:snapshot` — **must** stay green; refresh with `npm run test:snapshot:update` only after confirming the diff is an intended improvement |
| Changing AI prompts, tool descriptions, templates | `npm run test:unit:ai` |
| Changing webview / React state | `npm run test:hooks` |
| Before pushing a branch | `npm test` |
| Before tagging a release | `npm test && npm run test:e2e && npm run test:snapshot` |

## Parser snapshot protocol (mandatory on any `assets/*.yaml` change)

Zero regressions allowed. One rule change at a time.

```bash
npm run test:snapshot               # compare current parse vs tests/fixtures/aw-baseline.tsv
# if the diff is intentional and verified:
npm run test:snapshot:update        # regenerate the baseline
git add tests/fixtures/aw-baseline.tsv && git commit
```

- A **lost dependency** is a regression — blocked.
- A **gained dependency** needs a one-line justification in the commit message before `:update` is run.
- Unit tests alone are not sufficient. The snapshot runs every stored procedure in both committed dacpacs (AdventureWorks classic + SDK-style).

## Integration DB tests — setup

`npm run test:integration` connects to a live SQL Server instance and exercises DMV-based ingestion end-to-end.

Requirements:

1. Place a `.env` at the repo root with:
   ```env
   DB_SERVER=<host>
   DB_USER=<user>
   DB_PASSWORD=<password>
   DB_DATABASE_AW=<AdventureWorks OLTP db>
   DB_DATABASE_AW_DW=<AdventureWorks DW db>
   ```
2. The account needs `db_owner` on both databases and `GRANT VIEW SERVER STATE TO <user>` so DMV queries can read compile-time dependencies.
3. TCP/IP must be enabled and Mixed Mode authentication on the SQL Server instance.

DMV schema qualification: only schema-qualified references are detected. `WHERE d.referenced_schema_name IS NOT NULL` in `assets/dmvQueries.yaml` gates this — unqualified references are not resolved.

## Test fixtures

- **Only AdventureWorks** may live under `test/` or `tests/fixtures/`.
  - `test/AdventureWorks.dacpac` (classic / SSDT)
  - `test/AdventureWorks_sdk-style.dacpac` (SDK-style, Fabric DW target)
- **Never** commit customer dacpacs, customer schema names, or customer data. Use `assets/demo.dacpac` (AdventureWorks) for the demo path; keep any customer dacpacs out of the tree entirely.

## Mocking policy

- Unit tests run against real fixture files — no database mocks for parsing or graph-building.
- Integration tests always hit a live DB — never mock `mssql` clients.
- Hook tests may mock VS Code APIs; React components render under jsdom.

## Coverage gaps (known)

Documented for honesty — not a commitment.

- **Prompt builders untested.** `src/ai/prompts.ts` (15 exported builders) and `src/ai/smPrompts.ts` (`buildModeBlock`) are exercised only indirectly through navigation-engine tests; only `buildGeneralSystemPrompt` and `buildModeBlock` are imported anywhere (by the e2e eval proxy). One snapshot test per builder + condition would pin prompt output against silent drift.
- **Diagnostics module.** `src/ai/diagnostics.ts` (stateful, emits the structured `[AI] [Hop N]` line) has no direct unit test — verified only via grep references inside `sm-robustness.test.ts` and `navigation-engine.test.ts`.
- **History compaction.** `src/ai/historyManager.ts` has no direct unit test — sliding-wipe semantics rely on integration coverage.
- **Tool policy filter.** `src/ai/toolPolicy.ts` (per-phase tool exposure) has no direct test; phase-filter regressions would only surface in e2e.
- **Webview components.** `src/components/*` covered only indirectly via the five hook tests in `tests/unit/hooks/`. No `tests/unit/components/` folder; React Flow node/edge renderers, filter panels, and the AI preview surface have no isolated tests.
- **Bridge contract round-trip.** `src/engine/shared/bridgeContract.ts` Zod schemas have no test that round-trips every message variant.
