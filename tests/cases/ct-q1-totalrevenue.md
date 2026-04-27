# ct-q1-totalrevenue

## Question

> Trace the calculation of [TotalRevenue] in [ai].[FactSalesReport] back to its raw sources. Which tables provide the base Quantity and Price?

## Classification

| Field | Value |
|-------|-------|
| Type | ct |
| Subtype | Multi-branch sliding |
| Persona | DBA |
| Difficulty | hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |
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
- [ai].[FactSalesReport]
- [Sales].[SalesOrderHeader]
- [Sales].[SalesOrderDetail]
- [Production].[Product]

## Forbidden Nodes
_None._

## Optimal Path
1. `lineage_get_context` to verify schemas.
2. `lineage_search_objects` for FactSalesReport.
3. `lineage_start_exploration` with origin="[ai].[FactSalesReport]", targetColumns=["TotalRevenue"], direction="upstream".
4. The tool returns `error: 'action_required', gate: 'confirm_sm_start'`.
5. Post `POST /gate` with `{ approved: true }`.
6. Fresh turn: AI receives the first hop context (FactSalesReport).
7. Loop through hops (10–15 nodes):
   - FactSalesReport: verdict=analyze (captures formula TotalRevenue = Qty * UnitPrice or equivalent computation).
   - Every upstream view/SP in both chains: verdict=analyze (captures the rename or computation) or verdict=pass (identity chain), with badge_label describing the step ("Qty Rename", "Price Lookup", etc.), note_caption naming the from→to column.
   - Each procedure: verdict=analyze, sections[].text must include the actual SQL of the computation.
8. Agenda drains → synthesis prompt.
9. Call `lineage_present_result` with 2 sections (labels exactly "Quantity" and "Price"), notes[] for every kept node, highlight_groups optional (source/transform/target).
10. Return chat answer identifying `SalesOrderDetail.OrderQty` and `Product.ListPrice` (or whatever the fixture's actual upstream physical tables turn out to be).

## Known Limitations
- High-depth trace: may require 15+ hops to reach the physical tables.
- B-2 fix (iter-2 round 1a, 2026-04-27): origin moved from `[Sales].[vSalesSummary]` (does not exist in the AdventureWorks2025_AI.dacpac fixture) to `[ai].[FactSalesReport]` (where TotalRevenue actually lives). Confirmed via `lineage_search_objects {query: TotalRevenue}` against the live extension host during iter-1 baseline.

## Verification Rules
- `present_result.name` exists.
- `present_result.sections[]` length = 2, labels exactly "Quantity" and "Price".
- Chat answer mentions the upstream physical-table names found during the trace.
- `tally.analyze` >= 5.

## Evaluation Notes
- "column-trace graph" → start_exploration with targetColumns + `present_result`.
