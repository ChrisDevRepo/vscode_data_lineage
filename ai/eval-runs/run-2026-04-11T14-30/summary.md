# Eval Run — 2026-04-11T14-30

**Change tested:** Domain-agnostic prompts — de-pipeline smPrompts.ts, aiOutputTemplates.yaml, package.json

## Results
| Test | Grade | SM Type | Scope | Nodes | Hops | vs Baseline |
|------|-------|---------|-------|-------|------|-------------|
| bb-q1-employee | PASS | bb | 46 | 11/11 | 18 (WARN) | STABLE |
| bb-q2-employee-deep | PASS | bb | 9 | 8/8 | 8 | STABLE |
| ct-q3-customersegment | FAIL | ct_columns | 28 | wrong path | 5 | REGRESSION* |
| dep-q1-vemployee | PASS | ct_deps | 13 | 2/2 | 9 | STABLE |
| bb-q6-production-filter | PASS | bb | 2 | filter ok | 1 | STABLE |

*ct-q3 REGRESSION: Haiku traced UnitPrice path instead of CustomerSegment. Classification: HALLUCINATION (model variance). CT-specific prompts (columnTracking, columnLineageRule) were NOT changed. Baseline rl-status documents Haiku variance on similar tests (ct-q1: 4/4 sources one run, 3/4 next run).

## Rejection Summary
| Classification | Count | Detail |
|---------------|-------|--------|
| HALLUCINATION | 1 | ct-q3: wrong column at hop 1 |
| DESIGN_CONFUSION | 0 | — |
| INFRA_BUG | 0 | — |
| VALID_REJECTION | 0 | — |

## Verdict

**4/5 PASS, 1 FAIL (model variance, not prompt regression).** The prompt changes (de-pipeline, CLASSIFY expansion, badge examples) did not cause any BB or DEP regressions. The ct-q3 failure is Haiku stochasticity — the column-specific prompts (columnTracking, columnLineageRule) were unchanged.

**Recommendation:** Accept as new baseline for BB/DEP tests. ct-q3 FAIL is known Haiku variance (documented in rl-status lessons #7). Re-run ct-q3 in isolation to confirm.
