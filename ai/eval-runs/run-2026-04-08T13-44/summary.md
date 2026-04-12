# Eval Run — 2026-04-08T13:44

**Branch:** `claude/remove-feature-docs-16Fsf`
**Baseline:** 14/14 PASS (2026-04-06, `feature/eval-loop-improvements`)
**Dacpac tested:** AdventureWorks (7/14 baseline tests)
**Remaining:** AI dacpac (4 tests), Customer dacpac (3 tests) — not yet run

## Key Changes on Branch (vs baseline)

- SM refactor: `smBase` base class, `smPrompts.ts` composable prompt blocks
- CT extends smBase (shared memory model)
- Remove `/document` slash command
- `enrich_view` guard: requires SM result
- Label-section data contract (badges → sections)
- Vite 6.4.1→6.4.2 (CVE)

## Results — AdventureWorks (7/7 PASS)

| Test | Grade | Delivery | Nodes | Hops | vs Baseline |
|------|-------|----------|-------|------|-------------|
| bb-q1-employee | PASS | inline | 12 | 0 | STABLE |
| bb-q2-employee-deep | PASS | inline | 12 | 0 | STABLE |
| bb-q4-sales | PASS | inline | 9 | 0 | STABLE |
| ct-q3-aw-businessentityid | PASS | sm | 4 | 3 | STABLE |
| dep-q1-vemployee | PASS | sm | 13 | 9 | STABLE |
| bb-q6-production-filter | PASS | inline | 7 | 0 | STABLE |
| bb-q8-scope-broad | PASS | inline | 14 | 0 | STABLE |

### Node Coverage Detail

**bb-q1-employee** — all 11 required nodes found:
- ✅ uspUpdateEmployeeHireInfo, uspUpdateEmployeeLogin, uspUpdateEmployeePersonalInfo
- ✅ vEmployee, vEmployeeDepartment, vEmployeeDepartmentHistory
- ✅ uspGetEmployeeManagers, uspGetManagerEmployees
- ✅ vSalesPerson, vSalesPersonSalesByFiscalYears, ufnGetContactInformation
- ✅ No forbidden: uspLogError, uspPrintError, ErrorLog absent

**bb-q2-employee-deep** — identical node set, all 11 required present, no forbidden

**dep-q1-vemployee** — Employee ✅, Person ✅ in chain (both required)

**bb-q6-production-filter** — Production filter active, 7 nodes in scope

**bb-q4-sales** — open-ended, no required nodes. Origin: SalesOrderHeader (reasonable choice)

**bb-q8-scope-broad** — no scope_too_broad error, 14 downstream nodes from Person

**ct-q3-aw-businessentityid** — 3 hops (= baseline), known limitation: FK edges not in graph

### Hop Count Comparison

| Test | Baseline Hops | Current Hops | Delta |
|------|--------------|--------------|-------|
| ct-q3-aw-businessentityid | 3 | 3 | 0 |
| dep-q1-vemployee | 9 | 9 | 0 |

## Finding: CT Memory Gap (DESIGN_CONFUSION)

**Severity:** Low (no correctness impact, output quality only)

**Issue:** `smPrompts.ts` CT mode prompt (step 4) tells the AI to provide `badge_label` and `note_caption`, but the CT tool schema (`submit_hop_analysis` in `package.json`) does not accept these fields. They are BB-only.

**Root cause:** smBase refactor unified memory (`storeDetail()` accepts badge_label/note_caption), but CT's `submitVerdicts()` in `columnTraceState.ts` never calls `storeDetail()`. CT stores findings via:
- `params.notes` → chain entry `.notes` field (line 519)
- verdict `.summary` → chain entry `.summary` field (line 612)
- Badge text derived from node `.name` at result time (line 736)

**Impact:**
- AI wastes tokens generating badge_label/note_caption for CT hops
- CT enrich_view badges use node names instead of AI-generated semantic labels
- No effect on trace correctness (trace/prune/pass decisions unaffected)

**Fix options:**
1. Remove badge_label/note_caption from CT mode prompt in `smPrompts.ts` (quick, honest)
2. Wire CT's submitVerdicts to call `storeDetail()` and accept badge_label/note_caption (larger, enables CT output quality parity with BB)

## Rejection Summary

| Classification | Count | Details |
|---------------|-------|---------|
| DESIGN_CONFUSION | 1 | CT badge_label/note_caption prompt vs schema mismatch |
| INFRA_BUG | 0 | — |
| HALLUCINATION | 0 | — |
| VALID_REJECTION | 0 | — |

## Token Usage

| Test | Tokens | Tool Calls | Duration |
|------|--------|------------|----------|
| bb-q1-employee | 45,041 | 17 | 55s |
| bb-q2-employee-deep | 59,943 | 33 | 298s |
| bb-q4-sales | 59,758 | 45 | 157s |
| ct-q3-aw-businessentityid | 44,475 | 18 | 60s |
| dep-q1-vemployee | 60,797 | 35 | 115s |
| bb-q6-production-filter | 44,198 | 22 | 83s |
| bb-q8-scope-broad | 45,041 | 17 | 56s |
| **Total** | **359,253** | **187** | **~14 min** |

## Status

- ✅ AdventureWorks: 7/7 PASS, 0 regressions
- ⏳ AI dacpac: 4 tests pending (ct-q1-totalrevenue, ct-q2-adjustedrevenue, ct-q3-customersegment, ct-q4-tricky-rename)
- ⏳ Customer dacpac: 3 tests pending (bb-q5-cadenceworker, bb-q7-cadence-add-ids, bb-q9-cadence-early-complete)
- Bridge needs restart with `tmp/AdventureWorks2025_AI.dacpac` for next batch
