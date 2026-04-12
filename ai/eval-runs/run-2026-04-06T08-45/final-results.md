# Eval Run — Final Results (2026-04-06)

## All 8 Tests: PASS

| # | Test | Type | Dacpac | Delivery | Filter | Grade | Notes |
|---|------|------|--------|----------|--------|-------|-------|
| 1 | bb-q1-employee | BB (Type 1) | AW | inline | none | **PASS** | 11/11 nodes, 0 errors |
| 2 | bb-q2-employee-deep | BB (Type 1) | AW | inline | none | **PASS** | 11/11 nodes, 0 errors |
| 3 | bb-q4-sales | BB (Type 1) | AW | inline | none | **PASS** | 15 nodes, 3 schemas |
| 4 | bb-q5-cadenceworker | BB (Type 1) | Customer | SM (11 hops) | 4 schemas | **PASS** | 11 nodes, 11 badges, 3 utilities pruned |
| 5 | ct-q1-totalrevenue | CT (Type 3) | AI | SM (5 hops) | none | **PASS** | 17 nodes, 2 branches, 7 renames |
| 6 | ct-q2-adjustedrevenue | CT (Type 3) | AI | SM (14 hops) | none | **PASS** | 21 nodes, 3 branches, 9 renames |
| 7 | ct-q3-customersegment | CT (Type 3) | AI | SM (9 hops) | none | **PASS** | SegmentName→CustomerSegment rename |
| 8 | ct-q3-aw-businessentityid | CT (Type 3) | AW | SM (3 hops) | none | **PASS** | Known FK limitation |

## Fix Applied This Session

Single change: expanded CT mode prompt with explicit field mapping (`focus_node.id → focus_node_id`), column tracking guidance, selectivity, and verdict-all-neighbors instruction.

**Impact:** 3 CT tests went from FAIL/PARTIAL → PASS. Root cause = DESIGN_CONFUSION (not MODEL_CAP).

## Coverage After New Tests (14 total)

| # | Test | SM Type | Delivery | Filter | Special |
|---|------|---------|----------|--------|---------|
| 1 | bb-q1-employee | BB (1) | inline | none | ✓ |
| 2 | bb-q2-employee-deep | BB (1) | inline | none | ✓ |
| 3 | bb-q4-sales | BB (1) | inline | none | open-ended |
| 4 | bb-q5-cadenceworker | BB (1) | SM | 4 schemas | ✓ |
| 5 | ct-q1-totalrevenue | CT col (3) | SM | none | branching calc |
| 6 | ct-q2-adjustedrevenue | CT col (3) | SM | none | 3-branch, hardest |
| 7 | ct-q3-customersegment | CT col (3) | SM | none | rename tracking |
| 8 | ct-q3-aw-businessentityid | CT col (3) | SM | none | FK limitation |
| **9** | **dep-q1-vemployee** | **CT dep (2)** | SM | none | **Type 2 coverage** |
| **10** | **bb-q6-production-filter** | BB (1) | inline | 1 schema | **filter+inline** |
| **11** | **bb-q7-cadence-add-ids** | BB (1) | SM | 1 schema (partial) | **add_ids / out-of-filter** |
| **12** | **ct-q4-tricky-rename** | CT col (3) | SM | none | **rejection recovery** |
| **13** | **bb-q8-scope-broad** | BB (1) | inline | none | **scope_too_broad** |
| **14** | **bb-q9-cadence-early-complete** | BB (1) | SM | 3 schemas | **complete_rejected guard** |

### Coverage Matrix

| Dimension | Covered? |
|-----------|----------|
| All 3 SM types (BB, CT col, CT dep) | ✓ (tests 1-4=BB, 5-8+12=CT col, 9=CT dep) |
| Inline delivery | ✓ (tests 1-3, 10, 13) |
| SM delivery | ✓ (tests 4-9, 11-12, 14) |
| With schema filter | ✓ (tests 4, 10, 11, 14) |
| Without filter | ✓ (tests 1-3, 5-9, 12-13) |
| Partial filter (add_ids) | ✓ (test 11 — staging schema omitted) |
| Rejection recovery (invalid_columns) | ✓ (test 12 — multi-CTE rename chain) |
| scope_too_broad handling | ✓ (test 13 — no direction specified) |
| complete_rejected guard | ✓ (test 14 — must visit direct neighbor) |
| Column selectivity | ✓ (tests 5-8, 12 — trace only relevant columns) |
