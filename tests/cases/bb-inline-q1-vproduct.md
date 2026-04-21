# bb-inline-q1-vproduct

## Question

> Build a bidrectional annotated lineage graph for [Production].[vProductAndDescription]. Explain where the product description comes from and which tables are involved in the join.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Small-scope inline |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [Production].[vProductAndDescription] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | _None_ |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | inline |
| Memory mode | Inline |
| Scope | 5 nodes |
| Max hops | 5 |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 15000 |

## Required Nodes
- [Production].[vProductAndDescription]
- [Production].[Product]
- [Production].[ProductModel]
- [Production].[ProductDescription]
- [Production].[ProductModelProductDescriptionCulture]

## Forbidden Nodes
_None._

## Optimal Path
1. `lineage_get_context` to verify schemas.
2. `lineage_search_objects` for vProductAndDescription.
3. `lineage_start_exploration` with origin="[Production].[vProductAndDescription]", direction="bidirectional".
4. The tool returns `inline: true` with all 5 nodes. AI analyzes the DDLs in one turn.
5. Call `lineage_present_result` with 1 section ("Product Description Sources") listing all 4 source objects with per-node notes describing what each contributes (ProductModel → model metadata, ProductDescription → descriptive text, ProductModelProductDescriptionCulture → the bridge that joins them, Product → the anchor).
6. Return chat answer summarizing the join logic.

## Known Limitations
_None._

## Verification Rules
- `present_result.name` contains "Product" or "Lineage".
- 1 `present_result` section: label="Product Description Sources"
- `sections[0].node_ids` contains all 4 upstream objects.
- Chat answer mentions `ProductModelProductDescriptionCulture` as the join bridge.

## Evaluation Notes
- "annotated lineage graph" → clearly requests `present_result` output, not prose.
