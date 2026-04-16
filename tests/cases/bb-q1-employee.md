# bb-q1-employee

## Question

> List all objects that directly read or write the Employee table

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | — |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 30–60 nodes |
| Max hops | 15 |
| Filter expected | No |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 180000 |
| Max hop-avg tokens | 3000 |
| Max rejections | 3 |
| Max rejection rate | 20% |

## Fact Check (verified 2026-04-16 against AdventureWorks2025_AI)

- Origin: [humanresources].[employee] ✓
- **scope: 46 nodes** (depth=5) → sliding ✓
- scope breakdown: HR=11, dbo=7, Sales=12, Person=13, Purchasing=3
- All 11 required nodes verified present in model
- Forbidden nodes (uspLogError, uspPrintError, ErrorLog) present but expected as `irrelevant` verdicts

**Note:** Haiku agent may default to depth=1 (scope 12) — still sliding since scope > 10. If tuning, force depth=5 in system prompt guidance.

## Required Nodes

- uspUpdateEmployeeHireInfo
- uspUpdateEmployeeLogin
- uspUpdateEmployeePersonalInfo
- vEmployee
- vEmployeeDepartment
- vEmployeeDepartmentHistory
- uspGetEmployeeManagers
- uspGetManagerEmployees
- vSalesPerson
- vSalesPersonSalesByFiscalYears
- ufnGetContactInformation

## Forbidden Nodes

- uspLogError
- uspPrintError
- ErrorLog

## Optimal Path

1. Search for Employee → find [HumanResources].[Employee]
2. start_exploration with bidirectional direction, depth≥3
3. ~12 hops: traverse upstream writers (uspUpdate* SPs) and downstream readers (views, functions)
4. Utility/error objects pruned as `irrelevant`
5. enrich_view with 2 sections (Writers, Readers) + per-node notes

## Known Limitations

_None._
