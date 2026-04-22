# ct-inline-q1-jobtitle

## Question

> Trace the column [HumanResources].[vEmployeeDepartment].[JobTitle] back to its origin. Present the result as a column-trace graph.

## Classification

| Field | Value |
|-------|-------|
| Type | ct |
| Subtype | Sliding Memory Column Trace |
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
| Delivery | sliding_memory |
| Memory mode | Sliding |
| Scope | 5–10 nodes |
| Max hops | 15 |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 120000 |

## Required Nodes
- [HumanResources].[vEmployeeDepartment]
- [HumanResources].[Employee]

## Forbidden Nodes
_None._

## Optimal Path
1. `lineage_get_context` to verify schemas.
2. `lineage_search_objects` for vEmployeeDepartment.
3. `lineage_start_exploration` with origin="[HumanResources].[vEmployeeDepartment]", targetColumns=["JobTitle"], direction="upstream".
4. The engine returns `confirm_sm_start` (sliding_memory). AI authors a `mission_brief` focused on JobTitle.
5. Hop 1: AI analyzes `vEmployeeDepartment`, identifies `JobTitle` maps to `Employee`. AI uses `prune_neighbors` to eliminate irrelevant tables joined in the view (e.g. `Department`).
6. Hop 2: AI analyzes `Employee` table (persistence anchor). AI requests routes to DML procedures.
7. Hops 3-N: AI evaluates upstream procedures (e.g. `uspUpdateEmployeeHireInfo`), identifying true contributors vs. non-contributors.
8. `lineage_present_result` generates the final graph.
9. Return chat answer with a one-sentence origin confirmation.

## Known Limitations
_None._

## Verification Rules
- `present_result.name` exists.
- 1 `present_result` section labeled exactly "JobTitle Origin" (or equivalent unique key — user tolerance: any label containing the word "JobTitle").
- Employee table present in `present_result.sections[0].node_ids`.
- `tally.analyze` >= 1.

## Evaluation Notes
- "column-trace graph" → `start_exploration` with `targetColumns`, then `present_result`.
- Pruning: AI should use `prune_neighbors` to avoid the daisy-chain traversal of irrelevant joined tables.
