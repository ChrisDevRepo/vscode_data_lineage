# Tests

**Full testing strategy, tier commands, fixture policy, and snapshot-baseline protocol live in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).** This README covers only folder-specific notes.

## High-priority regression net

Three categories carry the suite. Everything else is a narrower guard.

| Category | Files | Run with |
|---|---|---|
| **Parsing** | `parser-edge-cases.test.ts`, `tsql-complex.test.ts` | `npm run test:parser` |
| **BFS / graph** | `graphBuilder.test.ts`, `graphAnalysis.test.ts` | `npm run test:graph` |
| **Baseline** | `snapshot-aw-baseline.ts` (parser TSV), `graph-analysis-aw.test.ts` (NetworkX-verified graph JSON) | `npm run test:baseline` |

`npm test` runs every file below. `npm run test:hooks` runs the vitest jsdom suite for React hooks.

## Folder layout

```
tests/
├── README.md                              # This file
│
├── unit/                                  # Plain Node.js tests (CI-safe)
│   ├── README.md                          # Tier commands and pre-merge gates
│   ├── tsconfig.json                      # TypeScript config for unit tests
│   │
│   │  — Parsing & extraction —
│   ├── parser-edge-cases.test.ts          # SQL parser regex edge cases
│   ├── tsql-complex.test.ts               # Real-world SQL patterns (55 fixture files)
│   ├── dacpacExtractor.test.ts            # ZIP/XML extraction, edge integrity
│   ├── dmvExtractor.test.ts               # DMV → model building
│   │
│   │  — Graph engine & BFS —
│   ├── graphBuilder.test.ts               # Graph construction, synthetic BFS traces
│   ├── graphAnalysis.test.ts              # Algorithmic edge cases (maxSize, cycles)
│   │
│   │  — Baseline regression —
│   ├── snapshot-aw-baseline.ts            # Parser regression baseline (TSV)
│   ├── graph-analysis-aw.test.ts          # AW graph-analysis baseline (Snapshot Pattern)
│   │
│   │  — SM / NavigationEngine invariants —
│   ├── navigation-engine.test.ts          # Lifecycle, tally, route rejection, archive counter, complete-flag contract
│   ├── navigation-engine-cascade.test.ts  # Cascade-prune + viewPrune.prunePreserveOnly
│   ├── navigation-engine-bipartite.test.ts # Bipartite agenda rule
│   ├── navigation-engine-supplement.test.ts # Supplement-agenda flow
│   ├── column-flow-validation.test.ts     # CT column_flow validation
│   │
│   │  — Boundary guards (Zod / policy / state) —
│   ├── classification.test.ts             # Classification axis lock + AiSession setter
│   ├── start-exploration-schema.test.ts   # Zod boundary for start_exploration
│   ├── messageEnvelope.test.ts            # Sliding-wipe envelope contract
│   ├── toolPolicy.test.ts                 # Tool × phase policy
│   ├── ai-tool-registration.test.ts       # Manifest ↔ registration guard
│   ├── repeat-reject-guard.test.ts        # Idempotency counter (abort on 3 identical failures)
│   ├── transient-retry.test.ts            # Transient-network classifier
│   ├── chatResponseWriter.test.ts         # ChatResponseStream lifecycle (cancel, close)
│   ├── refine-loop.test.ts                # Discovery-phase refinement loop
│   ├── projectStore.test.ts               # Migration, serialization
│   │
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   └── hooks/                             # React hook unit tests (vitest)
│       ├── save-project.test.tsx
│       ├── useDacpacLoader.routing.test.tsx
│       ├── useGraphology.test.ts
│       ├── useInteractiveTrace.test.ts
│       └── useOverviewMode.test.ts
│
├── fixtures/                              # Static test data
│   ├── AdventureWorks2025_AI.dacpac       # Primary test fixture (classic, Azure SQL) — gitignored exception
│   ├── AdventureWorks_sdk-style.dacpac    # SDK-style fixture (Fabric DW) — gitignored exception
│   ├── graph-baseline-aw.json             # Frozen ground-truth graph
│   ├── aw-baseline.tsv                    # Parser snapshot baseline
│   └── sql/targeted/                      # 55 targeted SQL fixture files for parser edge-case tests
                                            # (ANSI joins, CTEs, MERGE, INSERT-EXEC, APPLY, OUTPUT INTO,
                                            #  dynamic SQL, cursors, temp tables, UDFs, try/catch, etc.)
```

## Snapshot baseline pattern

To ensure accuracy without complex external dependencies in the main pipeline:

1. **Establish**: One-time verification using an external reference implementation.
2. **Snapshot**: Capture verified results into a static JSON / TSV fixture (`tests/fixtures/`).
3. **Assert**: TypeScript tests load the snapshot and compare internal engine results.
4. **Refresh**: Only re-run external verification if core graph invariants change significantly.

## Related

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — canonical test strategy
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — NavigationEngine spec
- [`../docs/FEATURES.md`](../docs/FEATURES.md) — user-facing feature guide
