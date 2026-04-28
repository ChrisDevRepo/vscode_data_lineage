# Feature Tests — flow-path catalogue

The 6 baseline cases under `tests/cases/*.md` exercise the **happy path** through one classification (business / technical / both) × one delivery (inline / SM) × one mode (BB / CT). They do NOT exercise the conversational paths — refine rounds, gate cancel, follow-up text edits, prunes, supplements, follow-up chips, NL exclusion translation, or the engine's mechanical rejections.

This catalogue maps every flow path to a runnable case. Each case file follows the same authoring shape as the baseline cases (Question / Classification / Expected Outcome / Required Nodes / Optimal Path / Verification Rules / Evaluation Notes). A case is "feature-runnable" when the autonomous mocha test + auto-orchestrator can drive it end-to-end without orchestrator changes; otherwise the file lists the harness extension required.

## Catalogue

| ID | Feature surface | Phase / Path tested | Harness ready |
|---|---|---|---|
| `F-DISC-01-refine-once.md` | One refine round before approve | discovery → gate → user changes filter → gate re-emitted → approve | needs orchestrator refine flag |
| `F-DISC-02-refine-multi.md` | Three refine rounds before approve | discovery → gate → 3× user filter changes → finally approve | needs orchestrator refine flag |
| `F-DISC-03-cancel.md` | User cancels at gate | discovery → gate → reject → exploration never starts | needs orchestrator cancel flag |
| `F-ACT-01-prune-utility.md` | AI applies prune verdict to utility nodes | active → submit_findings(verdict=prune) for uspLogError / ErrorLog | yes (already exercised in baseline) |
| `F-ACT-02-pass-passthrough.md` | AI applies pass verdict to wire-only nodes | active → submit_findings(verdict=pass) for SELECT *  / synonym | yes |
| `F-ACT-03-route-reject-recover.md` | Invented nodeId → fuzzy-candidate envelope → recovery via search | active → bad route_request → reject + candidates → AI search → re-submit | needs real-Haiku capture |
| `F-NL-01-named-exclude.md` | NL "ignore SPs X, Y, Z" → excludeNodeIds | discovery → user names identifiers → start_exploration with excludeNodeIds[] | needs real-Haiku discovery |
| `F-NL-02-overgeneralized.md` | NL identifiers vs `excludeTypes` overreach | discovery → AI passes excludeTypes when user named identifiers → `nl_filter_overgeneralized` rejection | needs real-Haiku discovery |
| `F-NL-03-unknown-id.md` | excludeNodeIds with non-existent id | discovery → AI invents id in excludeNodeIds → `unknown_node_ids` rejection | needs real-Haiku discovery |
| `F-FUP-01-text-edit.md` | Post-synthesis text edit | completed → user asks "rewrite Writers section" → AI re-calls present_result | needs multi-turn harness |
| `F-FUP-02-prune-node.md` | Post-synthesis node removal | completed → user asks "remove node X" → AI re-calls present_result without it | needs multi-turn harness |
| `F-FUP-03-supplement.md` | Post-synthesis supplement add | completed → user asks "include deferred node Y" → AI calls start_exploration({supplement: {nodeIds:[Y]}}) | needs multi-turn harness |
| `F-FUP-04-followup-chip.md` | Follow-up chip rendered + click | completed → chat shows "Follow-up: Explore related objects…" → click expands deferred_questions | needs chat-feedback harness |
| `F-FUP-05-show-description.md` | Show-full-description chip | completed → "Show full description" chip → replays cached lastPresentResultDescription | needs chat-feedback harness |
| `F-SYN-01-grouping.md` | Same-shape slot grouping | synthesis → 3+ identical sibling slots → one entry with `node_ids[]` + comparison table | yes (covered indirectly) |
| `F-SYN-02-warning-preserve.md` | ⚠️ preservation through synthesis | synthesis → every captured ⚠️ appears verbatim in `result_graph.description` | yes (covered indirectly) |
| `F-SYN-03-classification-lock.md` | Mission-type lock honored | synthesis → business-only mission omits SQL-fence / loading_pattern technical content | yes |
| `F-SYN-04-loading-pattern.md` | `loading_pattern` template fires only on technical/both | synthesis → technical mission emits closing ETL-shape line; business mission omits | yes |
| `F-ENG-01-scope-budget.md` | Engine scope_exceeds_budget guard | start_exploration with very large origin/depth → `scope_exceeds_budget` returned | yes |
| `F-ENG-02-bipartite-table.md` | Starting from a table; table in scope but not a hop target | start_exploration on a table → bodied neighbors enter agenda; origin table also a hop slot | yes (Employee covers it) |

## Harness gaps & how to fill them

| Gap | Required change | Effort |
|---|---|---|
| Orchestrator refine flag (`ORCH_REFINE_COUNT=N`) | `tmp/auto-orchestrator.py` — when handling first start_exploration, emit a refine call (different filters) before letting the gate approval pass through. Counter decrements until 0; then approve. | small (~30 min) |
| Orchestrator cancel flag (`ORCH_CANCEL_AT_GATE=1`) | `tmp/auto-orchestrator.py` — emit `POST /gate {approved: false}` instead of approve. | small |
| Multi-turn follow-up harness | `tests/e2e/suite/eval/eval.test.ts` — after autonomous loop drains, call handler again with a follow-up question; orchestrator handles the new turn (text-edit / prune / supplement). | medium (~2 h) |
| Chat-feedback chip harness | mocha test — capture `provideFollowups` output post-completion, click one chip programmatically by re-calling handler with the chip's `prompt` value (the `RECOMMEND_FOLLOWUPS_TRIGGER` / `SHOW_DESCRIPTION_TRIGGER` magic strings are already detected by `handleChatRequest`). | small |
| Real-Haiku capture turns | dispatch a Haiku Task per `req-*.json` (existing handshake mode + per-turn dispatch) instead of canned auto-orchestrator. Cost ~12 Tasks per medium case. | none — protocol exists, only cost. |

## Anti-overfitting rule

Per `.claude/rules/eval-validity.md` and `EVAL-RUBRIC.md` Rule 1: **no test-specific node / schema names in production prompts**. Feature-test cases use generic placeholders or fictitious names (`tableA`, `viewOrders`, `procX`) wherever possible. The case file may name real fixture nodes for `Required Nodes` / `Forbidden Nodes`, but the question wording must remain user-natural.

## Running

| Mode | Command |
|---|---|
| Single feature case (real-Haiku capture, real-Haiku synthesis) | `python tests/eval/run.py F-DISC-01-refine-once` (orchestrator chooses real-Haiku per `EVAL_REAL_HAIKU=1`) |
| Single feature case (canned capture, real-Haiku synthesis) | `ORCH_DEFER_SYNTHESIS=1 python tests/eval/run.py F-FUP-01-text-edit` then dispatch Haiku per deferred req |
| All baseline + feature cases | `bash tmp/run-all-cases.sh` (extend `cases=()` to include feature ids) |

## Reading reports

`test-results/eval-bridge/<case-id>.report.md` — 12-section per-case report with KPIs, bridge JSONL excerpts, DQS analysis, score, structural KPIs. Same format for baseline + feature cases.
