# disc-q1-schemas

## Question

> What schemas are in this database? How many tables in each?

## Classification

| Field | Value |
|-------|-------|
| Type | discovery |
| Subtype | Metadata overview |
| Persona | any |
| Difficulty | easy |
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
| Required tools | lineage_get_context |
| Forbidden tools | lineage_start_exploration, lineage_start_column_trace, lineage_run_bfs_trace |
| Max total runtime (ms) | 30000 |
| Max hop-avg tokens | _n/a_ |

## Fact Check (verified 2026-04-16)

- `lineage_get_context` returns schemas array with 8 schemas: ai, Production, Sales, dbo, HumanResources, Person, Purchasing, ext
- Node counts per schema (get_context result): Production=25, Sales=19, HumanResources=6, Person=13, Purchasing=5, dbo=3, ai=19, ext=varies
- No SM created — `get_context` is stateless classic tool
- Baseline run (disc-q1-schemas, session sess_1776365625688): 1 tool call, 9ms runtime, 0 errors, Grade=PASS

## Required Response Content

Response must mention these schemas:
- HumanResources
- Sales
- Production
- Person
- dbo
- ai

## Required Nodes

_None — discovery tests don't produce resultGraph._

## Forbidden Nodes

_None._

## Optimal Path

1. Call lineage_get_context — returns schema breakdown with object counts
2. Format text response — no SM needed
3. Response lists all 8 schemas with counts

## Known Limitations

_This test prevents overfitting: AI shouldn't start an SM for pure metadata queries._
