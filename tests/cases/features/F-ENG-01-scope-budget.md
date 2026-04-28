# F-ENG-01-scope-budget

## Question

> Trace bidirectional from `[ai].[FactSalesReport]` depth 6.

(Depth 6 should overshoot the safe-max scope budget — engine should reject.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Engine → scope_exceeds_budget guard |
| Persona | n/a — boundary test |
| Difficulty | hard (preflight rejection) |
| Origin | [ai].[FactSalesReport] |
| Direction | bidirectional |
| Depth | 6 |

## Expected Outcome

| Field | Value |
|-------|-------|
| `start_exploration` returns | `error: 'scope_exceeds_budget'` with `scope`, `safe_max`, `hint` fields |
| AI recovers | re-calls with reduced depth or filters |
| Engine state | no init (engine NOT created if scope > safe-max) |

## Required Nodes

_None — exploration never starts._

## Optimal Path

1. AI calls `start_exploration` with depth 6.
2. Engine preflight BFS computes scope = N nodes (e.g. 80+).
3. If N > safe_max (35 production, 17 in eval bridge), returns `error: 'scope_exceeds_budget'`.
4. AI reduces depth to 3 or adds filters (`excludeSchemas`).
5. Re-call succeeds.

## Verification Rules

- Bridge JSONL contains 1 `error: 'scope_exceeds_budget'` envelope after first start_exploration.
- Envelope contains `scope`, `safe_max`, `hint` fields.
- Recovery (re-call with reduced scope) is OPTIONAL — case is satisfied if engine rejects.

## Engine guards exercised

- `scope_exceeds_budget` preflight check (per `code-quality.md` Mechanical Enforcement table).

## Evaluation Notes

Boundary case — verifies the engine rejects unrealistic asks before burning hop tokens.
