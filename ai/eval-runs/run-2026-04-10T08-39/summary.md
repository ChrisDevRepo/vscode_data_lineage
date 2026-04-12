# Eval Run — 2026-04-10T08-39

## Context
Regression eval for CT memory wiring (R1: 563edba) + CT result export (R3: 44e3b6b).
Branch: `claude/remove-feature-docs-16Fsf`. Model: Haiku.

## Results
| Test | Grade | SM Type | Scope | Key Metric | Hops | DQ% | vs Baseline |
|------|-------|---------|-------|------------|------|-----|-------------|
| bb-q1-employee | PASS | bb | 46 | 11/11 nodes | 12 | 100 | STABLE |
| bb-q2-employee-deep | PASS | bb | 9 | 8/8 nodes | 8 | 100 | STABLE |
| bb-q4-sales | PASS | bb | 8 | open-ended | 2 | 100 | STABLE |
| bb-q5-cadenceworker | **FAIL** | bb | 30 | 6/12 nodes | 12 | 100 | IMPROVED (3→6) |
| bb-q6-production-filter | PASS | bb | 1 | filter works | 0 | 100 | STABLE |
| bb-q7-cadence-add-ids | PASS | bb | 30 | staging found | 15 | 100 | STABLE |
| bb-q8-scope-broad | PASS | bb | 14 | 14 nodes | 13 | 100 | STABLE |
| bb-q9-early-complete | PASS | bb | 88 | CW visited | 5 | 100 | STABLE |
| ct-q1-totalrevenue | **PARTIAL** | ct | 28 | 3/4 sources | 14 | 86 | IMPROVED (1→3) |
| ct-q2-adjustedrevenue | **PASS** | ct | 28 | 4/4+ sources | 15 | 100 | **IMPROVED** |
| ct-q3-customersegment | PASS | ct | 28 | rename found | 1 | 100 | STABLE |
| ct-q3-aw-businessentityid | PASS | ct | 4 | chain=4 | 3 | 100 | STABLE |
| ct-q4-tricky-rename | PASS | ct | 23 | 3+ renames | 15 | 100 | STABLE |
| dep-q1-vemployee | PASS | ct_deps | 13 | Emp+Person | 9 | 100 | STABLE |

**Total: 12 PASS / 1 PARTIAL / 1 FAIL (baseline: 10/1/3)**

## Improvements (3)
1. **ct-q2**: PARTIAL → PASS — all 4 sources + DiscountRules, 3 branches, 10 renames
2. **ct-q1**: FAIL → PARTIAL — 1/4 → 3/4 sources (MarkupRules pruned by Haiku variance)
3. **bb-q5**: FAIL → FAIL (improved) — 3/12 → 6/12 nodes, UDF pruning works

## Regressions: NONE

## Rejection Summary
| Classification | Count | Detail |
|---------------|-------|--------|
| HALLUCINATION | 1 | bb-q9 focus_mismatch (self-corrected) |
| DESIGN_CONFUSION | 0 | — |
| VALID_REJECTION | 0 | — |
| INFRA_BUG | 0 | — |

## Root Causes
- **ct-q1 MarkupRules miss**: Haiku variance — pruned as "optional LEFT JOIN". Validation run got 4/4. Not a SM bug.
- **bb-q5 incomplete**: Haiku set complete after 12 hops with 14 agenda remaining. MODEL_CAP, not SM bug.

## Recommendation
Lock as new baseline. R1+R3 changes validated — CT memory wiring produces consistent improvement on deep traces.
