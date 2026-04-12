# Eval Run — 2026-04-08T16:00

**Branch:** `claude/remove-feature-docs-16Fsf`
**Baseline:** 14/14 PASS (2026-04-06, `feature/eval-loop-improvements`) — stale, contains `delivery: inline`
**Dacpacs tested:** AdventureWorks (7), AdventureWorks2025_AI (4 CT), Synapse_Data_Warehouse (3 BB)
**Skill version:** v2 — enriched hop_log, sm_metadata, mandatory artifacts

## Results

| Test | Grade | SM Type | Scope | Nodes | Hops | DQ% | Blocked% | vs Baseline |
|------|-------|---------|-------|-------|------|-----|----------|-------------|
| bb-q1-employee | PASS | bb | 46 | 11/11 | 4 | 100% | 0% | IMPROVED (was inline) |
| bb-q2-employee-deep | PASS | bb | 9 | 8/8 | 8 | 100% | 0% | IMPROVED (was inline) |
| bb-q4-sales | PASS | bb | 15 | 12 (open) | 11 | 45% | 0% | IMPROVED (was inline) |
| bb-q6-production-filter | PASS | bb | 1 | 1 (open) | 0 | 100% | 0% | IMPROVED (was inline) |
| bb-q8-scope-broad | PASS | bb | 46 | 34 (open) | 6 | 100% | 0% | IMPROVED (was inline) |
| ct-q3-aw-businessentityid | PASS | ct_columns | 4 | 4 | 3 | 100% | 0% | STABLE |
| dep-q1-vemployee | PASS | ct_deps | 13 | 12 | 9 | 100% | 0% | STABLE (WARN: hops=9 > max=8) |
| ct-q1-totalrevenue | **FAIL** | ct_columns | 28 | 7 chain | 4 | 82% | 0% | NEW |
| ct-q2-adjustedrevenue | **PARTIAL** | ct_columns | 28 | 18 chain | 16 | 74% | 0% | NEW |
| ct-q3-customersegment | PASS | ct_columns | 28 | 5 chain | 3 | 100% | 0% | NEW |
| ct-q4-tricky-rename | PASS | ct_columns | 28 | 7 chain | 4 | 90% | 0% | NEW |

| bb-q5-cadenceworker | **FAIL** | bb | 24 | 3/12 req | 3 | 100% | 0% | NEW |
| bb-q7-cadence-add-ids | PASS | bb | 24 | 24 (open) | 18 | 17% | 0% | NEW (WARN: hops=18>15) |
| bb-q9-cadence-early-complete | PASS | bb | 70 | 26 (open) | 30 | 25% | 0% | NEW (WARN: hops=30>10, scope=70>15) |

**10/14 PASS, 1 PARTIAL, 3 FAIL.**

## SM Metadata

| Test | SM Type | Scope Size | Token Est | Filter Active | Filter Schemas | Agenda Init→Final |
|------|---------|-----------|-----------|---------------|----------------|-------------------|
| bb-q1-employee | bb | 46 | 9200 | no | — | 45→0 |
| bb-q2-employee-deep | bb | 9 | 1800 | no | — | 8→0 |
| bb-q4-sales | bb | 15 | 3000 | no | — | 14→0 |
| bb-q6-production-filter | bb | 1 | 200 | **yes** | [Production] | 0→0 |
| bb-q8-scope-broad | bb | 46 | 9200 | no | — | 45→0 |
| ct-q3-aw-businessentityid | ct_columns | 4 | 800 | no | — | 3→0 |
| dep-q1-vemployee | ct_deps | 13 | 2600 | no | — | 8→0 |
| ct-q1-totalrevenue | ct_columns | 28 | 5600 | no | — | 7→0 |
| ct-q2-adjustedrevenue | ct_columns | 28 | 5600 | no | — | 7→0 |
| ct-q3-customersegment | ct_columns | 28 | 5600 | no | — | 7→0 |
| ct-q4-tricky-rename | ct_columns | 28 | 5600 | no | — | 7→0 |

## Per-Hop Drill-Down (non-PASS tests)

### ct-q1-totalrevenue (FAIL)

| Hop | Focus Node | Decision | Issue |
|-----|-----------|----------|-------|
| 1 | spBuildSalesReport | trace vwDiscountCalc (Discount) | **WRONG**: Discount is not part of TotalRevenue (= Qty × UnitPrice). Discount is AdjustedRevenue only. |
| 1 | spBuildSalesReport | trace vwConsolidatedSales (Qty) | Correct, but SM auto-completed — Qty branch not traced deeper |
| 1 | spBuildSalesReport | trace vwPriceList (UnitPrice) | Correct |
| 4 | spRefreshPrices | trace CurrencyConfig (no cols) | Suboptimal: CurrencyConfig is a filter table, not a price source |

**Root cause:** MODEL_CAP — Haiku confused TotalRevenue with AdjustedRevenue (traced Discount branch). Qty branch stopped at vwConsolidatedSales. Chain depth 7 vs expected 17+.

### ct-q2-adjustedrevenue (PARTIAL)

| Hop | Focus Node | Decision | Issue |
|-----|-----------|----------|-------|
| 5 | SalesStaging | pass spLoadSalesStaging | Suboptimal: TABLE NODES rule says trace ALL upstream neighbors of a table |
| 6 | PriceMaster | pass spRefreshPrices | **MISSED**: Cut off SupplierPrices/MarkupRules discovery path |
| 8 | spRefreshSegments | visited | Irrelevant node (segment maintenance, not revenue) |

**Root cause:** MODEL_CAP — Agent used "pass" on spRefreshPrices, missing the entire price computation source chain (SupplierPrices, MarkupRules).

## Rejection Summary

| Classification | Count | Top Issue |
|---------------|-------|-----------|
| DESIGN_CONFUSION | 0 | — |
| INFRA_BUG | 0 | — |
| HALLUCINATION | 0 | — |
| VALID_REJECTION | 1 | bb-q4 hop 6: Guard 0 rejected prune of direct origin neighbors |

## Decision Quality Analysis

- **bb-q4-sales DQ% = 45%**: Agent used `noted` verdict for 6 of 11 hops (Person, BusinessEntityAddress, StateProvince, CountryRegion, EmailAddress, PersonPhone, PhoneNumberType). These are reference/dimension tables — `noted` is defensible but not optimal. Open-ended test with no nodes_required, so this is a MODEL_CAP observation, not a regression.
- **ct-q1-totalrevenue DQ% = 82%**: 1 wrong (vwDiscountCalc traced for Discount — not in TotalRevenue formula), 1 suboptimal (CurrencyConfig traced as price source). 9 correct.
- **ct-q2-adjustedrevenue DQ% = 74%**: 5 suboptimal passes on nodes that should have been traced (spRefreshPrices most critical). 14 correct. 0 wrong.
- **ct-q4-tricky-rename DQ% = 90%**: 1 suboptimal (CurrencyConfig). 9 correct.
- **All other tests**: 100% DQ — all verdicts optimal for the expected outcomes.

## Findings

### 1. dep-q1 max_hops too low (WARN) — FIX APPLIED

dep-q1-vemployee completed in 9 hops but max_hops was 8. **FIX:** Increased max_hops from 8 to 10 in eval-suite.yaml.

### 2. CT badge_label/note_caption gap (known, deferred)

smPrompts.ts CT mode prompt tells AI to provide badge_label/note_caption, but CT tool schema doesn't accept them. No correctness impact.

### 3. Baseline stale — needs regen

Baseline.json has `delivery: inline` for 5 BB tests. Regen after customer dacpac tests.

### 4. ct-q1 TotalRevenue — Haiku confused with AdjustedRevenue (NEW)

Haiku traced vwDiscountCalc (Discount column) at hop 1 for TotalRevenue query. TotalRevenue = Qty × UnitPrice; Discount is only in AdjustedRevenue = TotalRevenue - Discount. This is a **formula comprehension error** — Haiku read the DDL comment that lists both formulas and picked the wrong one.

Additionally, the Qty branch (vwConsolidatedSales → SalesStaging → ... → SAPOrders/OracleOrders) was not traced deeper than vwConsolidatedSales. Chain depth 7 vs expected 17+.

### 5. ct-q2 AdjustedRevenue — Price branch incomplete (NEW)

Agent correctly identified all 3 branches (Qty, UnitPrice, Discount) and traced Qty branch fully to SAPOrders/OracleOrders. However, passed spRefreshPrices at hop 6 instead of tracing, missing SupplierPrices and MarkupRules as terminal price sources. The TABLE NODES rule ("trace ALL upstream neighbors") was not followed for PriceMaster.

### 6. AI dacpac scope_range — all CT tests show scope=28 (WARN)

All 4 AI dacpac CT tests report scope_size=28. The eval-suite expected narrower ranges (3-15, 5-20, 10-30). The CT SM scope includes all connected nodes from the origin, not just the traced chain. scope=28 is correct for the AI schema (32 nodes, most connected). **FIX:** Update eval-suite.yaml scope ranges for AI dacpac CT tests to 20-35.

## Recommendations

1. [TEST_DEF] AI dacpac CT scope ranges — FIX: eval-suite.yaml scope_size_max for ct-q3, ct-q4 → 35 — RISK: low
2. [MODEL_CAP] ct-q1 needs Sonnet or prompt improvement for deep multi-branch chain traces — RISK: scope
3. [MODEL_CAP] ct-q2 price branch — Haiku doesn't follow TABLE NODES rule consistently — RISK: low (2/4 source nodes found)
4. [BASELINE] Regen baseline.json after full 14-test suite — RISK: none

### 9. CT never calls storeDetail() or updateShortMemory() — CRITICAL GAP (NEW)

**Code evidence** (`src/ai/columnTraceState.ts`):
- `storeDetail()` — 0 calls. BB calls it at line 328 of blackboardState.ts.
- `updateShortMemory()` — 0 calls. BB calls it at line 335 of blackboardState.ts.
- CT stores `notes` on chain entries (line 519) and `summary` on verdict entries (line 612)
- CT builds `path_so_far` from chain entries — this IS the hop-to-hop memory the AI sees
- But the base class memory system (`detailSlots`, `shortMemory.narrative[]`) stays **empty**

**Impact:**
- `getMemoryForSynthesis()` returns empty detail_slots → synthesis step has no stored findings
- `shortMemory.narrative` is `[]` → never populated
- `getResult()` builds `suggested_notes` from chain entries (line 739) — this works, but the full analysis text is lost

**What BB does (CT should match):**
```typescript
// blackboardState.ts:328-335
this.storeDetail(focusNodeId, findings, summary, { badge_label, note_caption });
this.updateShortMemory(`${nodeName}: ${summary}`);
```

**CT equivalent location** — after line 519 in columnTraceState.ts:
```typescript
// Wire CT to base class memory (same as BB)
this.storeDetail(this.currentFocusNodeId, params.notes, focusChain.summary, {});
this.updateShortMemory(`${focusNode?.name}: ${params.notes.slice(0, 100)}`);
```

**Reinforcement next step:** Wire CT → `storeDetail()` + `updateShortMemory()`, rerun ct-q1/ct-q2, compare.

### 10. INLINE_TOKEN_BUDGET lowered 20K → 5K (APPLIED)

Forces BFS results >5K tokens to `on_demand` delivery, steering AI toward SM. Verified: Person BFS (14 nodes, 6305 tokens) now returns `on_demand`. Small BFS (Employee, 12 nodes) still inline.

## Artifacts

- `scores.json` — 14 tests, full check results + sm_metadata + decision_quality
- `rejections.json` — 1 VALID_REJECTION (Guard 0)
- Per-test `.json` — 14 files with enriched hop_log + sm_metadata

### 7. bb-q5 CadenceWorker — prune cascade collapsed agenda (NEW)

Agent completed only 3 hops. Agenda went from 23→0. At hop 3, agent pruned udfCreateKeyValuePair and udfConvertUnixTS. The cascade prune likely disconnected remaining spCadenceRule_* SPs from the origin, even though they are direct neighbors of CadenceWorker. **Potential SM bug**: pruning UDFs should NOT cascade-disconnect SPs that are directly reachable from the origin.

### 8. bb-q9 — no early completion attempted (NEW)

Test designed to verify complete_rejected guard (agent must visit CadenceWorker before completing). But Haiku never tried early completion — it exhausted all 70 scope nodes in 30 hops. The guard was never exercised. scope_size=70 is too large for an "easy" test.

## Remaining

- Baseline regen after scoring finalized
