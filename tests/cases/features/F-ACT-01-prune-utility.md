# F-ACT-01-prune-utility

## Question

> Build a bidirectional lineage graph around `[HumanResources].[Employee]` with depth 2. Prune any utility / error-handling objects so they don't appear in the result.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Active → AI applies prune verdict for utility branches |
| Persona | DBA |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |

## Expected Outcome

| Field | Value |
|-------|-------|
| `submit_findings(verdict=prune)` calls | ≥ 3 (one per utility node hit) |
| Pruned nodes absent from `present_result.nodes[]` | yes |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |

## Required Nodes

- [HumanResources].[Employee]
- At least one HR proc that *would* route to the utility nodes (e.g. `uspUpdateEmployeeHireInfo` calls `uspLogError` in CATCH).

## Forbidden Nodes (must be pruned)

- [dbo].[uspLogError]
- [dbo].[uspPrintError]
- [dbo].[ErrorLog]

## Optimal Path

1. start_exploration → gate → approve.
2. Hop on Employee → analyze.
3. Hop on uspUpdateEmployeeHireInfo → analyze; routes neighbor `uspLogError` (caught from DDL) with sub-question marking it as a prune candidate.
4. Hop on uspLogError → AI emits `submit_findings(verdict='prune', focus_node_id='[dbo].[uspLogError]')`.
5. Same for uspPrintError, ErrorLog.
6. Synthesis. Pruned ids absent from `present_result.nodes[]` and `sections[].node_ids[]`.

## Verification Rules

- ≥3 `submit_findings` calls with `verdict: 'prune'`.
- `result_graph.nodes[]` contains ZERO of the utility nodes.
- Bridge JSONL `[AI] [Hop N]` log lines show `verdict=prune` for each utility hop.
- `tally=R/P/I` log line — Pruned tally ≥3.
- AI uses `prune_neighbors` when applicable (neighbor-level cascade prune for tables/views, see `BLOCK.pruningProtocol`).

## Engine guards exercised

- Verdict=prune handling in `submit_findings`.
- `prune_neighbors` cascade for non-bodied neighbors.
- Pruned ids excluded from synthesis input (`detail_slots[]` only contains analyzed nodes — pruned nodes carry minimal metadata).

## Harness

Runs end-to-end with current auto-orchestrator if real-Haiku capture turns are dispatched (canned orchestrator's per-node response decides verdict by name pattern). Without real-Haiku capture, the auto-orchestrator's default heuristic should classify `*log*` / `*error*` nodes as prune — verify it does.

## Known Limitations

The AI's decision to prune depends on:
1. The user's instruction explicitly authorizing prune ("Prune any utility / error-handling objects").
2. The DDL of the utility nodes containing no business logic (just logging) — the AI inspects via routing.
3. The active-phase prompt's verdict rules (smPrompts.ts BLOCK.verdictCategories).

## Evaluation Notes

Tests mechanical prune behavior. Different from `F-ACT-02` which tests `pass` (wire-only) verdict.
