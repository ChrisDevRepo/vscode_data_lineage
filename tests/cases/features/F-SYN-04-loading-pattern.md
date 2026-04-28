# F-SYN-04-loading-pattern

## Question

> Technical analysis: trace `[ai].[FactSalesReport]` upstream depth 2 — show me the ETL pattern.

(Mission classification: `technical`.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Synthesis → loading_pattern fires on technical mission |
| Persona | DBA |
| Difficulty | medium |
| Origin | [ai].[FactSalesReport] |
| classification | technical |

## Expected Outcome

| Field | Value |
|-------|-------|
| `loading_pattern` template fires at synthesis | yes (per `CLASSIFICATION_GATED: ['technical', 'both']`) |
| `result_graph.closing` names the ETL pattern (`reload`, `append`, `upsert`, `historization`, `purge`, or `orchestration`) | yes (when bodied procs share a single load shape) |
| Pattern coarseness | one of the 6 named values; no SCD1/SCD2/CDC sub-variants |

## Required Nodes

≥2 procedures with the SAME load shape (e.g. all `TRUNCATE + INSERT`).

## Optimal Path

1-N: technical-mission trace; capture turns fire `technical_capture` only.
N+1: synthesis triggered. `general` template fires (always). `loading_pattern` fires (technical-gated).
N+2: `present_result.closing` names the shared ETL pattern.

## Verification Rules

- `result_graph.closing` mentions one of: "reload", "append", "upsert", "historization", "purge", "orchestration".
- `result_graph.closing` does NOT mention SCD1/SCD2/CDC (forbidden sub-variants).
- If procs in scope DO NOT share a single shape → `loading_pattern` correctly omits the closing line (verify by inspecting scope's bodied DDL).

## Counter-test pairing

Re-run the same case with `classification: 'business'`. Expect: `result_graph.closing` does NOT mention any ETL-pattern label. (Same payload as `F-SYN-03`.)

## Engine guards exercised

- `CLASSIFICATION_GATED` filter for `loading_pattern` in `templateRenderer.ts`.
- `STAGE_BY_KEY` routing of `loading_pattern` to synthesis stage only.

## Harness

Standard test-eval harness. Mission classification passed at gate.

## Evaluation Notes

Validates the technical-only synthesis closing template added in CR-3. Pairs with F-SYN-03 for full classification-axis coverage.
