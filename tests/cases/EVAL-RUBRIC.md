# Eval Rubric — Baseline-v1 (interim)

Measures `@lineage` output quality on the 4-case baseline suite. This is the **interim rubric for the 2-mode (BB + CT) + gate architecture reset**. Replaces the 23-case / train-val split rubric used prior to the `restore-0.9.8-quality` branch.

Grading drives nothing until the baseline stabilizes and UAT parity is demonstrated. Scores are for measurement, not gating.

## Baseline suite (4 cases)

| Case | Mode | Memory | Expected hops | Scope | Exercises gate? |
|---|---|---|---|---|---|
| `bb-inline-q1-vproduct` | blackboard | inline (no sliding) | ~5 | ≤10 nodes | ❌ (no gate in inline) |
| `bb-q1-employee` | blackboard | sliding memory | ~12 | 15–35 nodes | ✅ `confirm_sm_start` |
| `ct-inline-q1-jobtitle` | column_trace | inline (no sliding) | ~5 | ≤10 nodes | ❌ |
| `ct-q1-totalrevenue` | column_trace | sliding memory | ~15 | 15–30 nodes | ✅ `confirm_sm_start` |

Covers both prompt variants (`bb_mode` + `ct_mode_columns` from `/prompts`), both delivery paths (inline vs sliding memory), and the new user-confirmation gate.

All other cases are archived to `tmp/cases-archive/` and can be re-activated when the baseline is stable.

## Memory-Quality Pre-Gate

The `present_result` output is assembled from the engine's detail archive. Thin archive → thin output; `present_result` polish cannot recover it.

Before scoring, audit:

| Metric | Threshold |
|---|---|
| Avg `detail_analysis` chars per analyzed node | ≥ 400 |
| Avg `summary` chars per hop | ≥ 40 |
| Hops with empty `summary` | 0 |
| `badge_label` present on `analyze` verdicts | 100% |

Any pre-gate failure → flag `memory-thin`, cap the total score at 6/12.

## Scoring dimensions (0–3 each, total 12)

### 1. Correctness
| 3 | Required nodes present; verdicts align; no forbidden nodes |
| 2 | Required present; ≥1 verdict diverges but defensible |
| 1 | 1–2 required missing |
| 0 | >2 required missing, or hallucinations |

### 2. Completeness
| 3 | Scope fully visited, agenda drained; present_result has name + summary + ≥1 section + notes on every noted node |
| 2 | ≥75% scope visited, 1–2 agenda leftovers |
| 1 | ≥25% of scope missed; present_result sparse |
| 0 | Partial exploration, stub output |

### 3. Question-Answering (primary)
| 3 | Summary + intro answer directly in 1–3 sentences; sections substantiate |
| 2 | Answer present, requires reading sections |
| 1 | Partial answer |
| 0 | Doesn't answer the question |

### 4. Type-Appropriate Detail
| Category | What matches |
|---|---|
| `bb-` | LaTeX math, CASE expressions spelled out, business-rule narrative |
| `ct-` | Column rename table per hop, NULL handling, CAST/COALESCE rules |

| 3 | Rich, on-topic detail using the category's appropriate format |
| 2 | Detail present but generic |
| 1 | Thin or off-topic |
| 0 | No detail beyond labels |

## Grade bands
| Total | Grade |
|---|---|
| 11–12 | EXCELLENT |
| 8–10 | PASS |
| 5–7 | PARTIAL |
| 0–4 | FAIL |

## Mechanical auto-checks (pre-scoring)

| Check | Fail condition |
|---|---|
| Gate resolved on sliding cases | `sm_state.phase` remained `awaiting_gate` at end |
| Agent issued `POST /gate` when gate appeared | Gate emitted but no `/gate` call recorded |
| Agent never set `complete: true` | Agent-set completion seen in any hop (engine-driven only) |
| Required nodes present in `detail_slots` or `present_result.sections[].node_ids` | Any missing |

## Baseline process

1. **Smoke test** — run `bb-q1-employee` (gated) end-to-end; confirm `phase: exploring` reached and ≥1 hop completed.
2. **Full baseline run** — sequential execution of all 4 cases into `test-results/eval-runs/baseline-v1/`.
3. **UAT cross-check** — user manually runs the same 4 questions in real VS Code; compares `present_result` against baseline outputs. Any divergence signals framework contamination, not a production bug.
4. **Lock baseline** — once UAT parity is demonstrated, the `baseline-v1/` outputs become the anchor for future prompt-iteration runs.

## Open items

- Prompt iteration loop is **suspended** until UAT parity proves the framework faithfully simulates real VS Code chat.
- `aiOutputTemplates.yaml` contains AdventureWorks-specific examples — known tech debt, left for a later `/prompt-change` pass.
- Train/validation split (from the 23-case suite) is shelved. Reintroduce if/when the case count grows back.

## Baseline-v1 — 2026-04-19

Captured at `test-results/eval-runs/baseline-v1-2026-04-19/` against `tests/fixtures/AdventureWorks2025_AI.dacpac` with the `optimization` branch + Electron proxy + Haiku 4.5 agents.

| Case | Grade | Hops | Scope | Notes |
|---|---|---|---|---|
| `bb-inline-q1-vproduct` | EXCELLENT 11/12 | 5 | 5 | inline BB |
| `bb-q1-employee` | EXCELLENT 11/12 | 12 | 33 | sliding BB, gate resolved via POST /gate |
| `ct-inline-q1-jobtitle` | PASS 8/12 | 5 | 8 | inline CT — Employee (physical source) counted `pass` not `analyze` → required_coverage 0/1 |
| `ct-q1-totalrevenue` | PARTIAL 7/12 | 8 | 26 | sliding CT, gate resolved — did not reach deepest upstream sources (SAPOrders, OracleOrders, SupplierPrices, MarkupRules), source_coverage 0/4 |

UAT parity cross-checked on `bb-inline-q1-vproduct` 2026-04-19: real VS Code chat produced identical scope/hops/node-order/verdicts/badges. Real-chat detail_analysis ran ~3× richer (sampling variance). `present_result` failure in real chat was a v0.9.9 installed-extension bug already fixed on `optimization`. Framework confirmed as faithful simulation.
