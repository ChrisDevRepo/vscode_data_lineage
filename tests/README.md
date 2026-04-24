# Tests

**Full testing strategy, tier commands, fixture policy, and snapshot-baseline protocol live in [`../docs/TESTING.md`](../docs/TESTING.md).** This README covers only folder-specific notes.

## Folder layout

```
tests/
├── README.md                              # This file
│
├── unit/                                  # Plain Node.js tests (CI-safe)
│   ├── dacpacExtractor.test.ts            # ZIP/XML extraction, edge integrity
│   ├── graphBuilder.test.ts               # Graph construction, synthetic BFS traces
│   ├── graphAnalysis.test.ts              # Algorithmic edge cases (maxSize, cycles)
│   ├── graph-analysis-aw.test.ts          # AW baseline verification (Snapshot Pattern)
│   ├── parser-edge-cases.test.ts          # SQL parser regex edge cases
│   ├── tsql-complex.test.ts               # Real-world SQL patterns
│   ├── dmvExtractor.test.ts               # DMV → model building
│   ├── projectStore.test.ts               # Migration, serialization
│   ├── snapshot-aw-baseline.ts            # Parser regression baseline (TSV)
│   ├── ai-tools.test.ts                   # AI tool pure-function tests
│   ├── ai-tool-registration.test.ts       # manifest ↔ registration guard
│   ├── navigation-engine.test.ts          # NavigationEngine lifecycle + memory
│   ├── navigation-engine-cascade.test.ts  # Cascade-prune guard logic
│   ├── navigation-engine-bipartite.test.ts # Bipartite agenda rule
│   ├── navigation-engine-supplement.test.ts # Supplement-agenda flow
│   ├── sm-robustness.test.ts              # SM scope robustness + present_result prune regression
│   ├── chatResponseWriter.test.ts         # ChatResponseStream lifecycle (cancel, close)
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   └── hooks/                             # React hook unit tests (vitest)
│
├── fixtures/                              # Static test data (committed)
│   ├── AdventureWorks2025_AI.dacpac       # Primary test fixture
│   ├── graph-baseline-aw.json             # Frozen ground-truth
│   └── aw-baseline.tsv                    # Parser snapshot baseline
│
├── integration/                           # Live SQL Server tests (.env required)
│   └── integration-db.test.ts             # DB pipeline tests
│
└── e2e/                                   # Runs inside VS Code extension host
    └── suite/                             # Integration smoke tests
```

## Snapshot baseline pattern

To ensure accuracy without complex external dependencies in the main pipeline:

1. **Establish**: One-time verification using an external reference implementation.
2. **Snapshot**: Capture verified results into a static JSON / TSV fixture (`tests/fixtures/`).
3. **Assert**: TypeScript tests load the snapshot and compare internal engine results.
4. **Refresh**: Only re-run external verification if core graph invariants change significantly.

## Related

- [`../docs/TESTING.md`](../docs/TESTING.md) — canonical test strategy
- [`../docs/AI_ARCHITECTURE.md`](../docs/AI_ARCHITECTURE.md) — NavigationEngine spec
- [`../docs/FEATURES.md`](../docs/FEATURES.md) — user-facing feature guide
