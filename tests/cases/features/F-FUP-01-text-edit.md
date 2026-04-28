# F-FUP-01-text-edit

## Question (turn 1 — initial trace)

> Build a bidirectional lineage graph around `[HumanResources].[Employee]` depth 2.

## Question (turn 2 — follow-up text edit)

> Rewrite the Writers section to emphasize the transactional rollback behavior — every UPDATE happens inside `BEGIN TRY/CATCH` with `uspLogError` for failure capture. Make this the lead sentence.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Follow-up → text edit (re-call present_result) |
| Persona | tech-writer |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |

## Expected Outcome

| Field | Value |
|-------|-------|
| Turn 1 phase end | `completed` (synthesis done) |
| Turn 2 tool call | `lineage_present_result` ONLY (no `start_exploration`, no `submit_findings`) |
| Turn 2 phase end | `completed` (re-rendered) |
| `archive` (detail_slots) | unchanged across turns 1 → 2 |
| `result_graph.sections[]` | turn 1 vs turn 2: same `node_ids[]`, modified `text` |

## Required Nodes

Same as `bb-q1-employee` — Employee + Writers + Readers.

## Forbidden Tools (turn 2)

- `lineage_start_exploration` (must NOT fire — see follow-up rule "Genuinely new traces ... → tell the user in one sentence to start a fresh question")
- `lineage_submit_findings` (must NOT fire — exploration already complete)

## Optimal Path

1. Turn 1: standard lineage trace per `bb-q1-employee`. Ends in `completed` with full archive + result_graph.
2. Turn 2: AI receives the follow-up text-edit instruction.
3. AI re-calls `lineage_present_result` with the SAME `nodes[]`, `notes[]`, `highlights[]`, but a MODIFIED `sections[].text` for the Writers section reflecting the user's wording.
4. Engine accepts the re-call (per `toolPolicy.ts` completed phase allows `present_result`).
5. Phase stays `completed`; `result_graph` updated.

## Verification Rules

- Bridge JSONL turn 2 contains exactly 1 `lineage_present_result` tool_use.
- Bridge JSONL turn 2 contains 0 `lineage_start_exploration` and 0 `lineage_submit_findings`.
- Turn 2 `result_graph.sections[]` Writers section text contains "transactional rollback" or equivalent.
- `result_graph.sections[]` length unchanged from turn 1.
- `result_graph.nodes[]` identical to turn 1 (no node added or removed).

## Engine guards exercised

- `toolPolicy.ts` completed-phase tool filter — `present_result` allowed, `submit_findings` blocked.
- `present_result` accepts re-call without re-running synthesis.
- `sess.resultGraph` mutation on re-call (B-1 fix preserved).

## Harness

Requires multi-turn extension to `tests/e2e/suite/eval/eval.test.ts` autonomous test (currently single-question). Extension: after first synthesis completes, the test calls handler again with the follow-up question + same chat-context history.

## Known Limitations

VS Code chat-participant API is single-handler-per-turn. The autonomous test simulates conversation by replaying history into a fresh handler call with `chatContext.history` populated with prior `Request`/`Response` entries. The bridge transparently forwards history — the participant sees its own prior turn.

## Evaluation Notes

Validates the cheapest and most common follow-up: the user wants the text reworded without re-tracing. Should be a one-tool-call turn with no extra LM cost.
