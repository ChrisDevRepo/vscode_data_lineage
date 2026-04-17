# ct-q1-totalrevenue

## Question

> Build a column-trace graph showing how the TotalRevenue column on [ai].[FactSalesReport] is derived. Traverse upstream through every rename and computation step until you reach the physical source columns on the base tables. Organize the result into two sections titled exactly 'Quantity' (Qty lineage) and 'Price' (UnitPrice lineage). Use a schema filter that includes [ai].

## Classification

| Field | Value |
|-------|-------|
| Type | ct (Column Trace) |
| Subtype | Multi-branch sliding |
| Persona | any |
| Difficulty | hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |
| Direction | up |
| Columns | TotalRevenue |
| Filter | schemas: [ai] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | sm (hop-by-hop) |
| Memory mode | Two-tier (hop-by-hop with sliding memory) — scope > 10 |
| Scope | 15–30 nodes |
| Max hops | 15 |
| Filter expected | Yes ([ai] must be in the filter) |
| Chain length min | 12 |
| Branches | 2 (Quantity + Price) |
| Column renames min | 5 |
| Required tools | lineage_start_exploration (with targetColumns), lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 300000 |
| Max hop-avg tokens | 4000 |
| Max rejections | 5 |
| Max rejection rate | 25% |

## Fact Check (verified 2026-04-16 against AdventureWorks2025_AI)

- Origin: [ai].[factsalesreport] ✓
- **scope ≈ 26 nodes** (default depth) → sliding ✓
- TotalRevenue = Qty × UnitPrice (computed at spBuildSalesReport INSERT).
- Qty branch: FactSalesReport.Qty ← vwConsolidatedSales.Qty ← SalesStaging.OrderQty (**rename**) ← vwRawOrders ← CleanedOrders ← RawOrderImport ← vwExternalOrders ← {SAPOrders.Quantity (**rename**), OracleOrders.Quantity (**rename**)}.
- Price branch: FactSalesReport.UnitPrice ← vwPriceList (3-CTE chain) ← PriceMaster.ListPrice (**rename**) ← spRefreshPrices ← {SupplierPrices.Price (**rename**), MarkupRules.RuleFactor (**rename**)}.
- Minimum renames across both branches: 5.

## Required Nodes

_No fixed required set — AI discovers branches from the origin._

## Forbidden Nodes

_None._

## Source Nodes (must be reached — both branches)

- SAPOrders
- OracleOrders
- SupplierPrices
- MarkupRules

## Optimal Path

1. Ensure schema filter includes [ai] (CRITICAL — the origin is in the ai schema and the default extension filter excludes it).
2. `lineage_search_objects` query="FactSalesReport" schemas=["ai"] → origin id.
3. `lineage_start_exploration` origin=[ai].[FactSalesReport], targetColumns=["TotalRevenue"], direction=up.
4. Scope > 10 → hop-by-hop sliding memory.
5. Per-hop `lineage_submit_findings`:
   - Every view in both chains: verdict=relevant (captures the rename) or verdict=pass (identity chain), with badge_label describing the step ("Qty Rename", "Price Lookup", etc.), note_caption naming the from→to column.
   - spRefreshPrices + spBuildSalesReport: verdict=relevant, detail_analysis must include the actual SQL of the computation.
6. Continuation-contract: keep going until both branches reach a base-table column.
7. `lineage_enrich_view` with 2 sections (labels exactly "Quantity" and "Price"), notes[] for every kept node, highlight_groups optional (source/transform/target).

## Deliverable shape

- enrich_view.sections[] length = 2, labels exactly "Quantity" and "Price".
- chain_path.length ≥ 12.
- column_renames.length ≥ 5.
- notes[] count ≥ 10.
- All 4 source nodes (SAPOrders, OracleOrders, SupplierPrices, MarkupRules) must appear in graph_ids.

## Why this question is focused

- "column-trace graph" → start_exploration with targetColumns + enrich_view.
- Explicit column "TotalRevenue" → targetColumns=["TotalRevenue"].
- "upstream" → direction=up.
- Explicit two sections with forced names → unambiguous structure.
- "every rename and computation step" → forces rename tracking in notes.
- "schema filter that includes [ai]" → ensures origin is reachable.

## Known Limitations

- Requires [ai] in the filter. If the default 6-schema filter (no ai) is applied, search_objects for FactSalesReport returns empty and the agent should either add [ai] to the filter or report the mismatch. This is tested behavior — a correct run handles the filter gap.
