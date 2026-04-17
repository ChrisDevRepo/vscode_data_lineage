# ct-inline-q1-jobtitle

## Question

> Build a column-trace graph showing where the JobTitle column on [HumanResources].[vEmployeeDepartment] comes from. Traverse upstream until you reach the physical source column on a base table. Show each rename or passthrough step. Use a schema filter limited to [HumanResources].

## Classification

| Field | Value |
|-------|-------|
| Type | ct (Column Trace) |
| Subtype | Small-scope inline |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[vEmployeeDepartment] |
| Direction | up |
| Columns | JobTitle |
| Filter | schemas: [HumanResources] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | ct_columns |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) — scope ≤ 10 |
| Scope | 2–10 nodes |
| Max hops | 5 |
| Filter expected | Yes (HumanResources only) |
| Required tools | lineage_start_exploration (with targetColumns), lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 90000 |
| Max hop-avg tokens | 4000 |
| Chain length min | 2 |
| Column renames min | 0 |

## Fact Check (verified 2026-04-16 against AdventureWorks2025_AI)

- Origin: [humanresources].[vemployeedepartment] ✓
- Filter: [HumanResources]
- **scope ≈ 3 nodes** → inline ✓ (vEmployeeDepartment → Employee via JobTitle passthrough)
- JobTitle is an Employee column surfaced directly through vEmployeeDepartment; no rename in the chain — this test validates the passthrough path.

## Required Nodes

- [HumanResources].[Employee] (source of `JobTitle`)

## Forbidden Nodes

_None._

## Source Nodes (CT column origins)

- [HumanResources].[Employee].JobTitle

## Optimal Path

1. Apply schema filter [HumanResources].
2. `lineage_search_objects` query="vEmployeeDepartment" → resolve origin id.
3. `lineage_start_exploration` origin=[HumanResources].[vEmployeeDepartment], targetColumns=["JobTitle"], direction=up.
4. Scope ≤10 → inline delivery.
5. Per-hop: verdict=pass for passthrough view, verdict=relevant for the source table (Employee).
6. `lineage_enrich_view` with 1 section ("JobTitle Origin") + notes[] on vEmployeeDepartment ("surfaces Employee.JobTitle via join") and Employee ("stores the canonical JobTitle column").

## Deliverable shape

- 1 enrich_view section labeled exactly "JobTitle Origin" (or equivalent unique key — user tolerance: any label containing the word "JobTitle").
- notes[] count = 2 (origin view + source table).
- chain_path.length ≥ 2.
- No column_renames expected (direct passthrough).

## Why this question is focused

- "column-trace graph" → `start_exploration` with `targetColumns`, then `enrich_view`.
- Explicit column name "JobTitle" → targetColumns=["JobTitle"].
- "upstream" → direction=up.
- "show each rename or passthrough step" → forces labeling every kept node.
- "schema filter limited to [HumanResources]" → forces filter; caps scope at ≤10.

## Known Limitations

- This is a minimal column trace — no renames, just a join passthrough. Used to validate the inline path without long-chain complexity. For rename-heavy CT coverage see `ct-q1-totalrevenue`.
