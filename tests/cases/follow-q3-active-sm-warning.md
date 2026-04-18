# follow-q3-active-sm-warning

## Question

### Turn 1

> List all objects that directly read or write the Employee table

### Turn 2 (concurrent / before turn-1 completes)

> Trace TotalRevenue column upstream from FactSalesReport

## Classification

| Field | Value |
|-------|-------|
| Type | multi-turn / concurrency smoke test |
| Subtype | Cross-session SM wipe — chat-notice + TTL + completion-flag check |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | Turn 1: [HumanResources].[Employee] · Turn 2: [ai].[FactSalesReport] |
| Direction | Turn 1: bidirectional · Turn 2: up |
| Columns | Turn 1: _None_ · Turn 2: [TotalRevenue] |
| Filter | None |

## Expected Outcome

### Turn 2 — cross-session (different `sess.id`, turn 1's SM still live)

| Field | Value |
|-------|-------|
| Expected behavior | Turn 2 silently wipes turn 1's SM and proceeds |
| User-facing notice | `stream.markdown()` emits a blockquote: "A previous exploration was still running when you started this one. Its in-memory findings were discarded." |
| Modal | **Never** — no `confirmationMessages` is returned from `prepareInvocation` |
| Mechanism | `sess.pendingUserNotice` set in `start_exploration.invoke()` → drained by `runWithTools` after each tool round |

### Turn 2 — same session, mid-flow (re-fire of `start_exploration`)

| Field | Value |
|-------|-------|
| Expected behavior | Returns `{ error: 'already_started', hint: '…' }` without wiping |
| User-facing notice | None (LLM sees the error + hint in the tool result and should continue with `submit_findings`) |
| Modal | **Never** |

### Turn 2 — after turn 1 completes (SM status = complete)

| Field | Value |
|-------|-------|
| Behavior | Turn 1's SM silently reset (no notice, no error) |
| SM Type | ct_columns (new SM for turn 2) |
| Delivery | sm (sliding — ct-q1 baseline) |
| Reason | Status=complete → `resetIfStale()` path |

### Turn 2 — session stale (> 30 min)

| Field | Value |
|-------|-------|
| Behavior | Silent reset; new SM created. No notice, no error. |
| Reason | `isStale()` true → `resetIfStale()` wipes before the cross-session check |

## Fact Check (verified 2026-04-18)

- `AiSession.isStale()` returns true when session age > 30 minutes (`STALE_AFTER_MS = 30 * 60 * 1000`)
- `toolProvider.ts` `lineage_start_exploration.invoke`:
  - Runs `sess.resetIfStale()` first (silent wipe on stale / complete)
  - If SM still live and `engine.sessionId !== sess.id` → adds a notice to `sess.pendingUserNotice` and wipes (cross-session)
  - Else if SM still live and `engine.sessionId === sess.id` → returns `{ error: 'already_started' }` (same-session re-fire guard)
- `prepareInvocation` returns only `{ invocationMessage }` — no `confirmationMessages`, no modal dialogs anywhere in the codebase.
- `sess.pendingUserNotice` is a `Set<string>` (dedupe); drained in `lineageParticipant.ts` `runWithTools` after each tool round via `stream.markdown`.
- Session ID + start time are rotated at `lineageParticipant.ts` when `chatContext.history.length === 0`.

## Required Behavior

1. When turn-2 fires a cross-session `start_exploration` (`status !== 'complete'` AND not stale AND different `sess.id`):
   - Tool response must contain the normal `start_exploration` result (new SM created) — no error.
   - The chat stream must include a `> …` blockquote notice about the discarded exploration.
   - `sess.pendingUserNotice` must be empty after the round (drained).
2. When turn-2 fires a same-session re-call of `start_exploration`:
   - Tool response must contain `{ error: 'already_started', hint: '…' }`.
   - No chat notice, no modal.
3. When turn-1 SM is complete OR stale:
   - New SM is created for turn 2, no notice, no error.

## Required Nodes

_Not applicable — this is a concurrency/lifecycle test._

## Forbidden Nodes

_None._

## Optimal Path

### Scenario A (cross-session, mid-flow)
1. Turn 1 calls `start_exploration`, goes through a few hops.
2. `sess.id` is rotated (new chat turn, history empty).
3. Turn 2 calls `start_exploration`. Cross-session guard fires.
4. Turn 1's findings are wiped. `stream.markdown` emits the blockquote notice.
5. Turn 2 proceeds as a fresh exploration.

### Scenario B (same-session re-fire)
1. Turn 1 calls `start_exploration`, receives `complete_rejected` at hop N.
2. LLM (incorrectly) re-calls `start_exploration`. Same-session guard fires.
3. Tool returns `{ error: 'already_started', hint: '…' }`.
4. LLM self-corrects and continues with `submit_findings` on the already-queued neighbors.

### Scenario C (SM complete)
1. Turn 1 completes normally (bb-q1 → enrich_view → done).
2. Turn 2 calls `start_column_trace` — silent reset, new CT SM created, trace runs.

## Known Limitations

_None specific to this test. The flow is entirely in-chat (no modal dialogs) and is fully proxyable — the proxy captures `stream.markdown` calls for notice assertions and tool result JSON for error-payload assertions._
