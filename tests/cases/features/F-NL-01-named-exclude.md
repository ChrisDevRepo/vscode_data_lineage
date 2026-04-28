# F-NL-01-named-exclude

## Question

> Trace upstream from `[ai].[FactSalesReport]` depth 3, but ignore the procedures `uspLogError`, `uspPrintError`, and `RECON` — those aren't in scope for this analysis.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Discovery → NL-named exclusion → excludeNodeIds[] |
| Persona | analyst |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome

| Field | Value |
|-------|-------|
| `start_exploration` carries `excludeNodeIds[]` | yes |
| `excludeNodeIds[]` resolves all 3 named identifiers | yes |
| `excludeTypes[]` | empty (user named identifiers, NOT a type-blanket) |
| Required tools | lineage_search_objects (to resolve names), lineage_start_exploration |

## Required Nodes (post-exclusion)

- [ai].[FactSalesReport]
- Other upstream nodes — but NONE of the excluded ids.

## Forbidden Nodes

- [dbo].[uspLogError], [dbo].[uspPrintError], [ai].[RECON] (or wherever RECON resolves) — must be absent.

## Optimal Path

1. AI receives the question. Recognizes user named 3 identifiers as exclusions.
2. AI calls `lineage_search_objects({query:'uspLogError'})` to resolve to `[dbo].[uspLogError]` (similarly for the other two).
3. AI calls `lineage_start_exploration` with `excludeNodeIds: ['[dbo].[uspLogError]', '[dbo].[uspPrintError]', '[ai].[RECON]']`.
4. Engine `init()` validates each id resolves to a real node (case-insensitive); if any unresolved, returns `unknown_node_ids` (covered by F-NL-03).

## Verification Rules

- Bridge JSONL contains `lineage_search_objects` calls before `lineage_start_exploration`.
- `lineage_start_exploration.input.excludeNodeIds` contains 3 resolved schema-qualified ids.
- `lineage_start_exploration.input.excludeTypes` is empty / absent.
- Final `result_graph.nodes[]` contains zero of the excluded ids.
- `[AI] [NL] extracted excludeNodeIds=[...]` log line emitted (per `logging.md`).

## Engine guards exercised

- `nl_filter_overgeneralized` does NOT fire (correctly).
- `unknown_node_ids` does NOT fire (resolved successfully).

## Harness

Real-Haiku discovery turn required (canned orchestrator's heuristics likely won't model the search-then-exclude flow).

## Evaluation Notes

Tests the canonical NL-name → `excludeNodeIds` translation. Counterpart to F-NL-02 (overgeneralization) and F-NL-03 (unknown id).
