# follow-q1-add-cross-schema

## Question

### Turn 1

> List all objects that directly read or write the Employee table

### Turn 2

> Also add [dbo].[ufnGetContactInformation] and [Sales].[vSalesPerson] explicitly to the view — I want to document the cross-schema context

## Classification

| Field | Value |
|-------|-------|
| Type | multi-turn follow-up |
| Subtype | Cross-schema node addition to existing view |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | Turn 1: [HumanResources].[Employee] · Turn 2: existing result |
| Direction | Turn 1: bidirectional · Turn 2: n/a |
| Columns | _None_ |
| Filter | None (no filter — cross-schema expected) |

## Expected Outcome

### Turn 1 (same as bb-q1-employee)

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm |
| Scope | 30–60 |
| Max hops | 15 |

### Turn 2

| Field | Value |
|-------|-------|
| SM Type | bb (same session, result persists) |
| Delivery | classic (no new SM) |
| Memory mode | n/a — reuses session.resultGraph |
| Scope | Turn 1 scope preserved |
| Max hops | 0 new hops |
| Required tools | lineage_enrich_view (with add_ids or is_update=true) |
| Forbidden tools | lineage_start_exploration (must NOT restart SM) |
| Max total runtime (ms) | 60000 (turn 2 only) |

## Fact Check (verified 2026-04-16)

- Turn 1 = bb-q1-employee baseline (scope=46 at depth=5, 11 required readers/writers)
- Turn 2 expects session persistence: `sess.stateMachine.status === 'complete'` AND `sess.resultGraph` populated
- enrich_view with `is_update: true` + `add_ids` uses stored resultGraph to add nodes without restarting SM
- [dbo].[ufnGetContactInformation] and [Sales].[vSalesPerson] already in turn-1 scope; test verifies they can be explicitly added to the view if not initially included

## Required Nodes (final view, after turn 2)

- All turn-1 required nodes
- [dbo].[ufnGetContactInformation] (cross-schema from turn 1's detail)
- [Sales].[vSalesPerson] (cross-schema from turn 1's detail)

## Forbidden Nodes

- uspLogError
- uspPrintError
- ErrorLog

## Optimal Path

### Turn 1
Same as bb-q1-employee.

### Turn 2
1. AI sees follow-up — does NOT call start_exploration again
2. Calls lineage_enrich_view with `add_ids: ["[dbo].[ufngetcontactinformation]", "[sales].[vsalesperson]"]` and `is_update: true`
3. View updated in place, cross-schema nodes included

## Known Limitations

_Tests that session state persists between Claude Code agent calls AND that enrich_view accepts explicit cross-schema additions._
