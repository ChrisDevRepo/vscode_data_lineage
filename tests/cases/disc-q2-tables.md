# disc-q2-tables

## Question

> List all tables in the HumanResources schema

## Classification

| Field | Value |
|-------|-------|
| Type | discovery |
| Subtype | Filtered list — filter as starting point |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | _None_ |
| Direction | _n/a_ |
| Columns | _None_ |
| Filter | schemas: [HumanResources], types: [table] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | none |
| Delivery | classic (no SM) |
| Memory mode | n/a |
| Scope | 0 |
| Max hops | 0 |
| Filter expected | Yes (HR + table type) |
| Required tools | lineage_search_objects |
| Forbidden tools | lineage_start_exploration, lineage_start_column_trace |
| Max total runtime (ms) | 30000 |
| Max hop-avg tokens | _n/a_ |

## Fact Check (verified 2026-04-16)

- Filter: [HumanResources] + types=[table] → 6 tables: Department, Employee, EmployeeDepartmentHistory, EmployeePayHistory, JobCandidate, Shift
- No SM — `lineage_search_objects` with filter is stateless
- Baseline run (disc-q2-tables, session sess_1776365794464): `search_objects` called with query="" + filter. Haiku also did multiple exploratory searches — 42 tool calls total (suboptimal, one targeted call would suffice)

## Required Response Content

Response must list these HR tables:
- Employee
- EmployeeDepartmentHistory
- EmployeePayHistory
- Department

## Required Nodes

_None — discovery tests don't produce resultGraph._

## Forbidden Nodes

_None._

## Optimal Path

1. Filter pre-set = [HumanResources] types=[table]
2. Call lineage_search_objects with empty query (or wildcard) + types=table + schemas=HR
3. Return table list — no SM, no BFS
4. Response formats as markdown list

## Known Limitations

_None._
