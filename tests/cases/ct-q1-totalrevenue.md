# ct-q1-totalrevenue

## Question

> Trace the calculation of [TotalRevenue] in [Sales].[vSalesSummary] back to its raw sources. Which tables provide the base Quantity and Price?

## Classification

| Field | Value |
|-------|-------|
| Type | ct |
| Subtype | Multi-branch sliding |
| Persona | DBA |
| Difficulty | hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [Sales].[vSalesSummary] |
| Direction | upstream |
| Columns | [TotalRevenue] |
| Filter | _None_ |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | sm (sliding) |
| Memory mode | Two-tier (sliding) |
| Scope | 15–30 nodes |
| Max hops | 20 |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 60000 |

## Required Nodes
- [Sales].[vSalesSummary]
- [Sales].[vSalesDetail]
- [Sales].[SalesOrderHeader]
- [Sales].[SalesOrderDetail]
- [Production].[Product]

## Forbidden Nodes
_None._

## Optimal Path
1. `lineage_get_context` to verify schemas.
2. `lineage_search_objects` for vSalesSummary.
3. `lineage_start_exploration` with origin="[Sales].[vSalesSummary]", targetColumns=["TotalRevenue"], direction="upstream".
4. The tool returns `error: 'action_required', gate: 'confirm_sm_start'`.
5. Post `POST /gate` with `{ approved: true }`.
6. Fresh turn: AI receives the first hop context (vSalesSummary).
7. Loop through hops (10–15 nodes):
   - vSalesSummary: verdict=analyze (captures formula TotalRevenue = Qty * UnitPrice).
   - vSalesDetail: verdict=analyze (captures join between Header and Detail).
   - Every view in both chains: verdict=analyze (captures the rename) or verdict=pass (identity chain), with badge_label describing the step ("Qty Rename", "Price Lookup", etc.), note_caption naming the from→to column.
   - spRefreshPrices + spBuildSalesReport: verdict=analyze, sections[].text must include the actual SQL of the computation.
8. Agenda drains → synthesis prompt.
9. Call `lineage_present_result` with 2 sections (labels exactly "Quantity" and "Price"), notes[] for every kept node, highlight_groups optional (source/transform/target).
10. Return chat answer identifying `SalesOrderDetail.OrderQty` and `Product.ListPrice`.

## Known Limitations
- High-depth trace: may require 15+ hops to reach the physical tables.

## Verification Rules
- `present_result.name` exists.
- `present_result.sections[]` length = 2, labels exactly "Quantity" and "Price".
- Chat answer mentions `SalesOrderDetail` and `Product`.
- `tally.analyze` >= 5.

## Evaluation Notes
- "column-trace graph" → start_exploration with targetColumns + `present_result`.
