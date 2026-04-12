# Eval Run — 2026-04-09T08-20

**Change under test:** CT memory wiring — `storeDetail()` + `updateShortMemory()` in `columnTraceState.ts`
**Model:** Haiku (`claude-haiku-4-5-20251001`)
**Dacpac:** `tmp/AdventureWorks2025_AI.dacpac` (148 nodes, 8 schemas)

## Results

| Test | Grade | SM Type | Scope | Sources | Chain | Renames | Branches | Hops | DQ% | Blocked% | vs Baseline |
|------|-------|---------|-------|---------|-------|---------|----------|------|-----|----------|-------------|
| ct-q1-totalrevenue | **PASS** | ct_columns | 28 | 4/4 | 18 | 11 | 2 | 15 | 93% | 0% | **IMPROVEMENT** (was FAIL: 1/4, chain 7) |
| ct-q2-adjustedrevenue | **PASS** | ct_columns | 28 | 4/4+1 | 21 | 8 | 3 | 15 | 93% | 0% | **IMPROVEMENT** (was PARTIAL: 2/4, chain 18) |

## Baseline Comparison

| Test | Baseline Grade | Baseline Sources | Baseline Chain | New Grade | New Sources | New Chain | Delta |
|------|---------------|-----------------|---------------|-----------|-------------|-----------|-------|
| ct-q1 | FAIL | 1/4 | 7 | **PASS** | 4/4 | 18 | +3 sources, +11 chain depth |
| ct-q2 | PARTIAL | 2/4 | 18 | **PASS** | 4/4+1 | 21 | +2 sources, +3 chain depth |

## SM Metadata

| Test | SM Type | Scope Size | Token Est | Filter Active | Agenda Init→Final |
|------|---------|-----------|-----------|---------------|-------------------|
| ct-q1 | ct_columns | 28 | 5600 | no | 7→0 |
| ct-q2 | ct_columns | 28 | 5600 | no | 7→0 |

## Rejection Summary

| Classification | Count | Top Issue |
|---------------|-------|-----------|
| DESIGN_CONFUSION | 0 | — |
| INFRA_BUG | 0 | — |
| HALLUCINATION | 0 | — |
| VALID_REJECTION | 0 | — |

**Zero rejections across both tests.** Memory wiring eliminated the confusion that caused Haiku to lose track of column renames in deep traces.

## Decision Quality Notes

- Both tests scored 93% DQ (14 correct, 1 suboptimal, 0 wrong, 0 blocked per test)
- ct-q1 suboptimal: traced vwDiscountCalc (Discount branch) which is irrelevant to TotalRevenue — harmless but wasteful
- ct-q2 suboptimal: spArchiveOldOrders traced then immediately dead-ended — table rule "trace ALL upstream" triggered unnecessarily
- Neither suboptimal decision affected the final result

## Recommendations

1. **CONFIRMED:** CT memory wiring fix validated with Haiku. Both tests improved from FAIL/PARTIAL to PASS.
2. **NEXT:** Run full 14-test eval suite with Haiku to check for regressions before locking new baseline.
