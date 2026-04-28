# F-FUP-04-followup-chip

## Question (turn 1)

> Trace upstream from `[ai].[FactSalesReport]` depth 2.

(Trace finishes with N deferred nodes. Chat surface should now show two follow-up chips: "Follow-up: Explore related objects…" and "Show full description".)

## Question (turn 2 — chip click)

> Follow-up: Explore related objects…

(This is the verbatim string `RECOMMEND_FOLLOWUPS_TRIGGER` from `prompts.ts:300`.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Follow-up chip → expand deferred questions |
| Persona | any |
| Difficulty | easy (when chip exists) |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome

| Field | Value |
|-------|-------|
| `provideFollowups` | returns ≥ 1 chip when `sess.stateMachine.deferredQuestions.length > 0` AND ≥ 1 chip when `sess.lastPresentResultDescription` is set |
| Chip prompt strings | `RECOMMEND_FOLLOWUPS_TRIGGER` and `SHOW_DESCRIPTION_TRIGGER` (verbatim magic strings) |
| Turn 2 trigger detection | `lineageParticipant.ts:235-237` short-circuits — `effectivePrompt` rewritten to `buildDeferredQuestionsPrompt(deferred)` |
| Turn 2 tool call(s) | per-deferred-question routing: AI calls `lineage_start_exploration({ supplement: { nodeIds: [...] } })` for the picked nodes |

## Required Nodes (turn 1)

- [ai].[FactSalesReport]
- ≥1 upstream node at depth 2.

## Forbidden Behavior

- `provideFollowups` MUST NOT emit chips when `phase !== 'completed'` or `deferredQuestions.length === 0` and `lastPresentResultDescription` is null. Empty chip list is correct in those cases.
- Clicking the chip MUST NOT start a fresh exploration — must go via `supplement` per the magic-string rewrite.

## Optimal Path

1. Turn 1: standard upstream trace. Synthesis completes. `provideFollowups` runs after the result, returns 2 chips (deferred + show-description).
2. Turn 2: user clicks the "Follow-up: Explore related objects…" chip. Chat host re-invokes the participant's handler with `request.prompt === RECOMMEND_FOLLOWUPS_TRIGGER`.
3. Handler short-circuits at line 235: `effectivePrompt = buildDeferredQuestionsPrompt(deferred)`.
4. AI sees the deferred-questions list as input; picks one or more to follow up; calls `start_exploration({ supplement: { nodeIds: [...] } })`.
5. Hop on each supplemented id; synthesis re-render.

## Verification Rules

- After turn 1: chat-result `followups[]` contains at least one chip with prompt = `RECOMMEND_FOLLOWUPS_TRIGGER` (when deferred non-empty).
- Always after synthesis: chip with prompt = `SHOW_DESCRIPTION_TRIGGER` is present.
- Turn 2 bridge JSONL `messages[0]` content references the deferred-question expansion (via `buildDeferredQuestionsPrompt`).
- Turn 2 results in `start_exploration({supplement})` — exact same path as `F-FUP-03`.

## Engine guards exercised

- `lineageParticipant.ts:140-159` `provideFollowups` predicate.
- `RECOMMEND_FOLLOWUPS_TRIGGER` magic-string detection at line 235.
- `buildDeferredQuestionsPrompt` builder.

## Harness

Requires extending the autonomous mocha test to:
1. Capture `chatResult.followups[]` after the first turn finishes.
2. Issue a second `handleChatRequest` call with `request.prompt = chatResult.followups[i].prompt` for the chip the test wants to click.

## Known Limitations

VS Code's `provideFollowups` API runs AFTER the request handler resolves. The test harness must observe the participant's `participant.followupProvider.provideFollowups` output and replay it. Real users see the chips in the chat UI; programmatic test must call the provider explicitly.

## Evaluation Notes

Tests the chat-surface integration end-to-end: chip render + chip click + magic-string detection + supplement routing. Production-critical UX.
