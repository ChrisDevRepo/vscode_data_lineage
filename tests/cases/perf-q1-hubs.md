# perf-q1-hubs

## Question

> Which procedures have the most dependencies? Show me the complexity hubs in this database.

## Classification

| Field | Value |
|-------|-------|
| Type | analysis |
| Subtype | Performance / DBA — hub analysis |
| Persona | DBA |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | _None_ |
| Direction | _n/a_ |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | none |
| Delivery | classic (no SM) |
| Memory mode | n/a |
| Scope | 0 |
| Max hops | 0 |
| Filter expected | No |
| Required tools | lineage_run_analysis (type=hubs) |
| Forbidden tools | lineage_start_exploration, lineage_start_column_trace |
| Max total runtime (ms) | 30000 |
| Max hop-avg tokens | _n/a_ |

## Fact Check (verified 2026-04-16)

- `lineage_run_analysis` with type=hubs is a stateless classic tool (no SM)
- Verified top hubs in AdventureWorks2025_AI dacpac via proxy: spBuildSalesReport (ai schema pipeline center), multiple Employee/Person-related objects

## Required Response Content

Response must identify complexity hubs and explain degree/connection count. Likely top hubs:
- spBuildSalesReport (ai schema pipeline fan-in)
- Employee (HR core)
- Person (cross-schema hub)

## Required Nodes

_None — analysis doesn't produce resultGraph; hubs are listed in the text response._

## Forbidden Nodes

_None._

## Optimal Path

1. Call lineage_run_analysis with type='hubs', min_degree=3
2. Return list of top hubs with connection counts
3. Interpret — don't start exploration for DBA-style complexity queries
4. Response is structured markdown list

## Known Limitations

_Prevents overfitting — AI should NOT start BB for performance analysis. The run_analysis tool is the correct answer._
