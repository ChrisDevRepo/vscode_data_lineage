# F-SYN-02-warning-preserve

## Question

> Trace bidirectional lineage of `[HumanResources].[Employee]` depth 2.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Synthesis → ⚠️ preservation through assembly |
| Persona | analyst |
| Difficulty | easy (validation case) |
| Origin | [HumanResources].[Employee] |

## Expected Outcome

| Field | Value |
|-------|-------|
| ⚠️ count in `result_graph.description` | ≥ ⚠️ count across all `archive.detail_slots[].sections[].text` bodies |
| Each ⚠️ in capture appears in synthesis | yes (verbatim text) |

## Required Nodes

Any captures that include ⚠️ (e.g. INNER JOIN drop semantics, NULL-collapse risks).

## Optimal Path

1-N: standard trace; capture turns include ⚠️ callouts.
N+1: synthesis lifts every captured body verbatim (per `buildSynthesisReminder` "Carry every ⚠️ callout from capture into the assembled section verbatim").
N+2: `result_graph.description` contains every ⚠️ from capture.

## Verification Rules

```python
sum(s['text'].count('⚠️') for s in archive_slots) <= result_graph.description.count('⚠️')
```

(Sum may be lower than description count if synthesis adds a closing-note ⚠️ — that's allowed.)

## Engine guards exercised

- None engine-side — synthesis-prompt-driven.

## Harness

Real-Haiku synthesis turn sufficient. Capture can be canned with embedded ⚠️ symbols.

## Evaluation Notes

Validates the most important content-preservation guarantee: risks captured at active phase are not silently dropped at synthesis. Already empirically observed on round-1b validation (vproduct: 2 ⚠️ in capture → 2 ⚠️ in synthesis; employee: 3 ⚠️ in capture → 3 ⚠️ in synthesis).
