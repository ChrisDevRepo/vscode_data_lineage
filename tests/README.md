# Testing Framework

Multi-tier test infrastructure for the Data Lineage VS Code extension. Tests are organized by environment requirement and verification method.

| Tier | Location | Runner | Purpose | When |
|------|----------|--------|---------|------|
| **Unit (Logic)** | `tests/unit/*.test.ts` | `tsx` | Pure deterministic logic (parsing, algorithms) | CI, pre-commit |
| **Unit (Baseline)**| `tests/unit/*-aw.test.ts` | `tsx` | High-fidelity verification vs. frozen snapshots | CI, regression |
| **Integration** | `tests/integration/` | `tsx` | Live SQL Server pipeline (.env required) | Local only |
| **E2E + Eval** | `tests/e2e/` | `@vscode/test-electron` | VS Code integration & AI behavior quality | Local only |

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
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   └── hooks/                             # React hook unit tests (vitest)
│
├── fixtures/                              # Static test data (committed)
│   ├── AdventureWorks2025_AI.dacpac       # Primary test fixture
│   ├── graph-baseline-aw.json             # Frozen ground-truth (Verified with NetworkX)
│   └── aw-baseline.tsv                    # Parser snapshot baseline
│
├── integration/                           # Live SQL Server tests (.env required)
│   └── integration-db.test.ts             # DB pipeline tests
│
└── e2e/                                   # Runs inside VS Code extension host
    └── suite/eval/                        # AI Assistant behavior evaluation
```

## Snapshot Baseline Pattern

To ensure accuracy without complex external dependencies (like Python/NetworkX) in the main pipeline, we use the **Snapshot Baseline Pattern**:

1.  **Establish**: One-time verification using an external "Gold Standard" library (e.g., NetworkX).
2.  **Snapshot**: Capture verified results into a static JSON fixture (`tests/fixtures/graph-baseline-aw.json`).
3.  **Assert**: TypeScript tests (`graph-analysis-aw.test.ts`) load the snapshot and compare internal engine results.
4.  **Refresh**: Only re-run external verification if core graph invariants change significantly.

## Running tests

```bash
# Full unit suite
npm test                    

# Focused analysis tests
npm run test:analysis       # Logic + AW Baseline

# AI behavior tests
npm run test:unit:ai        

# Integration (requires .env)
npm run test:integration    
```

## Related documentation

- `docs/AI_ARCHITECTURE.md` — unified NavigationEngine + two-tier memory technical spec
- `docs/FEATURES.md` — User-facing feature guide with algorithmic verification notes
- `tests/cases/EVAL-RUBRIC.md` — AI grading rubric
