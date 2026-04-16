# ct-q1-totalrevenue

## Question

> Trace TotalRevenue column upstream from FactSalesReport

## Classification

| Field | Value |
|-------|-------|
| Type | ct (Column Trace) |
| Subtype | — |
| Persona | any |
| Difficulty | hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |
| Direction | up |
| Columns | TotalRevenue |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 10–30 nodes |
| Max hops | 15 |
| Filter expected | No |
| Chain length min | 17 |
| Branches | 2 |
| Column renames min | 7 |
| Required tools | lineage_start_column_trace, lineage_submit_hop_analysis, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 300000 |
| Max hop-avg tokens | 4000 |
| Max rejections | 5 (column trace has more validation — rename tracking) |
| Max rejection rate | 25% |

## Fact Check (verified 2026-04-16)

- Origin: [ai].[factsalesreport] ✓
- **scope: 26 nodes** (depth=10) → sliding ✓ (in range 10-30)
- All 4 source nodes verified present: SAPOrders, OracleOrders, SupplierPrices, MarkupRules
- Two expected branches: quantity (through vwConsolidatedSales → ... → SAP/Oracle) and price (through vwPriceList → spRefreshPrices → SupplierPrices/MarkupRules)

## Required Nodes

_No fixed set — AI picks origin._

## Forbidden Nodes

_None._

## Source Nodes

- SAPOrders
- OracleOrders
- SupplierPrices
- MarkupRules

## Optimal Path

1. Search for FactSalesReport → find [ai].[FactSalesReport]
2. start_column_trace with columns=[TotalRevenue], direction=up
3. ~15 hops: trace TotalRevenue through 2 branches with 7+ column renames
4. Branch 1: Qty via vwConsolidatedSales → SalesStaging → vwRawOrders → CleanedOrders → RawOrderImport → vwExternalOrders → {SAPOrders, OracleOrders}
5. Branch 2: UnitPrice via vwPriceList (3-CTE rename) → PriceMaster → spRefreshPrices → {SupplierPrices, MarkupRules}
6. enrich_view with quantity + price branch sections

## Known Limitations

_None._
