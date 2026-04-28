# F-DISC-03-cancel

## Question

> Trace the lineage of `[HumanResources].[Employee]` bidirectionally with depth 2.

(After gate, user cancels:)

> Cancel — I'll come back to this later.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Discovery → gate → cancel |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |

## Expected Outcome

| Field | Value |
|-------|-------|
| Exploration started | no |
| Hops executed | 0 |
| `submit_findings` calls | 0 |
| `present_result` calls | 0 |
| Final phase | `idle` (engine discarded) |
| Required tools | lineage_start_exploration ×1 (gate), then a cancel signal |

## Required Nodes

_None — exploration never starts._

## Forbidden Nodes

_None — but the visualization should remain empty._

## Optimal Path

1. AI calls `lineage_start_exploration` — gate emitted.
2. User replies with cancel-intent message.
3. AI emits no further tool calls — replies with a chat acknowledgement ("Cancelled — let me know when you'd like to revisit").
4. Session phase transitions back to `idle` (engine discarded; no agenda).

## Verification Rules

- Exactly 1 `lineage_start_exploration` tool_use in bridge JSONL.
- Zero `lineage_submit_findings` tool_use entries.
- Zero `lineage_present_result` tool_use entries.
- Session phase ends `idle` (per `[Phase] awaiting_gate → idle (cancel)` log).
- Bridge JSONL contains an AI `text` part acknowledging the cancel.

## Engine guards exercised

- `lineageParticipant.ts:282` — "[Gate] {gate} — user cancelled" log path.
- Phase transition `awaiting_gate → idle` (engine state discarded, not preserved).
- Subsequent `start_exploration` (in a future turn) would start a fresh engine, not the cancelled one.

## Harness

Requires `ORCH_CANCEL_AT_GATE=1` flag in `tmp/auto-orchestrator.py` (orchestrator emits cancel-intent text instead of approve).

## Known Limitations

Cancel UX is a model-translation concern — the user message must read as cancel intent for the AI to translate it. Strict-keyword cancellation (e.g. `no` / `cancel`) is the simplest case. Free-form cancellation (e.g. "actually never mind") relies on the AI's intent classification.

## Evaluation Notes

Validates the cancel branch end-to-end. Important for production UX: a stalled exploration that ignores cancel intent is a stuck session.
