# ct-inline-q1-jobtitle

## Question

> Trace the column [HumanResources].[vEmployeeDepartment].[JobTitle] back to its origin. Present the result as a column-trace graph.

## Classification

| Field | Value |
|-------|-------|
| Type | ct |
| Subtype | Small-scope inline |
| Persona | junior-dev |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[vEmployeeDepartment] |
| Direction | upstream |
| Columns | [JobTitle] |
| Filter | _None_ |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | inline |
| Memory mode | Inline |
| Scope | 2–5 nodes |
| Max hops | 5 |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 10000 |

## Required Nodes
- [HumanResources].[vEmployeeDepartment]
- [HumanResources].[Employee]

## Forbidden Nodes
_None._

## Optimal Path
1. `lineage_get_context` to verify schemas.
2. `lineage_search_objects` for vEmployeeDepartment.
3. `lineage_start_exploration` with origin="[HumanResources].[vEmployeeDepartment]", targetColumns=["JobTitle"], direction="upstream".
4. The tool returns `inline: true` with 2 nodes. 
5. Per-hop: verdict=pass for passthrough view, verdict=analyze for the source table (Employee).
6. `lineage_present_result` with 1 section ("JobTitle Origin") + notes[] on vEmployeeDepartment ("surfaces Employee.JobTitle via join") and Employee ("stores the canonical JobTitle column").
7. Return chat answer with a one-sentence origin confirmation.

## Known Limitations
_None._

## Verification Rules
- `present_result.name` exists.
- 1 `present_result` section labeled exactly "JobTitle Origin" (or equivalent unique key — user tolerance: any label containing the word "JobTitle").
- Employee table present in `present_result.sections[0].node_ids`.
- `tally.analyze` >= 1.

## Evaluation Notes
- "column-trace graph" → `start_exploration` with `targetColumns`, then `present_result`.
