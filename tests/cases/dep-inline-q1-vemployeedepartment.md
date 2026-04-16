# dep-inline-q1-vemployeedepartment

## Question

> Trace dependencies upstream from vEmployeeDepartment

## Classification

| Field | Value |
|-------|-------|
| Type | ct — Dependency Trace (Type 2, no columns) |
| Subtype | Filter forces inline |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[vEmployeeDepartment] |
| Direction | up |
| Columns | _None (dep mode)_ |
| Filter | schemas: [HumanResources] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_deps |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) — scope ≤ 10 |
| Scope | 1–10 nodes |
| Max hops | 6 |
| Filter expected | Yes (HumanResources) |
| Required tools | lineage_start_column_trace, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 90000 |
| Max hop-avg tokens | 5000 |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[vemployeedepartment] ✓
- Filter: [HumanResources]
- **scope: 8 nodes** → inline ✓ (scope ≤ 10)
- Delivery: inline (confirmed)

## Required Nodes

- Employee

## Forbidden Nodes

_None._

## Optimal Path

1. Search for vEmployeeDepartment → find [HumanResources].[vEmployeeDepartment]
2. start_column_trace with empty columns (dependency mode), direction=up
3. Schema filter limits scope to HumanResources only (scope ~8)
4. Small scope qualifies for inline delivery
5. ~4-6 hops within HumanResources upstream graph

## Known Limitations

_FK-only edges (no SQL body reference) are not in the graph._
