# perf-q1-hubs

## Question

> Analyze this database and list the top 10 most connected objects (highest fan-in + fan-out degree). Return a ranked text list with columns: Rank | Schema | Object Name | Object Type | Total Connections. Do not build a lineage graph and do not start an exploration — just report the degree data.

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
| Forbidden tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Max total runtime (ms) | 30000 |
| Max hop-avg tokens | _n/a_ |

## Fact Check (verified 2026-04-16)

- `lineage_run_analysis` with type=hubs is stateless (no SM).
- Top hubs expected in AdventureWorks2025_AI: spBuildSalesReport (ai pipeline center), [HumanResources].[Employee] (HR core hub), [Person].[Person] (cross-schema person hub), [Production].[Product] (product hub).

## Required Response Content

- A ranked markdown table with exactly these columns: Rank | Schema | Object Name | Object Type | Total Connections.
- Exactly 10 rows.
- Each row sourced from the `run_analysis` tool output (no fabrication — the test proxy validates that every listed object ID is in the model).

## Required Nodes

_None in resultGraph — this test produces text only._

## Forbidden Nodes

_None._

## Optimal Path

1. `lineage_run_analysis` with type="hubs", min_degree=3 (or default).
2. Read the returned ranked list, keep top 10.
3. Format as markdown table.
4. Return chat text. No graph, no enrich_view.

## Deliverable shape

- Chat prose only, no tool calls to start_exploration or enrich_view.
- Markdown table with exactly the 5 columns named above and 10 data rows.

## Why this question is focused

- "Return a ranked text list" → forces text output format.
- Explicit column headers → stable structure across runs.
- "Do not build a lineage graph and do not start an exploration" → explicit anti-exploration guard; prevents over-eager AIs (Haiku) from calling start_exploration for a hub query.
- Explicit "10" → fixed count, easy to verify.

## Known Limitations

_Prevents overfitting — AI must NOT start BB for structural analysis. The run_analysis tool is the correct path._
