# expl-q1-sql

## Question

> Show me the SQL of uspUpdateEmployeeHireInfo and explain what it does step by step

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
| Required tools | lineage_get_object_detail (for SP + direct neighbors) |
| Optional tools | lineage_get_ddl_batch, lineage_run_bfs_trace (1 hop) |
| Forbidden tools | lineage_start_exploration, lineage_start_column_trace, lineage_enrich_view |
| Max total runtime (ms) | 45000 |
| Max hop-avg tokens | _n/a_ |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[uspupdateemployeehireinfo] ✓ (exists in model)
- DDL contains: UPDATE Employee (JobTitle, HireDate, CurrentFlag), INSERT EmployeePayHistory, TRY/CATCH with EXECUTE uspLogError
- Direct neighbors confirmed: Employee, EmployeePayHistory, uspLogError
- No SM expected — `get_object_detail` + `get_ddl_batch` return all needed info

## Required Response Content

Response must:
- Include or reference the actual SQL DDL
- Explain step-by-step: UPDATE Employee (JobTitle, HireDate, CurrentFlag) + INSERT EmployeePayHistory
- Mention TRY/CATCH error handling + call to uspLogError
- **Reference the direct neighbors the SP touches:**
  - Employee (updated table)
  - EmployeePayHistory (insert target)
  - uspLogError (error-handling call)

## Required Nodes

_None required in resultGraph — but the response text must mention these direct neighbors:_
- Employee
- EmployeePayHistory
- uspLogError

## Forbidden Nodes

_None._

## Optimal Path

1. Search for uspUpdateEmployeeHireInfo → get exact ID
2. get_object_detail → DDL + list of refs (what it reads/writes) + refers (what calls it)
3. Parse refs to identify direct neighbors: Employee, EmployeePayHistory, uspLogError
4. (Optional) get_object_detail on each neighbor for richer context
5. Write step-by-step explanation in chat text, including the "touches" context
6. No enrich_view — single-object explanation

## Known Limitations

_Prevents overfitting — AI should NOT start a column trace for "explain this SP" questions.
But AI should still provide neighbor context (what tables/SPs this SP touches) without doing a full trace._
