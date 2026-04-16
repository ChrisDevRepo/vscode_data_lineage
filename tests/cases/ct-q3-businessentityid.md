# ct-q3-businessentityid

## Question

> Trace BusinessEntityID column upstream from Employee

## Classification

| Field | Value |
|-------|-------|
| Type | ct (Column Trace) |
| Subtype | FK-limited trace |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | up |
| Columns | BusinessEntityID |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) — scope ≤ 10 |
| Scope | 3–10 nodes |
| Max hops | 1 (inline batch verdicts) |
| Filter expected | No |
| Required tools | lineage_start_column_trace, lineage_submit_batch_hop OR lineage_submit_hop_analysis, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 60000 |
| Max hop-avg tokens | 5000 |
| Max rejections | 2 |
| Max rejection rate | 30% |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[employee] ✓
- **scope: 4** → inline ✓ (scope ≤ 10)
- Delivery: inline (confirmed — scope_nodes present in response)
- **Originally misclassified as sliding in old eval-suite.yaml; corrected here.**

## Required Nodes

_No strict set — test verifies that SM handles FK-limitation gracefully._

## Forbidden Nodes

_None._

## Known Limitations (important — why this is a medium difficulty)

**FK relationships don't create graph edges.** Only SQL body edges are parsed. BusinessEntityID is Employee's PK which is referenced by many FKs (HR.EmployeePayHistory, HR.EmployeeDepartmentHistory, Person.Person, etc.) but none of those FK relationships produce a graph edge.

So the CT trace finds only SPs that explicitly SELECT/UPDATE Employee.BusinessEntityID in their SQL body (small scope 4).

## Optimal Path

1. Search for Employee → [HumanResources].[Employee]
2. start_column_trace columns=[BusinessEntityID], direction=up
3. Scope = 4 → inline delivery
4. Agent analyzes all DDL upfront, submits batch verdicts
5. enrich_view

## Test Purpose

Validates:
- CT inline path (small scope)
- Agent handles "limited trace" scenarios without spraying wrong verdicts
- FK-gap is documented, not an SM failure
