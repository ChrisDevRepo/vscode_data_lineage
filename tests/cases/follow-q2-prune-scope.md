# follow-q2-prune-scope

## Question

### Turn 1

> List all objects that directly read or write the Employee table

### Turn 2

> Remove the update procedures — I only want to see the read-only views in the final documentation

## Classification

| Field | Value |
|-------|-------|
| Type | multi-turn follow-up |
| Subtype | Scope reduction / prune on existing view |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | Turn 1: [HumanResources].[Employee] · Turn 2: existing result |
| Direction | Turn 1: bidirectional · Turn 2: n/a |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

### Turn 2

| Field | Value |
|-------|-------|
| SM Type | bb (same session persists) |
| Delivery | classic |
| Memory mode | n/a |
| Max hops | 0 new hops |
| Required tools | lineage_enrich_view (with prune_node_ids) |
| Forbidden tools | lineage_start_exploration |
| Max total runtime (ms) | 60000 |

## Fact Check (verified 2026-04-16)

- Turn 1 = bb-q1-employee (scope=46 or 12 depending on depth)
- `enrich_view.prune_node_ids` is a supported field in the enrich_view tool handler — removes nodes from the final view without SM restart
- Session persistence between turns relies on `session.resultGraph` (populated by `storeBbResult()` at end of turn 1)
- Expected final view: 5 views (vEmployee*, vSalesPerson*) — no write SPs

## Required Nodes (final view, after turn 2)

- vEmployee
- vEmployeeDepartment
- vEmployeeDepartmentHistory
- vSalesPerson
- vSalesPersonSalesByFiscalYears

## Forbidden Nodes (after turn 2 prune)

- uspUpdateEmployeeHireInfo (removed by prune)
- uspUpdateEmployeeLogin (removed by prune)
- uspUpdateEmployeePersonalInfo (removed by prune)
- uspLogError

## Optimal Path

### Turn 2
1. AI understands "remove update procedures" — does NOT restart SM
2. Calls lineage_enrich_view with `prune_node_ids: ["[humanresources].[uspupdateemployeehireinfo]", "...login", "...personalinfo"]` and `is_update: true`
3. View updated, writers removed, sections re-ordered
4. Final response documents readers only

## Known Limitations

_Tests prune_node_ids on enrich_view. Validates that session persists and edits are applied incrementally without re-running the SM._
