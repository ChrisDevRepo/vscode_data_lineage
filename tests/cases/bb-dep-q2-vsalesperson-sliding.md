# bb-dep-q2-vsalesperson-sliding

## Question

> What does vSalesPerson depend on?

## Classification

| Field | Value |
|-------|-------|
| Type | bb — Dependency-style chain walk |
| Subtype | Cross-schema sliding |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [Sales].[vSalesPerson] |
| Direction | up |
| Columns | _None_ |
| Filter | schemas: [Sales, HumanResources, Person] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 10–20 nodes |
| Max hops | 10 |
| Filter expected | Yes (3 schemas) |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 180000 |
| Max hop-avg tokens | 4000 |
| Max rejections | 3 |
| Max rejection rate | 25% |

## Fact Check (verified 2026-04-16)

**Ground truth:** vSalesPerson has 15 upstream deps regardless of filter. Initial attempt at "inline" was wrong — vSalesPerson is a highly-joined view reading from many tables. Reclassified as **sliding** (scope > 10).

| Filter | Scope | Delivery |
|--------|-------|----------|
| None | (not tested) | — |
| [Sales] | 15 | sliding |
| [Sales, Person] | 15 | sliding |
| [Sales, HumanResources] | 15 | sliding |
| [Sales, HumanResources, Person] | 15 | sliding |

## Required Nodes

- SalesPerson
- Employee
- Person

## Forbidden Nodes

- uspLogError
- uspPrintError

## Optimal Path

1. Set filter = [Sales, HumanResources, Person]
2. start_exploration direction=up from [Sales].[vSalesPerson], depth=5 (no targetColumns → BB mode)
3. Scope=15 → sliding mode. Agent hops through:
   - SalesPerson (relevant — direct dep in Sales)
   - Employee, Person (HR + Person schemas via joins)
   - Various supporting tables in the cross-schema view
4. enrich_view with schema-grouped sections

## Known Limitations

_FK-only edges not traced. vSalesPerson is highly-joined so dep scope is large even when filtered._
