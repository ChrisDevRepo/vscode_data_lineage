# F-FUP-05-show-description

## Question (turn 1)

> Trace upstream from `[ai].[FactSalesReport]` depth 2.

## Question (turn 2 — chip click)

> Show the full description

(Verbatim `SHOW_DESCRIPTION_TRIGGER` from `prompts.ts:310`.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Follow-up chip → replay cached description |
| Persona | any |
| Difficulty | easy |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome

| Field | Value |
|-------|-------|
| Turn 2 LM round-trip | NONE — short-circuit replay; no model call |
| Turn 2 chat output | identical to `sess.lastPresentResultDescription` |
| Turn 2 phase change | none (`completed` → `completed`) |
| Tool calls turn 2 | 0 |

## Optimal Path

1. Turn 1: standard upstream trace ends `completed`. `sess.lastPresentResultDescription` populated with the rendered description.
2. Turn 2: handler receives `request.prompt === SHOW_DESCRIPTION_TRIGGER`.
3. Handler short-circuits at line 239 — writes `sess.lastPresentResultDescription` to `stream.markdown` directly, returns without invoking the LM.
4. No bridge round-trip.

## Verification Rules

- Bridge JSONL turn 2 contains ZERO `sm→bridge` entries (no LM call).
- Chat result turn 2 markdown body equals `sess.lastPresentResultDescription` byte-for-byte.
- `provideFollowups` after turn 2 still emits the chip if the description is still cached (idempotent).

## Engine guards exercised

- `lineageParticipant.ts:239` `SHOW_DESCRIPTION_TRIGGER` short-circuit.
- Description caching: `sess.lastPresentResultDescription` set on `present_result` success.

## Harness

Same multi-turn extension as `F-FUP-04`.

## Evaluation Notes

Tests the cheapest possible follow-up: zero-LM replay. Validates short-circuit safety — model never sees the magic string in any payload.
