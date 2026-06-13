# Tests

**Full testing strategy, tier commands, fixture policy, and snapshot-baseline protocol live in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).** This README covers only folder-specific notes.

## High-priority regression net

Three categories carry the suite. Everything else is a narrower guard.

| Category | Files | Run with |
|---|---|---|
| **Parsing** | `parser-edge-cases.test.ts`, `tsql-complex.test.ts`, `snapshot-aw-baseline.ts` | `npm run test:parser` |
| **BFS / orchestration** | `graphBuilder.test.ts`, `graphAnalysis.test.ts`, `graph-analysis-aw.test.ts`, `schemaProjection.test.ts`, `graphDisplayMode.test.ts`, `navigation-engine*.test.ts`, `refine-loop.test.ts`, `start-exploration-schema.test.ts`, `submit-findings-schema.test.ts`, `present-result-closure.test.ts`, `column-flow-validation.test.ts` | `npm run test:bfs` |
| **Baseline** | `snapshot-aw-baseline.ts` (parser TSV), `graph-analysis-aw.test.ts` (NetworkX-verified graph JSON) | `npm run test:baseline` |

`npm test` is the full unit gate: it runs `test:core`, `test:support`, and `test:ui`. `test:graph` and `test:hooks` remain compatibility aliases for `test:bfs` and `test:ui`.

Auto-discovery rules:
- Top-level `tests/unit/*.test.ts` files are auto-discovered into the support tier unless they are explicitly assigned to the parser or BFS tier runners.
- React hook/component tests are discovered from `vitest.config.ts`.
- Use `npm run test:list` to inspect current tier membership for `tests/unit/**/*.test.ts(x)`.

## Current timing baseline

Keep the lean tiers near these current local durations. Re-measure after material tier changes.

| Tier | Current duration |
|---|---|
| `npm run test:parser` | about 2s |
| `npm run test:bfs` | about 12s |
| `npm run test:support` | about 4s |
| `npm run test:ui` | about 13s |

## Folder layout

```
tests/
├── README.md                              # This file
│
├── unit/                                  # Unit tests (Vitest node + jsdom tiers)
│   ├── README.md                          # Tier commands and pre-merge gates
│   ├── tsconfig.json                      # TypeScript config for unit tests
│   ├── runners/                           # Tier runners for parser/BFS/support/baseline/snapshot
│   │
│   │  — Parsing & extraction —
│   ├── parser-edge-cases.test.ts          # SQL parser regex edge cases
│   ├── tsql-complex.test.ts               # Real-world SQL patterns (55 fixture files)
│   ├── dacpacExtractor.test.ts            # ZIP/XML extraction, edge integrity
│   ├── dmvExtractor.test.ts               # DMV → model building
│   │
│   │  — Graph engine, schema view & BFS —
│   ├── graphBuilder.test.ts               # Graph construction, synthetic BFS traces
│   ├── schemaProjection.test.ts           # Pure expanded-schema-view partition rules
│   ├── graphDisplayMode.test.ts           # Initial view seed plus explicit Object / Schema render-mode derivation
│   ├── graphAnalysis.test.ts              # Algorithmic edge cases (maxSize, cycles)
│   ├── schemaAdjacency.test.ts            # Schema-pair adjacency / bridge aggregation
│   ├── renderConnectivity.test.ts         # Rendered-connectivity computation
│   ├── legendDerivation.test.ts           # Legend derivation from the rendered set
│   │
│   │  — Baseline regression —
│   ├── snapshot-aw-baseline.ts            # Parser regression baseline (TSV)
│   ├── graph-analysis-aw.test.ts          # AW graph-analysis baseline (Snapshot Pattern)
│   │
│   │  — SM / NavigationEngine invariants —
│   ├── navigation-engine.test.ts          # Lifecycle, tally, route rejection, archive counter, complete-flag contract
│   ├── navigation-engine-cascade.test.ts  # Cascade-prune + connector-closure guard + viewPrune.prunePreserveOnly
│   ├── navigation-engine-bipartite.test.ts # Bipartite agenda rule
│   ├── navigation-engine-supplement.test.ts # Supplement-agenda flow
│   ├── navigation-engine-synthesis-regression.test.ts # Reject diagnostics + synthesis grounding invariants
│   ├── present-result-closure.test.ts     # present_result add/prune closed-graph validation helper
│   ├── column-flow-validation.test.ts     # CT column_flow validation
│   ├── prompt-composition.test.ts         # Prompt assembly invariants
│   ├── ai-preview-rendering.test.ts       # AI preview markdown / math rendering guard
│   │
│   │  — Boundary guards (Zod / policy / state) —
│   ├── classification.test.ts             # Classification axis lock + AiSession setter
│   ├── start-exploration-schema.test.ts   # Zod boundary for start_exploration
│   ├── messageEnvelope.test.ts            # Sliding-wipe envelope contract
│   ├── toolPolicy.test.ts                 # Tool × phase policy
│   ├── submit-findings-schema.test.ts     # submit_findings mode schema guard
│   ├── ai-tool-registration.test.ts       # Manifest ↔ registration guard
│   ├── schemaColors.test.ts               # Stable schema color allocation
│   ├── repeat-reject-guard.test.ts        # Idempotency counter (abort on 3 identical failures)
│   ├── transient-retry.test.ts            # Transient-network classifier
│   ├── chatResponseWriter.test.ts         # ChatResponseStream lifecycle (cancel, close)
│   ├── notifications.test.ts              # notifyError / notifyWarning output-channel + toast contract
│   ├── log-normalization.test.ts          # Output-channel single-line normalization guard
│   ├── refine-loop.test.ts                # Discovery-phase refinement loop
│   ├── followup-confirmation.test.ts      # Completed-phase follow-up confirmation routing
│   ├── projectStore.test.ts               # Migration, serialization
│   │
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   ├── components/                        # React component unit tests (vitest)
│   │   ├── ai-description-overlay.test.tsx
│   │   ├── detail-search-sidebar.test.tsx
│   │   ├── graph-canvas-schema-interactions.test.tsx
│   │   ├── search-with-autocomplete.test.tsx
│   │   └── schema-node.test.tsx
│   └── hooks/                             # React hook unit tests (vitest)
│       ├── keyboardShortcuts.test.ts
│       ├── modeCapabilities.test.ts       # Display-mode capability flags (support-ui tier)
│       ├── save-project.test.tsx
│       ├── useDacpacLoader.routing.test.tsx
│       ├── useExpandedSchemaView.test.ts  # Expanded Schema View state/guard extraction
│       ├── useGraphology.test.ts
│       └── useInteractiveTrace.test.ts
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
