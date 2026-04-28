# F-DISC-02-refine-multi

## Question

> Trace the lineage of `[HumanResources].[Employee]` bidirectionally with depth 2.

(After gate 1, user replies:)

> Exclude the `dbo` schema.

(After gate 2, user replies:)

> Also exclude tables, only show views and procedures.

(After gate 3, user replies:)

> Actually keep tables but skip the error-logging procedures specifically.

(After gate 4, user approves: `yes`.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Discovery → 3× refine → approve |
| Persona | indecisive PM |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Filter (post-3rd refine) | excludeSchemas: [dbo], excludeNodeIds: [uspLogError, uspPrintError, ErrorLog] |

## Expected Outcome

| Field | Value |
|-------|-------|
| Refine rounds | 3 |
| Final scope | 6–10 nodes (HR-only, error-logging excluded by id) |
| Required tools | lineage_start_exploration ×4, lineage_submit_findings, lineage_present_result |

## Required Nodes (post-final refine)

- [HumanResources].[Employee]
- [HumanResources].[vEmployee]
- [HumanResources].[uspUpdateEmployeeHireInfo]

## Forbidden Nodes

- [dbo].* — must be absent
- [uspLogError], [uspPrintError], [ErrorLog] — must be absent (excluded by id, not type)

## Optimal Path

1-N: Same as `F-DISC-01` but the engine MUST be reused across **four** `start_exploration` calls before user approval. Each refine fully replaces prior filters except for the running set the user is composing — the AI accumulates prior filters with each new constraint.

## Verification Rules

- Bridge JSONL contains exactly **4** `lineage_start_exploration` tool_use entries before any `submit_findings`.
- Engine emits 4 `Engine [BFS-refine]` log lines.
- Engine reuses the same instance across all 4 starts (`isRefining` predicate trips on each).
- Per-turn parallel-call guard reset works (no `parallel_call_forbidden` rejections across turns).
- Final filter set is the **accumulation** of all approved-by-user constraints (the AI must not silently drop a prior refinement on a later one — accumulation is the AI's job, the engine just executes).

## Engine guards exercised

- Same as `F-DISC-01` plus: REPLACE semantics tested 3× back-to-back without state corruption.
- `getScopeContract()` hash changes per refine (each filter set is distinct).

## Harness

Requires `ORCH_REFINE_COUNT=3` (or a sequence list of refine messages) in `tmp/auto-orchestrator.py`.

## Known Limitations

The AI's refinement-accumulation behavior depends on the discovery prompt's instruction (prompts.ts:115 "Each call is a full re-spec — keep all prior filters and add the new one"). If the AI loses prior filters across turns, the result is mis-attributed as a refine-multi failure when it's really a memory-of-prior-filters problem. The case verifies the engine accepts the accumulated filter set; the prompt doctrine sits in `buildDiscoveryPrompt`.

## Evaluation Notes

Stress-test of the refine loop under a chatty user. Validates engine state-machine stability across multiple REPLACE inits without leaking prior-state assumptions.
