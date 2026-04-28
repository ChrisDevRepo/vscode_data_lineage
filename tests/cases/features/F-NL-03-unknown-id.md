# F-NL-03-unknown-id

## Question

> Trace upstream from `[ai].[FactSalesReport]` depth 3 but skip `[dbo].[uspNonExistent]` and `[ai].[RECON]`.

(User invents a non-existent id `[dbo].[uspNonExistent]`. AI passes it through verbatim.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Discovery → excludeNodeIds with non-existent id → engine rejects |
| Persona | n/a — negative test |
| Difficulty | hard (negative test) |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome

| Field | Value |
|-------|-------|
| `start_exploration` returns | `error: unknown_node_ids, unresolved_excludeNodeIds: ['[dbo].[uspNonExistent]']` |
| AI recovers | calls `lineage_search_objects` to verify, then re-calls without the bad id |

## Optimal Path

1. AI passes `excludeNodeIds: ['[dbo].[uspNonExistent]', '[ai].[RECON]']`.
2. Engine `init()` resolves each id case-insensitively against `nodeMap`. `[dbo].[uspNonExistent]` is unresolved.
3. Engine returns `error: 'unknown_node_ids'` with `unresolved_excludeNodeIds` listing the bad id.
4. AI reads error; calls `lineage_search_objects({query: 'uspNonExistent'})` → no results.
5. AI tells the user "I couldn't find an object named uspNonExistent" or proceeds with only the valid id.

## Verification Rules

- Bridge JSONL contains `error: 'unknown_node_ids'` rejection after first `start_exploration`.
- `unresolved_excludeNodeIds` contains the bad id verbatim.
- Subsequent recovery (search + retry) is OPTIONAL — case is satisfied if the engine rejects.

## Engine guards exercised

- `unknown_node_ids` rejection at `engine.init()` (per `CLAUDE.md` "every supplied `excludeNodeIds` / `passNodeIds` must resolve to a real graph node").

## Evaluation Notes

Validates the typo-detection mechanical guard. Without it, the AI could silently no-op an exclusion the user explicitly named.
