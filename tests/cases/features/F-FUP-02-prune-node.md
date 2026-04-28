# F-FUP-02-prune-node

## Question (turn 1)

> Build a bidirectional lineage graph around `[HumanResources].[Employee]` depth 2.

## Question (turn 2 — follow-up node prune)

> Remove `[HumanResources].[vEmployeeDepartment]` from the visualization — it's not part of the flow I care about.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Follow-up → prune node from visualization |
| Persona | analyst |
| Difficulty | easy |
| Origin | [HumanResources].[Employee] |

## Expected Outcome

| Field | Value |
|-------|-------|
| Turn 2 tool call | `lineage_present_result` ONLY |
| Turn 2 `nodes[]` | turn 1 `nodes[]` minus `[HumanResources].[vEmployeeDepartment]` |
| Turn 2 `sections[].node_ids[]` | id removed from any section that listed it |
| `archive` slot for the pruned node | preserved (engine archive unchanged) |
| `result_graph.description` | re-rendered without the removed node |

## Required Nodes (turn 2)

- [HumanResources].[Employee]
- [HumanResources].[vEmployee] (kept)
- [HumanResources].[uspUpdateEmployeeHireInfo] (kept)

## Forbidden Nodes (turn 2)

- [HumanResources].[vEmployeeDepartment] (user-pruned)

## Optimal Path

1. Turn 1: standard `bb-q1-employee` flow. Ends `completed` with vEmployeeDepartment in `nodes[]`.
2. Turn 2: AI receives prune-this-node instruction.
3. AI re-calls `lineage_present_result` with the modified `nodes[]` (vEmployeeDepartment removed) and modified `sections[].node_ids[]` (id removed from Readers section). The `notes[]` for the removed id is also removed.
4. Phase stays `completed`. Archive preserved.

## Verification Rules

- Turn 2 bridge JSONL contains exactly 1 `lineage_present_result` tool_use.
- Turn 2 result_graph `nodes[]` does NOT contain `[HumanResources].[vEmployeeDepartment]`.
- Turn 2 result_graph `sections[].node_ids[]` arrays do NOT contain the pruned id.
- Turn 2 `archive.detail_slots[]` STILL contains the pruned node's slot (archive ≠ visualization — per `prompts.ts:248` "The archive slot is preserved").

## Engine guards exercised

- Visualization-level prune (cosmetic) ≠ analytical prune (`verdict='prune'` at active phase).
- Archive is the ground truth; `result_graph` is the derived rendering. Mutating `result_graph` doesn't touch the archive.

## Harness

Same multi-turn requirement as `F-FUP-01`.

## Evaluation Notes

Tests the distinction between **analytical prune** (`verdict='prune'` at active phase, no body capture, node excluded from synthesis input) and **visualization prune** (post-synthesis cosmetic removal from `result_graph.nodes[]`). Both legitimate; different lifecycle.
