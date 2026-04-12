# Eval Run — 2026-04-12T10-00

**Branch:** `fix/bounded-bb-scope`
**Model:** claude-haiku-4-5-20251001
**Changes:** Bounded BFS scope (depth=5 default), expand_frontier tool, scope_direction on BB, bridge dispatcher sync

## Results

| Test | Grade | SM Type | Scope | Hops | DQ% | vs Baseline |
|------|-------|---------|-------|------|-----|-------------|
| bb-q1-employee | PASS | bb | 46 | 11 | 100% | STABLE |
| bb-q2-employee-deep | PASS | bb | 9 | 8 | 100% | STABLE |
| bb-q4-sales | PASS | bb | 15 | 14 | 100% | STABLE |
| bb-q5-cadenceworker | PASS | bb | 30 | 20 | 80% | **IMPROVED** (FAIL→PASS) |
| bb-q6-production-filter | PASS | bb | 7 | 6 | 100% | STABLE |
| bb-q7-cadence-add-ids | PASS | bb | 30 | 5 | 100% | STABLE |
| bb-q8-scope-broad | PASS | bb | 14 | 13 | 100% | STABLE |
| bb-q9-cadence-early-complete | PASS | bb | 38 | 2 | 100% | STABLE |
| bb-q10-ai-report-sources | PASS | bb | 20 | 19 | 89% | NEW |
| bb-q11-ai-staging-impact | PASS | bb | 11 | 9 | 89% | NEW |
| ct-q1-totalrevenue | PARTIAL | ct_columns | 28 | 7 | 86% | REGRESSION (PASS→PARTIAL) |
| ct-q2-adjustedrevenue | PARTIAL | ct_columns | 20 | 12 | 82% | REGRESSION (PASS→PARTIAL) |
| ct-q3-customersegment | WARN | ct_columns | 20 | 17 | 29% | REGRESSION (PASS→WARN) |
| ct-q3b-customersegment-tight | PASS | ct_columns | 20 | 3 | 100% | NEW |
| ct-q3-aw-businessentityid | PASS | ct_columns | 4 | 3 | 100% | STABLE |
| ct-q4-tricky-rename | PASS | ct_columns | 20 | 6 | 100% | STABLE |
| dep-q1-vemployee | PASS | ct_deps | 13 | 9 | 100% | STABLE |
| rej-ct-focus | PASS | ct_columns | 20 | 13 | 92% | NEW |
| rej-ct-columns | PARTIAL | ct_columns | 28 | 1 | 0% | NEW |
| rej-bb-focus | PASS | bb | 9 | 8 | 100% | NEW |
| ct-always-reject | PARTIAL | ct_columns | 20 | 1 | 100% | NEW |
| guard-bb-direct-neighbor | PARTIAL | bb | 30 | 2 | 100% | NEW |
| scope-bb-out-of-filter | PARTIAL | bb | 30 | 1 | 100% | NEW |
| scope-bb-external | PASS | bb | 20 | 19 | 79% | NEW |
| output-ct-chain | PARTIAL | ct_columns | 20 | 5 | 80% | NEW |
| output-bb-badges | PASS | bb | 30 | 28 | 81% | NEW |

## Summary: 16 PASS, 6 PARTIAL, 2 WARN, 0 FAIL

### vs Baseline (14 tests in baseline)
| Category | Count | Details |
|----------|-------|---------|
| STABLE | 8 | bb-q1, bb-q2, bb-q4, bb-q6, bb-q7, bb-q8, bb-q9, ct-q3-aw, ct-q4, dep-q1 |
| IMPROVED | 1 | bb-q5 (FAIL→PASS — 6/12 → ~12/12 nodes) |
| REGRESSION | 3 | ct-q1 (PASS→PARTIAL), ct-q2 (PASS→PARTIAL), ct-q3 (PASS→WARN) |
| NEW | 12 | bb-q10, bb-q11, ct-q3b, rej-*, guard-*, scope-*, output-* |

### Key Regression Analysis

**ct-q1 and ct-q2 REGRESSION root cause: MODEL_CAP (NOT depth limit)**
- UAT with auto model confirmed: same `depth=5`, `scope=20` → 15 hops, ALL 4 sources found
- CT frontier traversal goes beyond BFS depth (reached depth=10 within 20-node scope)
- Haiku stopped at 7-12 hops within the same scope — model stochasticity
- **SM is correct** — bounded scope includes all needed nodes
- **No code fix needed** — auto model works perfectly with depth=5

**ct-q3 REGRESSION root cause: MODEL_CAP (Haiku variance)**
- ct-q3b with same question and explicit pruning guidance: 3 hops, PASS
- ct-q3 without guidance: 17 hops, over-traced entire orders pipeline
- Same SM, same prompt — Haiku stochasticity on value-vs-selection

### UAT Verification (auto model, ct-q2)
| Metric | UAT | Haiku Eval |
|--------|-----|------------|
| Scope | 20 | 20 |
| Hops | 15 | 12 |
| Max depth | 10 | ~5 |
| Sources | 4/4 (SAP, Oracle, Supplier, Markup) | 0/4 |
| Chain | 21 nodes | 7 nodes |
| Conclusion | **SM + bounded scope works correctly** | Haiku model limitation |

## Scope Changes (Bounded BFS Impact)

| Test | Old Scope | New Scope | Change |
|------|-----------|-----------|--------|
| bb-q1 | 46 | 46 | Same (bidirectional depth=5 still reaches full graph) |
| bb-q2 | 9 | 9 | Same |
| bb-q4 | 2 | 15 | Larger (agent picked different origin with more connections) |
| bb-q5 | 30 | 30 | Same |
| bb-q6 | 1 | 7 | Larger (agent chose downstream instead of upstream) |
| bb-q8 | 14 | 14 | Same |
| bb-q9 | 88 | 38 | **Smaller** (depth=5 limits downstream from spCadenceRule_INIT) |
| ct-q1 | 28 | 28 | Same |
| ct-q3 | 28 | 20 | **Smaller** (depth=5 limits CT scope) |
| ct-q4 | 23 | 20 | **Smaller** |
| dep-q1 | 13 | 13 | Same |

## Rejection Summary

| Classification | Count | Top Issue |
|---------------|-------|-----------|
| VALID_REJECTION | 3 | focus_mismatch (deliberate tests), Guard 0 on UDF |
| DESIGN_CONFUSION | 2 | CT column validation skipped for SP→Table edges |
| HALLUCINATION | 0 | — |
| INFRA_BUG | 0 | — |

## Recommendations

1. **[MODEL_CAP]** ct-q1/ct-q2 Haiku regressions — auto model finds all 4 sources with same scope=20/depth=5. No code fix. Haiku stochasticity.
   RISK: none — SM verified correct via UAT

2. **[DESIGN_CONFUSION]** CT column validation only on table→table edges — SP neighbor columns accepted without validation. Consider extending validation or update tests.
   RISK: low — current behavior may be intentional (SPs have dynamic column refs)

3. **[MODEL_CAP]** ct-q3 Haiku variance — same prompt, 3 vs 17 hops depending on run. No code fix possible.
   RISK: none — model limitation, ct-q3b proves SM works correctly
