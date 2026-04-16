# bb-q10-ai-report-sources

## Question

> What are the data sources feeding FactSalesReport?

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | — |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |
| Direction | upstream |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 10–30 nodes |
| Max hops | 20 |
| Filter expected | No |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 240000 |
| Max hop-avg tokens | 3000 |

## Fact Check (verified 2026-04-16)

- Origin: [ai].[factsalesreport] ✓
- **scope: 20 nodes** (depth=5) → sliding ✓ (in range 10-30)
- All ai-schema pipeline nodes present
- Schemas in scope: {ai: 20} — all confined to ai schema (correct — pipeline is self-contained)

## Required Nodes

- spBuildSalesReport
- vwConsolidatedSales
- SalesStaging

## Forbidden Nodes

- ArchiveOrders
- spArchiveOldOrders

## Optimal Path

1. Search for FactSalesReport → find [ai].[FactSalesReport]
2. start_exploration upstream with depth≥4
3. ~15-20 hops: walk builder SP → staging views → raw staging tables → import SPs → external source tables
4. Prune archive/cleanup utility SPs as `irrelevant`
5. enrich_view with section per pipeline stage

## Known Limitations

_None._
