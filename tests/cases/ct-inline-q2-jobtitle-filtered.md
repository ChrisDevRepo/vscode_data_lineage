# ct-inline-q2-jobtitle-filtered

## Question

> Trace JobTitle in Employee upstream

## Classification

| Field | Value |
|-------|-------|
| Type | ct (Column Trace) |
| Subtype | Filter forces inline scope |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | up |
| Columns | JobTitle |
| Filter | schemas: [HumanResources] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) |
| Scope | 3–10 nodes |
| Max hops | 1 (inline) |
| Filter expected | Yes |
| Required tools | lineage_start_column_trace, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 90000 |
| Max hop-avg tokens | 5000 |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[employee] ✓
- Filter: [HumanResources]
- **scope: 4 nodes** → inline ✓ (scope ≤ 10)
- Delivery confirmed inline (scope_nodes present in response)

## Required Nodes

- Employee
- uspUpdateEmployeeHireInfo
- uspUpdateEmployeeLogin

## Forbidden Nodes

- vSalesPerson
- vSalesPersonSalesByFiscalYears

## Optimal Path

1. Set filter = [HumanResources]
2. start_column_trace with columns=[JobTitle], direction=up
3. Filter limits scope to HR schema → inline delivery
4. Chain: Employee.JobTitle ← uspUpdateEmployee{HireInfo,Login,PersonalInfo} (writers)
5. Sales schema views pruned by filter

## Known Limitations

_FK-only edges not tracked — only SQL body references._
