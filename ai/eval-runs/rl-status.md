# RL Status — Eval-Loop Reinforcement Learning Tracker

> Updated per RL iteration. Read this at session start to know where to continue.

## Current Iteration

**Iteration:** 6 — Bounded BFS Scope Eval + Bridge Sync
**Status:** EVAL COMPLETE — 24 tests run, baseline updated
**Branch:** `fix/bounded-bb-scope`

### Changes Tested (this iteration)
| File | Description | Commit |
|------|-------------|--------|
| `src/ai/smBase.ts` | bfsScope() with depth parameter, queue tracks {id, depth} | e4f9dfb |
| `src/ai/blackboardState.ts` | expandFrontier() method, init() accepts depth | e4f9dfb |
| `src/ai/columnTraceState.ts` | bfsScopeViaIndex() with depth, init() accepts depth | e4f9dfb |
| `src/extension.ts` | depth clamping [1,20] default 5, expand_frontier tool registration | e4f9dfb |
| `package.json` | depth param on start_exploration + start_column_trace, expand_frontier tool | e4f9dfb |
| `test-internal/dispatcher.ts` | Bridge sync: depth param on CT + BB init, expand_frontier case | this session |
| `src/ai/smPrompts.ts` | sections depth — full fidelity transfer | 2384cff |
| `src/extension.ts` | invocationMessage shows Node X of Y with dynamic total | bc283e0 |

### Eval Run: run-2026-04-12T10-00 (24 tests)

| Test | Grade | SM Type | Scope | Hops | DQ% | vs Baseline |
|------|-------|---------|-------|------|-----|-------------|
| bb-q1-employee | PASS | bb | 46 | 11 | 100% | STABLE |
| bb-q2-employee-deep | PASS | bb | 9 | 8 | 100% | STABLE |
| bb-q4-sales | PASS | bb | 15 | 14 | 100% | STABLE |
| bb-q5-cadenceworker | **PASS** | bb | 30 | 20 | 80% | **IMPROVED** (FAIL→PASS) |
| bb-q6-production-filter | PASS | bb | 7 | 6 | 100% | STABLE |
| bb-q7-cadence-add-ids | PASS | bb | 30 | 5 | 100% | STABLE |
| bb-q8-scope-broad | PASS | bb | 14 | 13 | 100% | STABLE |
| bb-q9-cadence-early-complete | PASS | bb | 38 | 2 | 100% | STABLE |
| bb-q10-ai-report-sources | PASS | bb | 20 | 19 | 89% | NEW |
| bb-q11-ai-staging-impact | PASS | bb | 11 | 9 | 89% | NEW |
| ct-q1-totalrevenue | PARTIAL | ct | 28 | 7 | 86% | MODEL_CAP |
| ct-q2-adjustedrevenue | PARTIAL | ct | 20 | 12 | 82% | MODEL_CAP |
| ct-q3-customersegment | WARN | ct | 20 | 17 | 29% | MODEL_CAP |
| ct-q3b-customersegment-tight | PASS | ct | 20 | 3 | 100% | NEW |
| ct-q3-aw-businessentityid | PASS | ct | 4 | 3 | 100% | STABLE |
| ct-q4-tricky-rename | PASS | ct | 20 | 6 | 100% | STABLE |
| dep-q1-vemployee | PASS | ct_deps | 13 | 9 | 100% | STABLE |
| rej-ct-focus | PASS | ct | 20 | 13 | 92% | NEW |
| rej-ct-columns | PARTIAL | ct | 28 | 1 | 0% | NEW (DESIGN_CONFUSION) |
| rej-bb-focus | PASS | bb | 9 | 8 | 100% | NEW |
| ct-always-reject | PARTIAL | ct | 20 | 1 | 100% | NEW (DESIGN_CONFUSION) |
| guard-bb-direct-neighbor | PARTIAL | bb | 30 | 2 | 100% | NEW |
| scope-bb-out-of-filter | PARTIAL | bb | 30 | 1 | 100% | NEW |
| scope-bb-external | PASS | bb | 20 | 19 | 79% | NEW |
| output-ct-chain | PARTIAL | ct | 20 | 5 | 80% | NEW |
| output-bb-badges | PASS | bb | 30 | 28 | 81% | NEW |

**Summary: 16 PASS, 6 PARTIAL, 2 WARN, 0 FAIL**

### UAT Verification (auto model)
| Test | UAT Result | Haiku Result | Conclusion |
|------|-----------|-------------|------------|
| ct-q2 AdjustedRevenue | 15 hops, 4/4 sources, 21 chain | 12 hops, 0/4 sources | SM correct, Haiku variance |
| ct-q3b CustomerSegment | 3 hops, 4-node chain | 3 hops, 4-node chain | Identical — SM+Haiku agree |
| bb-q5 CadenceWorker | 27 hops, 12/12 required | 20 hops, ~12/12 required | Both PASS |

### Lessons
22. **CT frontier goes beyond BFS depth** — depth=5 scope captures 20 nodes, but CT trace follows column edges to depth 10+. All sources reachable. Haiku PARTIAL is model stochasticity, not scope limitation.
23. **Bridge dispatcher must sync depth + expand_frontier** — missing depth caused unbounded scope in eval. Fixed this session.
24. **CT column validation skips SP neighbors** — validation only runs on table→table edges. Test scenarios rej-ct-columns and ct-always-reject need table edges to trigger.
25. **Guard 0 may not apply to UDF/boundary nodes** — guard-bb-direct-neighbor test: prune of UDF accepted. Investigate if intentional.
26. **Haiku variance remains high** — same scope, same SM, same prompts. ct-q3: 3 hops (auto) vs 17 hops (Haiku). Not fixable with code changes.

### Next
- Investigate Guard 0 enforcement scope (smGuards.ts) — is UDF prune intentionally allowed?
- Investigate CT column validation for SP edges — intentional design or gap?
- Consider adding expand_frontier equivalent for CT (currently BB-only)
- Run critical tests 2-3 times to account for Haiku variance

---

## Previous Iteration

**Iteration:** 5 — Post-Fix Baseline + Progress Line + Section Depth + Bridge Sync
**Status:** COMMITTED (c2be445)
**Branch:** `fix/code-review-cleanup`

_(see previous rl-status.md for full details)_

---

## Baseline (run-2026-04-12T10-00) — CURRENT

| Test | Grade | Hops | Scope | Key Metric | vs Previous |
|------|-------|------|-------|------------|-------------|
| bb-q1-employee | PASS | 11 | 46 | 11/11 nodes | STABLE |
| bb-q2-employee-deep | PASS | 8 | 9 | 8/8 nodes | STABLE |
| bb-q4-sales | PASS | 14 | 15 | open-ended | STABLE |
| bb-q5-cadenceworker | **PASS** | 20 | 30 | ~12/12 nodes | **IMPROVED** |
| bb-q6-production-filter | PASS | 6 | 7 | filter works | STABLE |
| bb-q7-cadence-add-ids | PASS | 5 | 30 | INIT found | STABLE |
| bb-q8-scope-broad | PASS | 13 | 14 | 14 nodes | STABLE |
| bb-q9-cadence-early-complete | PASS | 2 | 38 | CW visited | STABLE |
| bb-q10-ai-report-sources | PASS | 19 | 20 | 3/3 required | NEW |
| bb-q11-ai-staging-impact | PASS | 9 | 11 | 3/3 required | NEW |
| ct-q1-totalrevenue | PARTIAL | 7 | 28 | 0/4 sources (Haiku) | MODEL_CAP |
| ct-q2-adjustedrevenue | PARTIAL | 12 | 20 | 0/4 sources (Haiku) | MODEL_CAP |
| ct-q3-customersegment | WARN | 17 | 20 | over-trace | MODEL_CAP |
| ct-q3b-customersegment-tight | PASS | 3 | 20 | 4-node chain | NEW |
| ct-q3-aw-businessentityid | PASS | 3 | 4 | chain=4 | STABLE |
| ct-q4-tricky-rename | PASS | 6 | 20 | 4 renames | STABLE |
| dep-q1-vemployee | PASS | 9 | 13 | Emp+Person | STABLE |

## Commits (this iteration)

| Hash | Description |
|------|-------------|
| e4f9dfb | feat: bounded BFS scope for SM exploration + expand_frontier tool |
| bc283e0 | fix: invocationMessage shows Node X of Y with dynamic total |
| 2384cff | fix: sections depth — transfer findings at full fidelity |
| (uncommitted) | fix: bridge dispatcher depth param + expand_frontier case |

## Recommendations for Codebase

| # | What | Where | Status |
|---|------|-------|--------|
| R1 | CT memory wiring | `columnTraceState.ts` | **DONE** (iter 1) |
| R2 | bb-q5 prune cascade investigation | `smGuards.ts` | **RESOLVED** — bb-q5 now PASS |
| R3 | CT result export | `columnTraceState.ts` | **DONE** (iter 1) |
| R4 | eval-suite scope ranges | `eval-suite.yaml` | Deferred |
| R5 | Full regression eval | eval-loop | **DONE** (iter 6) |
| R6 | Explicit JSON examples in agent prompts | `SKILL.md` | **DONE** (iter 5) |
| R7 | Guard 0 enforcement scope | `smGuards.ts` | NOT STARTED |
| R8 | CT column validation for SP edges | `columnTraceState.ts` | NOT STARTED |
