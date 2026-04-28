# F-SYN-01-grouping

## Question

> Trace lineage of `[Production].[vProductAndDescription]` bidirectional depth 2.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Synthesis → same-shape sibling slot grouping |
| Persona | analyst |
| Difficulty | medium |
| Origin | [Production].[vProductAndDescription] |

## Expected Outcome

| Field | Value |
|-------|-------|
| `present_result.sections[]` count | < `archive.detail_slots[]` count (grouping reduced N slots → fewer sections) |
| At least one section has `node_ids[]` length ≥ 3 | yes |
| Per-section `text` contains a comparison table where appropriate | optional (when variants differ on shared dimensions) |

## Required Nodes

≥3 sibling Reader views (same-shape captures) so grouping triggers.

## Optimal Path

1-N: standard trace ends `completed`. ≥3 captures share an identical or near-identical body shape.
N+1: synthesis lifts each slot but groups same-shape slots into one entry per `prompts.ts buildSynthesisPrompt` rule "Group same-shape sibling slots into one entry... list every variant id in `node_ids[]`".
N+2: `present_result.sections[]` has fewer entries than `detail_slots[]`.

## Verification Rules

- `result_graph.sections[]` length ≤ `archive.detail_slots[]` length minus 2 (at least one group of 3 collapsed to 1).
- ≥1 section has `node_ids.length ≥ 3`.
- Section `text` lifts the captured body verbatim (no re-authoring) per `buildSynthesisReminder`.

## Engine guards exercised

- None engine-side — synthesis-prompt-driven.

## Harness

Synthesis turn dispatch (real Haiku) sufficient; capture can be canned (even canned orchestrator gives identical bodies → triggers grouping correctly per the F-FUP-04 / vproduct case 1 measurement).

## Evaluation Notes

Validates the lift+group+label rule. Already exercised in the round-1b vproduct dispatch (8 identical slots → 2 grouped sections).
