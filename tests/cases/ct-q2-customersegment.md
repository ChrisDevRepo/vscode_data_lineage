# ct-q2-customersegment

## Question

> Trace CustomerSegment column upstream from FactSalesReport

## Classification

| Field | Value |
|-------|-------|
| Type | ct (Column Trace) |
| Subtype | — |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |
| Direction | up |
| Columns | CustomerSegment |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 15–25 nodes |
| Max hops | 10 |
| Filter expected | No |
| Chain length min | 4 |
| Column renames min | 1 |
| Required tools | lineage_start_column_trace, lineage_submit_hop_analysis, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 180000 |
| Max hop-avg tokens | 4000 |
| Max rejections | 3 |
| Max rejection rate | 25% |

## Fact Check (verified 2026-04-16 against AdventureWorks2025_AI)

**Ground truth** (proxy query, depth=5, no filter):
- **scope: 20 nodes** → sliding memory (scope > 10 → inline blocked)
- Origin: [ai].[factsalesreport] (verified exists)
- Delivery: sliding (confirmed via scope_nodes absence in start_column_trace response)

Chain nodes confirmed via search_objects:
- [ai].[factsalesreport] ✓
- [ai].[spbuildsalesreport] ✓
- [ai].[customersegmentmap] ✓
- [ai].[sprefreshsegments] ✓

## Required Nodes (chain path)

- FactSalesReport
- spBuildSalesReport
- CustomerSegmentMap
- spRefreshSegments

## Forbidden Nodes

Off-chain — these carry Qty/UnitPrice (not CustomerSegment):
- SalesStaging
- spLoadSalesStaging
- vwRawOrders
- CleanedOrders
- spCleanOrders
- RawOrderImport
- spImportOrders
- vwExternalOrders
- SAPOrders
- OracleOrders

## Optimal Path

1. Search for FactSalesReport → find [ai].[FactSalesReport]
2. start_column_trace with columns=[CustomerSegment], direction=up, depth=5
3. Scope is 20 (sliding mode). Agent hops through pipeline:
   - Hop 1: FactSalesReport → neighbors include spBuildSalesReport
   - Hop 2: spBuildSalesReport → trace CustomerSegment branch, **prune** Qty and UnitPrice branches
   - Hop 3-4: CustomerSegmentMap → spRefreshSegments (terminal)
4. Agent correctly prunes off-chain Qty/Price branches (forbidden nodes)
5. enrich_view with CustomerSegment chain section

## Known Limitations

_AI must understand that CustomerSegment does NOT flow through the order/price pipeline. Prune correctness is the key quality signal._
