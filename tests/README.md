# Testing Framework

*This guide is for Developers maintaining the extension. For user-facing feature documentation, see `docs/`.*

Multi-tier test infrastructure for the Data Lineage VS Code extension. Tests are organized by environment requirement and verification method.

| Tier | Location | Runner | Purpose | When |
|------|----------|--------|---------|------|
| **Unit (Logic)** | `tests/unit/*.test.ts` | `tsx` | Pure deterministic logic (parsing, algorithms) | CI, pre-commit |
| **Unit (Baseline)**| `tests/unit/*-aw.test.ts` | `tsx` | High-fidelity verification vs. frozen snapshots | CI, regression |
| **Integration** | `tests/integration/` | `tsx` | Live SQL Server pipeline (.env required) | Local only |
| **E2E** | `tests/e2e/` | `@vscode/test-electron` | VS Code integration smoke tests | Local only |
| **Eval (AI)** | `tests/eval/` + `test-internal/ai-test-server.ts` | `tsx` + Haiku agent | 4-case baseline via HTTP bridge (POST /gate for `confirm_sm_start`) | Local only |

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
│   ├── sm-robustness.test.ts              # SM scope robustness + enrich_view prune regression
│   ├── working-set.test.ts                # PathFrame + BranchLocal selection per hop
│   ├── chatResponseWriter.test.ts         # ChatResponseStream lifecycle (cancel, close)
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
├── cases/                                 # 4-case baseline (see tests/cases/README.md)
│   ├── EVAL-RUBRIC.md                     # Interim scoring rubric
│   ├── bb-inline-q1-vproduct.md
│   ├── bb-q1-employee.md
│   ├── ct-inline-q1-jobtitle.md
│   ├── ct-q1-totalrevenue.md
│   (18 archived cases live in tmp/cases-archive/ — gitignored, parked for post-UAT phase)
│
├── eval/                                  # Eval runner (entry point: run.py)
│   ├── agent-prompt.template.txt
│   ├── run.py
│   ├── validate.py
│   └── extract.py
│
└── e2e/                                   # Runs inside VS Code extension host
    └── suite/                             # Integration smoke tests (non-eval)
```

The HTTP bridge that evals talk to (`test-internal/ai-test-server.ts`) exposes `lineage_*` tools, `/session`, `/filter`, and `/gate` (resolves the `confirm_sm_start` gate — harness equivalent of the user typing "yes"/"no" in chat). See `.claude/skills/eval-loop/SKILL.md` for the full flow.

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
