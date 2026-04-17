# bb-inline-q1-vproduct

## Question

> Build an annotated lineage graph showing where [Production].[vProductAndDescription] gets its data. Traverse upstream, include every source table/view in scope, and label each node with the columns it contributes to the view. Use a schema filter limited to [Production].

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | Small-scope inline |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [Production].[vProductAndDescription] |
| Direction | upstream |
| Columns | _None_ |
| Filter | schemas: [Production] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) — scope ≤ 10 |
| Scope | 2–10 nodes |
| Max hops | 5 |
| Filter expected | Yes (Production only) |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | lineage_run_bfs_trace-only (must follow with exploration) |
| Max total runtime (ms) | 60000 |
| Max hop-avg tokens | 5000 |

## Fact Check (verified 2026-04-16 against AdventureWorks2025_AI)

- Origin: [production].[vproductanddescription] ✓
- Filter: [Production]
- **scope: 5 nodes** → inline ✓ (scope ≤ 10)
- Schemas in scope: {Production: 5}
- Delivery: inline (confirmed — scope_nodes present)

## Required Nodes

- Product
- ProductModel
- ProductDescription
- ProductModelProductDescriptionCulture

## Forbidden Nodes

_None._

## Optimal Path

1. Apply schema filter [Production] on the session (via `POST /filter` or the chat participant's filter UI).
2. Call `lineage_start_exploration` with origin=[Production].[vProductAndDescription], direction=up.
3. Scope ≤10 → engine returns inline delivery, all DDL upfront, one batched hop.
4. Agent writes `detail_analysis` for each source node with `badge_label` + `note_caption`.
5. Call `lineage_enrich_view` with 1 section ("Product Description Sources") listing all 4 source objects with per-node notes describing what each contributes (ProductModel → model metadata, ProductDescription → descriptive text, ProductModelProductDescriptionCulture → the bridge that joins them, Product → the anchor).

## Deliverable shape

- 1 enrich_view section: label="Product Description Sources"
- notes[] populated for each source node with a one-line caption
- sections[].text includes column-level "what this contributes" detail
- No highlight_groups (optional)

## Why this question is focused

- "annotated lineage graph" → clearly requests `enrich_view` output, not prose.
- "upstream" → direction=up, no ambiguity.
- "label each node with the columns it contributes" → forces per-node note content.
- "schema filter limited to [Production]" → forces filter application; ensures inline scope.

## Known Limitations

_None._
