# expl-q1-sql

## Question

> Show the full SQL DDL of [HumanResources].[uspUpdateEmployeeHireInfo] and explain it step by step. After the DDL code block, provide exactly three bullet lists labelled: 'Tables updated:', 'Tables inserted into:', 'Error-handling calls:'. Do not start an exploration or build a lineage graph — this is a single-object explanation only.

## Classification

| Field | Value |
|-------|-------|
| Type | explanation |
| Subtype | SQL reading — junior dev |
| Persona | junior-dev |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[uspUpdateEmployeeHireInfo] |
| Direction | _n/a_ |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | none |
| Delivery | classic (no SM) |
| Memory mode | n/a |
| Scope | 0 |
| Max hops | 0 |
| Filter expected | No |
| Required tools | lineage_get_object_detail |
| Optional tools | lineage_get_ddl_batch |
| Forbidden tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Max total runtime (ms) | 45000 |
| Max hop-avg tokens | _n/a_ |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[uspupdateemployeehireinfo] ✓
- DDL contains:
  - `UPDATE [HumanResources].[Employee]` — updates `JobTitle`, `HireDate`, `CurrentFlag`
  - `INSERT INTO [HumanResources].[EmployeePayHistory]`
  - `BEGIN TRY ... END TRY BEGIN CATCH ... EXECUTE [dbo].[uspLogError]`
- Direct neighbors (refs): Employee, EmployeePayHistory, uspLogError.

## Required Response Content

Response must contain (in order):

1. The full DDL quoted in a ```sql ... ``` code block.
2. A paragraph or bullet list explaining the step-by-step behavior.
3. Exactly these three bullet-list headings (verbatim):
   - `Tables updated:` followed by a bullet list containing `[HumanResources].[Employee]`
   - `Tables inserted into:` followed by a bullet list containing `[HumanResources].[EmployeePayHistory]`
   - `Error-handling calls:` followed by a bullet list containing `[dbo].[uspLogError]`

## Required Nodes

_None in resultGraph — text-only answer. The three neighbor IDs above must appear somewhere in the response text._

## Forbidden Nodes

_None._

## Optimal Path

1. `lineage_search_objects` query="uspUpdateEmployeeHireInfo" → resolve exact id.
2. `lineage_get_object_detail` id=[HumanResources].[uspUpdateEmployeeHireInfo] → returns DDL + neighbors.
3. Extract the three neighbor IDs from the `neighbors` or `refs` field.
4. Format the response: code block + explanation + three required bullet-list headings.
5. Return chat text. No exploration, no enrich_view.

## Deliverable shape

- Chat prose only.
- `sql` code block containing the DDL verbatim.
- Three labelled bullet lists with the three neighbor IDs.

## Why this question is focused

- "Show the full SQL DDL" → get_object_detail.
- "explain it step by step" → prose explanation.
- Explicit three bullet-list headings with verbatim labels → stable output structure across models.
- "Do not start an exploration or build a lineage graph" → explicit anti-exploration guard.
- "single-object explanation only" → no BFS into neighbors.

## Known Limitations

_Prevents overfitting — AI must NOT start a column trace or exploration for "explain this SP" questions. Neighbor context comes from get_object_detail's `neighbors`/`refs` field, not from BFS._
