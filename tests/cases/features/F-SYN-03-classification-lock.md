# F-SYN-03-classification-lock

## Question

> Business view only: trace `[ai].[FactSalesReport]` upstream depth 2.

(Mission classification is locked to `business` at gate.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Synthesis → mission-type lock honored end-to-end |
| Persona | PM |
| Difficulty | medium |
| Origin | [ai].[FactSalesReport] |
| classification | business |

## Expected Outcome

| Field | Value |
|-------|-------|
| `present_result.sections[].text` contains technical content (SQL fences for CTE definitions, MERGE syntax, distribution hints) | NO |
| `result_graph.description` says "loading pattern: TRUNCATE + INSERT" or similar ETL-shape line | NO (`loading_pattern` template is technical/both only) |
| Captures contain technical-leak content | rejected at active phase via `classification_lock_violation` |

## Required Nodes

Same as standard FactSalesReport upstream trace.

## Optimal Path

1. start_exploration({ classification: 'business' }) — gate emitted.
2. User approves.
3. Capture turns: AI fires only `business_capture` template (per `CLASSIFICATION_GATED` in `templateRenderer.ts`).
4. If AI submits a `business`-angle slot whose body contains SQL fences / MERGE syntax / distribution hints → engine rejects with `classification_lock_violation` at the tool handler boundary (`toolProvider.validateSectionsAgainstClassification`).
5. Synthesis: lifts business slots only. `loading_pattern` template not rendered (gated to technical/both).

## Verification Rules

- `archive.detail_slots[]` `sections[].angle` values are all `business`.
- `result_graph.description` contains zero ` ```sql ` fences (SQL is the technical angle's contract).
- `result_graph.closing` does NOT mention "loading pattern" / "TRUNCATE" / "MERGE" / "upsert" / "historization" as ETL-shape labels.
- ≥1 `classification_lock_violation` rejection in bridge JSONL ONLY if AI mis-classifies (otherwise zero is correct).

## Engine guards exercised

- `CLASSIFICATION_GATED` filter in `templateRenderer.ts` (business → technical_capture not fired; loading_pattern not fired at synthesis).
- `toolProvider.validateSectionsAgainstClassification` — locked classification enforced mechanically at submit time.

## Harness

Standard test-eval harness. Mission classification passed at gate.

## Evaluation Notes

Validates the user-contract integrity: when a user picks `business`, they should see business framing, not technical artifacts. Critical for stakeholder-mode use cases.
