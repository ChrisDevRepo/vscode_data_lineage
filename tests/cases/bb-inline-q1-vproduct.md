# bb-inline-q1-vproduct

## Question

> What does vProductAndDescription depend on in the Production schema?

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
| Max hops | 1 (inline = batch submit) |
| Filter expected | Yes (Production) |
| Required tools | lineage_start_exploration, lineage_submit_batch_findings OR lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 60000 |
| Max hop-avg tokens | 5000 |

## Fact Check (verified 2026-04-16)

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

1. Filter is set (Production schema) before calling start_exploration
2. start_exploration upstream — scope is small (3-5 nodes) → inline mode activates
3. All DDL delivered upfront, agent submits batch findings
4. enrich_view with bridge-table documentation

## Known Limitations

_None._
