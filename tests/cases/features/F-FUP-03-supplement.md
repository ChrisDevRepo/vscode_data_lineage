# F-FUP-03-supplement

## Question (turn 1)

> Trace upstream from `[ai].[FactSalesReport]` depth 2.

(Some upstream nodes at depth 3 are skipped — they appear in `deferred_questions`.)

## Question (turn 2 — supplement add)

> Now also include `[Sales].[SalesOrderHeader]` in the analysis — that's the upstream source I missed.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Follow-up → supplement add (deferred-question revival) |
| Persona | analyst |
| Difficulty | medium |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome

| Field | Value |
|-------|-------|
| Turn 2 tool call | `lineage_start_exploration` with `supplement: { nodeIds: ['[Sales].[SalesOrderHeader]'] }` (NOT a fresh exploration) |
| Engine status | `complete` → re-enters `exploring` for the supplement, then back to `complete` |
| Supplement hop count | 1 (single node added) |
| Forbidden tools (turn 2) | NEW `start_exploration` without `supplement` flag (would start fresh exploration) |
| Final `nodes[]` | turn 1 nodes ∪ {`[Sales].[SalesOrderHeader]`} |

## Required Nodes (turn 2)

- All turn 1 required nodes
- [Sales].[SalesOrderHeader] (newly added)

## Optimal Path

1. Turn 1: trace ends `completed`. `deferred_questions[]` may include nodes at the depth-2 boundary.
2. Turn 2: AI sees the user instruction "include X also".
3. AI calls `lineage_start_exploration({ supplement: { nodeIds: ['[Sales].[SalesOrderHeader]'] } })` — supplement path, NOT a fresh `origin`.
4. Engine `supplementAgenda(nodeIds)` extends agenda by 1 node, resets visited guard for that id.
5. AI runs the hop, calls `submit_findings` for the supplemented node.
6. Engine drains; AI calls `present_result` again with the merged archive + new node in `nodes[]`.

## Verification Rules

- Turn 2 contains 1 `start_exploration` tool_use with `supplement.nodeIds` carrying the new id.
- Turn 2 contains 1 `submit_findings` for the supplemented id.
- Turn 2 contains 1 `present_result` re-render.
- `archive.detail_slots[]` length increments by 1.
- `result_graph.nodes[]` includes the supplemented id.
- Bridge log line: `[Phase] completed → exploring (supplement) — nodeIds=1 agendaed=1 contracted=0 skipped=0`.

## Engine guards exercised

- `supplementAgenda(nodeIds)` accepts only when prior engine status === `complete` (`supplement_requires_complete_engine` rejection if not).
- Supplement reuses the same engine instance (no `init()` re-run).
- Visited guard reset for supplemented ids.
- Phase transition `completed → exploring → completed` (not `idle → exploring` — that would lose the archive).

## Harness

Multi-turn extension required. Auto-orchestrator must recognize a `supplement` start_exploration and route the subsequent hop correctly.

## Known Limitations

The user's instruction must name a real node id (not invent one). If the AI translates "the upstream source I missed" into an invented id, the engine's `unknown_node_ids` rejection fires (this case becomes a B-axis content failure unless paired with `lineage_search_objects`).

## Evaluation Notes

Tests the **archive-preserving** path for adding nodes post-synthesis. Distinct from a fresh `start_exploration` (which would discard the prior archive). The supplement path is the primary mechanism for the "expand related objects" follow-up flow.
