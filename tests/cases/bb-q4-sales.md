# bb-q4-sales

## Question

> Where does sales come from?

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | Open-ended — AI must discover origin |
| Persona | any |
| Difficulty | hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | _AI must discover via search_ |
| Direction | ai-decides (upstream likely) |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 5–50 nodes |
| Max hops | 20 |
| Filter expected | No |
| Required tools | lineage_search_objects, lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 240000 |
| Max hop-avg tokens | 3500 |

## Fact Check (verified 2026-04-16)

- Question is intentionally ambiguous — "sales" matches multiple candidates:
  - [Sales].[SalesOrderHeader] (transaction fact)
  - [Sales].[vSalesPerson] (cross-schema view)
  - [ai].[FactSalesReport] (analytical fact table)
  - [Sales].[SalesPerson] (HR-adjacent dimension)
- Scope depends on AI's origin choice + chosen direction
- No single "correct" answer — test validates discovery + disambiguation behavior
- Expected scope range 5-50 accommodates any reasonable origin

## Required Nodes

_No fixed set — AI picks origin. Must discover at least one Sales-related origin (e.g. `[Sales].[SalesOrderHeader]`, `[Sales].[vSalesPerson]`, or `[ai].[FactSalesReport]`)._

## Forbidden Nodes

- uspLogError
- uspPrintError
- ErrorLog

## Optimal Path

1. Search for "sales" → multiple hits in Sales schema + [ai].[FactSalesReport]
2. Pick a reasonable origin (fact table or central Sales object)
3. start_exploration with upstream direction
4. ~15-20 hops: trace data-provider pipeline
5. enrich_view documenting the sources

## Known Limitations

_Question is intentionally vague — tests discovery + disambiguation._
