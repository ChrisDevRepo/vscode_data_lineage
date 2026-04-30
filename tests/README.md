# Tests

**Full testing strategy, tier commands, fixture policy, and snapshot-baseline protocol live in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).** This README covers only folder-specific notes.

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
│   ├── ai-tool-registration.test.ts       # manifest ↔ registration guard (bi-directional)
│   ├── repeat-reject-guard.test.ts        # Idempotency counter — abort on 3 identical failures
│   ├── classification.test.ts             # Classification axis lock + sections[] validation
│   ├── session-stale.test.ts              # Stale-session detection
│   ├── start-exploration-schema.test.ts   # Zod boundary for start_exploration
│   ├── messageEnvelope.test.ts            # Sliding-wipe envelope contract
│   ├── navigation-engine.test.ts          # NavigationEngine lifecycle + memory
│   ├── navigation-engine-cascade.test.ts  # Cascade-prune guard logic
│   ├── navigation-engine-bipartite.test.ts # Bipartite agenda rule
│   ├── navigation-engine-supplement.test.ts # Supplement-agenda flow
│   ├── sm-robustness.test.ts              # SM scope robustness + present_result prune regression
│   ├── chatResponseWriter.test.ts         # ChatResponseStream lifecycle (cancel, close)
│   ├── refine-loop.test.ts                # Discovery-phase refinement loop: classifier, exclusion axes, getScopeSummary, classifyForRefine, renderScopeSummaryMd
│   ├── transient-retry.test.ts            # Transient-network classifier guarding the LM-call retry loop
│   ├── column-flow-validation.test.ts     # CT column_flow validation: required/prune/out_col/contributor checks; shouldSmInline CT guard; supplement propagation
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   └── hooks/                             # React hook unit tests (vitest)
│
├── fixtures/                              # Static test data (committed)
│   ├── AdventureWorks2025_AI.dacpac       # Primary test fixture
│   ├── graph-baseline-aw.json             # Frozen ground-truth
│   └── aw-baseline.tsv                    # Parser snapshot baseline
│
└── integration/                           # Live SQL Server tests (.env required)
    └── integration-db.test.ts             # DB pipeline tests
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
