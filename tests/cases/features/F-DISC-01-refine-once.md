# F-DISC-01-refine-once

## Question

> Trace the lineage of `[HumanResources].[Employee]` bidirectionally with depth 2.

(After the gate is emitted, the user replies in a follow-up turn:)

> Actually, exclude the `dbo` schema entirely.

(After the second gate is emitted, the user approves: `yes`.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Discovery → refine once → approve |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | excludeSchemas: [dbo] (added on refine) |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm (sliding) |
| Memory mode | Two-tier (sliding) |
| Scope (post-refine) | 8–12 nodes (HR-only) |
| Max hops | 12 |
| Required tools | lineage_start_exploration ×2, lineage_submit_findings, lineage_present_result |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 60000 |

## Required Nodes (post-refine)

- [HumanResources].[Employee]
- [HumanResources].[vEmployee]
- [HumanResources].[vEmployeeDepartment]
- [HumanResources].[uspUpdateEmployeeHireInfo]

## Forbidden Nodes

- Any `[dbo].*` node should be **absent** from `present_result.nodes[]` after the refine.

## Optimal Path

1. AI calls `lineage_start_exploration` with origin + direction + depth.
2. Engine returns `error: action_required, gate: confirm_sm_start` with the full HR + dbo scope.
3. User replies with refinement intent (NL: "exclude the dbo schema entirely") rather than `yes`.
4. AI re-calls `lineage_start_exploration` with the SAME origin + direction + depth + `excludeSchemas: ["dbo"]`. **Same engine instance is reused (`isRefining` predicate)** — engine.init runs again with new filters.
5. Engine re-emits the gate with the narrowed scope.
6. User approves: `yes`.
7. AI proceeds through hops (HR-only); calls `submit_findings` per node; agenda drains.
8. AI calls `lineage_present_result` with HR-only nodes.

## Verification Rules

- Bridge JSONL contains **two** `lineage_start_exploration` tool_use entries before any `submit_findings`.
- Second `start_exploration` carries `excludeSchemas: ["dbo"]` (or `excludeNodeIds[]` mapped from dbo nodes — both legitimate translations).
- `result_graph.nodes[]` contains zero `[dbo].*` ids.
- Engine status events show one `Engine [BFS-refine]` log line (per `logging.md` `[AI] [Engine] [BFS-refine]` category).
- No `submit_findings` rejection of class `parallel_call_forbidden` (refine across turns must not trip the parallel-call guard — see toolProvider.ts `startExplorationRoundId` reset).

## Engine guards exercised

- `isRefining` predicate on `(phase=awaiting_gate, gate=confirm_sm_start, priorLive)` — refine round detected.
- `engine.init()` REPLACE semantics — second init replaces prior filters.
- `unknown_node_ids` rejection should NOT fire — `excludeSchemas` doesn't pass node ids.
- Gate detail re-emission via `dispatchExit` finalizer if narration-only.

## Harness

Requires `ORCH_REFINE_COUNT=1` flag (or `ORCH_REFINE_FILTERS='{"excludeSchemas":["dbo"]}'`) in `tmp/auto-orchestrator.py`. Without the flag, the autonomous test auto-approves the first gate and the refine never fires.

## Known Limitations

The user's NL refinement message must be plausibly translatable to `excludeSchemas: ["dbo"]` by the AI. If the AI mis-translates to `excludeTypes` or invents `excludeNodeIds`, the engine's `nl_filter_overgeneralized` / `unknown_node_ids` guards fire — those are covered by `F-NL-02` and `F-NL-03` respectively.

## Evaluation Notes

This is the canonical refine-once happy path. Tests:
1. The participant correctly detects "user said something other than yes/no at the gate" → translates to refinement intent (per `prompts.ts:115`).
2. The engine reuses the same instance and re-runs `init()` with new filters.
3. Cross-turn parallel-call guard reset works.
4. Gate detail re-emission survives narration-only refine turns.
