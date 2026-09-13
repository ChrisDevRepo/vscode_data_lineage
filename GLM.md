# GLM.md — Agent Orientation Map

Memory/orientation file for GLM-family coding agents (ZCode, GLM Coding Plan, Claude Code with
GLM). **ZCode reads `AGENTS.md` natively** — that file is the canonical policy; this map summarizes
the repo so an agent can orient in one read and never overrides it. (Internal assistant artifact;
tracked by explicit PM order 2026-09-13.)

## What This Repo Is
`data-lineage-viz` — VS Code extension (TypeScript, strict mode) that visualizes SQL object
dependencies from `.dacpac` files or live SQL Server / Azure SQL / Fabric / Synapse metadata.
React webview graph UI, deterministic parser + graph/BFS core, optional `@lineage` chat participant
driven by the VS Code Language Model Chat provider. Package: `data-lineage-viz` (version is
user-owned — never bump).

## The Solution In One Paragraph
Two ingestion lanes (DACPAC unzip, or live DMV queries after schema selection + platform
detection) converge on one regex SQL parser (`sqlBodyParser.ts` + `assets/defaultParseRules.yaml`)
that produces a single `DatabaseModel`; `graphBuilder.ts` turns it into a graphology graph the
React webview renders (React Flow). On top sits `@lineage`, an optional chat participant:
an outer LangGraph phase graph (discovery → consent gate → active hops → synthesis) drives a
selected model through `vscode.lm`, while a deterministic `NavigationEngine` (SM) owns scope,
agenda, routing, pruning, closure, and termination — the model never owns control flow. Every
boundary (host↔webview, tool input, persisted records) is Zod-validated; the model port is
provider-neutral and always uses `ChatRequest.model`.

## Orientation Map
| Area | Path | Read for |
| --- | --- | --- |
| Agent policy | `AGENTS.md` | Canonical rules: structure, commands, boundaries, security |
| Agent behavior | `CLAUDE.md` | Output style, correctness-first order, CT/BB and guard invariants |
| Runtime contracts | `docs/ARCHITECTURE.md`, `.github/copilot-instructions.md` | Engine/SM/AI lifecycle |
| Developer setup | `docs/DEVELOPER_GUIDE.md`, `CONTRIBUTING.md` | Build, debug, conventions |
| Testing (public) | `docs/EDH_TESTING.md` | EDH lanes, unit gate, what each tier may prove |
| Testing (internal) | `.claude/INTERNAL_TESTING.md` | AI moat: scripted scenarios, real-model lanes, scoring |
| Parser/DMV extension | `docs/PARSE_RULES.md`, `docs/DMV_QUERIES.md` | YAML customization contracts |
| AI prompts/templates | `docs/AI_PROMPTS.md`, `assets/aiOutputTemplates.yaml` | Prompt/template lifecycle |
| Improvement loop | `.claude/skills/improvement-loop/SKILL.md`, `test-results/prompt-stabilization/` | Stabilization loop (orchestrator + dispatched packages). **ALL open tasks live in `test-results/prompt-stabilization/TASKLIST.md` §"Open stack — COMPLETE single source"** — list every open task from there, never from memory; a bare "?" or "status" reports that list. Instrument: `internal-tests/tools/factcheck.py` (`run/agg/compare/baseline/tasks`); captures via `capture_wt.py` (baseline set T2–T8S; CT cases by `--prompts`); hooks retired 2026-09-09 (archive: `test-results/archive/2026-09-09-bigbang/`) |
| Agent skills | `#skills-available-in-this-repo` below | When to invoke which skill |

## Layout (one screen)
```
src/
  engine/        DACPAC/DMV ingestion, SQL parsing (sqlBodyParser), graph build + BFS,
                 column lineage (columnStore/columnTraceView/traceScope), schema projection
                 (schemaProjection/schemaAdjacency/schemaEdgeHelpers), profiling
                 (profilingEngine), persistence (projectStore), display + guards
                 (graphDisplayMode, graphGuards, modeCapabilities, renderConnectivity,
                 nodeDecoration, modelFilters)
    shared/      bridgeContract.ts (single Zod IPC contract), sqlRegex, nodeIdResolution, sqlMetadata
  ai/            @lineage chat runtime
    agent/       agent graph (graph.ts, instructionPlan.ts — owns explorationFacts + the BB/CT
                 classification invariants, entryRouting.ts, slashCommands.ts, stagePrompts.ts, toolAttempt.ts)
    core/ host/  host-loop seam (agentCore.ts) + VS Code integration (agentRuntime.ts)
    model/       model port (modelPort, vscodeModelPort, vscodeLangChainBridge) — request's own model only
    participant/ @lineage chat-participant registration (chatHistoryAdapter)
    prompting/   prompt builders + YAML template rendering (smPrompts, hostPrompts, prompts, templateRenderer, scopeSummaryRenderer)
    runtime/     lineageRuntime.ts (production runtime seam)
    session/     session FSM (session.ts), turnLease.ts (all mutating tool calls), runStore.ts
                 (persisted run records, tolerant read), memory, classification
    sm/          navigation state machine (smBase, smTypes, agendaManager, columnTracer,
                 currentHopActionPolicy, smRouteValidation, smCompleteness,
                 navigationSnapshotSchema, taskLedger) — CT rides the BB spine; no strategy split
    tools/       tool catalog + dispatch (toolDefs, toolSchemas, toolPolicy, registry,
                 toolProvider, presentResult, screenStatePresenter) + handlers/
    interaction/ pure guard rules (rules/: submitFindings, presentResult, startExploration, toolPhase)
    providers/   model-call safety (cancellation, structuredOutput, traceSecurity)
    observability/  wireLog (vscode-free record surface) + aiTraceWriter session NDJSON
  components/ hooks/  React webview UI (ColumnTraceNode column cards; markdown/ = marked + KaTeX + DOMPurify)
  assets/          defaultParseRules.yaml, dmvQueries.yaml, aiOutputTemplates.yaml, demo.dacpac
  tests/           tracked: unit (parser/engine/sm/ai-core/webview), fixtures, integration (EDH), tools
  internal-tests/  gitignored AI moat: harness/, unit/, e2e lanes, replay tools
  docs/            ARCHITECTURE, DEVELOPER_GUIDE, AI_PROMPTS, EDH_TESTING, PARSE_RULES, ...
```

## Commands
| Task | Command |
| --- | --- |
| Build | `npm run build` |
| All unit tests | `npm test` |
| Parser tier | `npm run test:parser` |
| Graph/BFS tier | `npm run test:bfs` |
| Core (parser+engine+webview) | `npm run test:core` |
| Agent runtime tier | `npm run test:runtime` |
| Type check | `npm run typecheck` (+ `npm run typecheck:tests`) |
| Electron EDH lanes | `npm run test:edh` (or `test:bare-environment` / `test:tools` / `test:participant-turn`; kill-switch via `npx vscode-test --label kill-switch`) |
| Pre-merge gate | `npm run gate` |
| Package VSIX | `npm run package` |
| Tool manifest | `npm run generate:tool-manifest` |

## Skills Available In This Repo
Installed under `.claude/skills/` and `.agents/skills/` (plus user-level skill folders). Invoke a skill only
under its own trigger rules — several are explicit-invocation-only.

| Skill | Trigger | What it does |
| --- | --- | --- |
| `improvement-loop` | "continue", "resume", "next", "work the list", "status?"/bare "?", or a session opens with no other explicit task | The mastermind stabilization loop — an orchestrator session, never a worker: bundle open facts, fan out (≤3 live agents), review returns, act. Open work = `TASKLIST.md` §"Open stack" (ruling xxx 2026-09-13: continuous loop, no per-item PM yes/no; PM informed via six-line reports). Fact check via `factcheck.py` (`tasks` = the open GATE list; `compare` vs `BASELINE.json` + last agg decides COMMIT/PUSH). State lives in `test-results/prompt-stabilization/`. Not for a single named bug fix — that is `fix-bug`. |
| `code-review` | Before any merge to main | Full quality gate: multi-persona review (mechanical grep, stale code, logging API, Zod boundaries, theming) + operational gate (build, tsc, tests, VSIX) + auto-fix after approval. Writes `tmp/review-findings.md` with GO/NO-GO. |
| `regression-review` | Broad feature/refactor/AI/graph/parser/UI branches vs main | Branch-vs-main review with a strict no-regression standard: impact map by behavior, invariant list, regression-guard check per changed contract. |
| `documentation-review` | Fact-check docs vs code, TSDoc coverage, noisy/historical comments | Bidirectional docs↔code review: `node .agents/skills/documentation-review/scripts/doc_audit.mjs`, then manual verification of high-severity findings. Review-first; fixes only on explicit ask. |
| `code-simplifier` | User asks to simplify/clean up changed code | Behavior-preserving clarity pass on recently changed or explicitly scoped files. |
| `parser-change` | ANY change to `assets/defaultParseRules.yaml`, `sqlBodyParser.ts`, `dacpacExtractor.ts`, `dmvExtractor.ts`, `modelBuilder.ts` | Mandatory protocol: explicit user approval first, then parser verification before AND after the change (`npm run test:parser`; the old `snapshot-aw-baseline.ts` script no longer exists — commit the protocol's required baseline updates together with the change). |
| `prompt-change` | Any change to prompts, tool descriptions, YAML output templates, slash routing, or AI output quality | Gated workflow separating what the prompt owns from what schemas/runtime enforce; run `node .agents/skills/prompt-change/scripts/prompt_audit.mjs` first. |
| `trace-debug` | **Explicit invocation only** — user names the skill or asks to read a specific trace/NDJSON/sm-dump | Diagnoses AI NDJSON traces, the extension log, SM dumps, `e2e-run` artifacts, Langfuse copies via `python .claude/skills/trace-debug/scripts/analyze_trace.py --workspace .` (auto-discovers; or pass `--trace/--sm-dump/--log` explicitly). Diagnose-only: route fixes elsewhere. |
| `fix-bug` | **Explicit invocation only** (`$fix-bug` or user names it) | Systematic root-cause bug-fix workflow. |
| `release` | **Explicit marketplace publish only** — never for "build/package a vsix" | Full release: version bump, changelog, merge to main, tag, `vsce publish`. |
| `grill-me` | User asks to stress-test a plan | Interview the user about a design until shared understanding. |
| `glm-master-skill` | GLM ecosystem questions | Catalog of official GLM skills; unrelated to the extension runtime. |

## Testing Concept — The Four Tiers
Each tier answers a different question; a green run is evidence **of its tier only**. Never
report "the tests pass" without naming which tiers ran (`docs/EDH_TESTING.md` forbids it).

1. **Deterministic core — no provider, no host.** Vitest unit suites (`tests/unit/`: parser,
   engine, sm, ai-core, webview) with per-file coverage floors on `sqlBodyParser.ts`,
   `graphAnalysis.ts`, `graphBuilder.ts`, `shared/sqlRegex.ts`, `shared/nodeIdResolution.ts`.
   Run: `npm test`, or tiers `test:parser` / `test:bfs` / `test:core` / `test:runtime`.
   Proves: SQL parsing, graph/BFS, state machine, agent-runtime logic under stubbed `vscode`.
2. **EDH smoke lanes — real Electron host, real `vscode.lm`, scripted/no model.**
   `npm run test:edh` runs `bare-environment`, `tools`, `participant-turn`, `kill-switch`.
   Proves: activation, command/tool registration, one turn through the real runtime.
   Never proves answer quality.
3. **Internal AI moat — gitignored `internal-tests/`** (see `.claude/INTERNAL_TESTING.md`).
   `scripted-provider` and `scenario-matrix` drive fixed `S1–S7` scenarios through the production
   runtime against the AdventureWorks fixture with structural ground truth; `tool-visibility` and
   `run-memory-loop` cover tool exposure and run memory. Run via
   `npx vscode-test --config internal-tests/vscode-test.mjs --label <label>`.
   **`S…` case evidence never counts as real-model `T…` evidence** — prompt texts are shared,
   but the model is scripted.
4. **Real-model headless lanes — measurement instrument, not pass/fail.**
   `node internal-tests/tools/e2e-run.mjs --lane <lane> --prompt <one id> --runs <n> --require-lane`
   drives the production pipeline against a real provider; artifacts land in
   `test-results/e2e/<UTC>-<lane>/` (`run.json`, trace NDJSON, sm-state, answer). Follow live with
   `node internal-tests/tools/e2e-watch.mjs`. Export is Langfuse-only. Real-model runs are
   PM-owned spend — the measurement budget in `CLAUDE.md` applies (never re-run an unchanged
   tree; a scorecard report, never a run listing).

**Evidence rules that fail silently:**
- Push gate = `npm run gate` (all steps) + `npm run test:edh` (all four lanes) + type check,
  reported as ONE statement on the exact pushed tree. No partial run, no flake hand-wave.
- Public tracked tests prove the deterministic core + smoke only. Prompt text, scoring, golden
  results, and real-model depth stay in gitignored paths (`internal-tests/`, `test-results/`,
  `tmp/`, `.claude/`) — never widen a tracked test to chase answer quality.
- Live-database/DMV ingestion is manual UAT by design; no runner connects to a database.

## Real-Model Lanes — How To Run And Compare (state 2026-09-06)
Three measured lanes, pinned per arm (changing a lane's model invalidates the corpus — own
re-baseline + approval): `gemini-flash` (`gemini-3.8-flash`), `azure-foundry` (`gpt-5.4-mini`,
pinned in `.env`) and `local-mlx` (`Qwen3.6-35B-A3B-8bit` on oMLX `:8000`; `.env` pins the
measured model; a one-off model id is passed `LINEAGE_LOCAL_MLX_MODEL=…` in the launching
shell and never stored in `.env`). Only the gated lane blocks a push — currently `gemini-flash`
(`GATED_LANES` in `.claude/hooks/ladder.py`, mirrored by hand in `guard.py`); the other lanes
are captured, scored and recorded as sidecars that never block. A fourth lane `zai`
(`glm-5.3-flash` on Z.ai) is wired in `lanes.ts` but deliberately outside
`LANES`/`GATED_LANES`/`REQUIRED_LANES` — unmeasured, and as of 2026-09-05 the account has no
balance (`429 Insufficient balance` on a smoke test), so treat it as unmeasurable until that
clears; wiring it into the gate is its own approval item. Captures run in parallel from separate
per-lane worktrees, the local one detached so its runtime never blocks work. The full scenario
sweep is 8 sequential `e2e-run` invocations (`T1`–`T8`; `T8S` optional extra). Always
pass `--require-lane` — a skipped lane prints `RESULT: NO MEASUREMENT`, which is not a pass.
The `local-mlx` lane serves whatever OpenAI-compatible server `LINEAGE_LOCAL_MLX_BASE_URL`
points at.

Live status (2026-09-06): only `gemini-flash` is up. `azure-foundry` returns 401;
`local-mlx` is down; `zai` still answers `429 Insufficient balance` — unmeasurable until
that clears. Only the gated lane is capturable right now.

Two servers exist on this machine (both configured in the repo-root `.env`):

| Server | Base URL | Key var | Model var | Notes |
| --- | --- | --- | --- | --- |
| oMLX on :8000 (current, verified 2026-09-04) | `http://127.0.0.1:8000/v1` | `LINEAGE_LOCAL_MLX_API_KEY` (`1234`) | `LINEAGE_LOCAL_MLX_MODEL` = `Qwen3.6-35B-A3B-8bit` (pinned, matches `.env`) | Serves `Ornith-1.5-35B-A3B-MLX-4bit`, `Qwen3.6-35B-A3B-8bit`, `Qwen3.8-27B-8bit`, `Qwen3.8-27B-AWQ-4.85bpw` (roster verified 2026-09-13; + Wan2.2 video model, out of scope); mtplx experiment of 2026-09-04 superseded |
| LM Studio | `http://localhost:1234/v1` | `LINEAGE_LOCAL_MLX_API_KEY` (`lm-studio`) | `LINEAGE_LOCAL_MLX_MODEL` (`qwen/qwen3.8-27b`) | A/B alternative; override base URL + key inline when used |

**How to connect (oMLX, verified 2026-09-04):**

```bash
curl -s http://127.0.0.1:8000/v1/models -H 'Authorization: Bearer 1234'   # → oMLX roster incl. Qwen3.6-35B-A3B-8bit
# .env already pins base URL, key, and the measured model — no overrides needed for a measurement
```

**Run (compile first; lane vars as inline env win over `.env`):**

```bash
npx tsc -p internal-tests/tsconfig.integration.json
# oMLX on :8000 (Qwen3.6-35B-A3B-8bit):
env LINEAGE_LOCAL_MLX_BASE_URL=http://127.0.0.1:8000/v1 LINEAGE_LOCAL_MLX_API_KEY=1234 \
  LINEAGE_LOCAL_MLX_MODEL=Qwen3.6-35B-A3B-8bit \
  node internal-tests/tools/e2e-run.mjs --lane local-mlx --prompt T1 --require-lane \
    --timeout-ms 3600000 --out test-results/e2e
# …repeat with T2..T8 (loop over 'for t in T1 T2 T3 T4 T5 T6 T7 T8' in background works well)
node internal-tests/tools/e2e-watch.mjs   # live follow in a second terminal
```

Smoke-check first: `curl -s http://127.0.0.1:8000/v1/models -H 'Authorization: Bearer 1234'`
(currently lists the oMLX roster: `Qwen3.6-35B-A3B-8bit`, `Qwen3.8-27B-8bit`,
`Qwen3.8-27B-AWQ-4.85bpw`). LM Studio equivalent: port `1234`, key `lm-studio`. The model id is
part of the lane pin — a new served model means a new lane model and needs its own re-baseline
before any scored capture.

**The gate decides; reports inform.** `verdict_gate.py` is the one authoritative instrument
(COMMIT/PUSH verdict vs `main` and the last baseline; FAIL under either reference is a FAIL).
`pm_scorecard.py` reports and never decides. The wrapper is
`python3 .claude/skills/trace-debug/scripts/score_and_gate.sh` — it scores the batch, re-scores
references into `test-results/e2e/rescore/<name>/`, and writes `test-results/GATE.txt`; push is
hook-gated on that file at HEAD, never edit it by hand. `evidence_review.py` checks every recorded
source (`run.json`, `present-result.json`, `answer.md`, `sm-state.json`, `hop-log.json`,
`host.log`, `lm-trace/*.ndjson`, Langfuse export) as a gate precondition. One run per prompt —
never repeat a case on the same tree (`guard.py` B3 refuses a (tree sha, case) that already has a
result on disk); capture only the impacted cases while working, the full sweep once on the final
committed tree. Scorer, goldens and thresholds are frozen between baselines (`cycle.py closeout`
→ `cycle.py start`, guard B12); an approved instrument change re-scores every arm.

**Current state (2026-09-06):** `testing03` is the active stabilization branch — HEAD `2e06a6d1`,
66 commits past `origin/testing03`, package version 1.1.1 (`main` is v1.1.0 at `20356737`).
`test-results/GATE.txt` (2026-09-06T06:01:17Z, sha `2e06a6d1`): `gemini-flash` verdict **FAIL** —
batch `m4-6e9c9a92-gemini-flash` vs baseline `m3-5155ebd1-gemini-flash`. The gated lane still has
NO incumbent baseline: the m3 declare was refused on 6 findings, m4 is COMMIT FAIL (2 RED). Top of
the stack: **P1-88**, the instruction-surface course correction (PM ruling 2026-09-06 — surface and
rule-sentence count back to or below `main`; no babysitting sentences; `prompt_audit.mjs --rendered
--fail` is a GATE 1 stop). Loop state and next items:
`test-results/prompt-stabilization/{TASKLIST,HANDOVER,DECISIONS}.md`.

**mtplx sweep, T1–T8S, one run each (2026-09-04, tree `ef77621a`, all 9 cases on disk for this tree —
guard B3 refuses repeats) — compared against the other local-mlx captures (same scorer
`golden_scorecard.py --run-dir … --contract --no-prev`, no judgments exist for any local arm):**

| Case | mtplx `…27b-optimized-speed-v2` (2026-09-04) | 35B `Qwen3.6-35B-A3B-8bit` @ `739076f1` | 35B @ `37875e19` |
| --- | --- | --- | --- |
| T1 | ✅ 100 — 49s, 3 calls | ✅ 100 — 77s, 3 calls | ✅ 99.9 — 12s, 4 calls |
| T2 | ✅ 100 — 53s, 3 calls | ✅ 100 — 70s, 3 calls | ✅ 100 — 12s, 3 calls |
| T3 | ✅ 100 — 28s, 3 calls | ✅ 99.9 — 44s, 5 calls | ✅ 99.9 — 6s, 4 calls |
| T4 | ✅ 100 — 700s, 7 calls | ✅ 100 — 1639s, 7 calls | ✅ 100 — 181s, 10 calls |
| T5 | ✅ 98.5 prov. — 754s, 9 calls | ✅ 100 — 1286s, 9 calls | ✅ 99.8 — 221s, 10 calls |
| T6 | 🔴 **67.7 FAIL** — 872s, 9 calls, 8 golden formulas dropped (formula correctness 43/100) | ✅ 97.7 — 4823s, 17 calls | 🔴 93.5 — 567s, 18 calls, 6 formulas dropped |
| T7 | ✅ 97.4 — 1589s, 15 calls | ✅ 100 — 2208s, 15 calls | ✅ 97.3 — 354s, 16 calls |
| T8 | ❌ hollow, 5 rejections — 1255s, 14 calls | ❌ hollow — 1284s, 13 calls | ✅ 95.5 (1 formula dropped) — 376s, 14 calls |
| T8S | ✅ 99.6 — 1073s, 9 calls | ✅ 99.9 — 1259s, 11 calls | 🔴 84.9 (1 formula dropped) — 101s, 7 calls |
| **Total** | **7 ok + 1 hollow, ~95 min, 0 rejects before T8** | **8 ok + 1 hollow, ~3.8 h** | **9/9 ok, ~33 min** |
| Generation throughput | **19.6 out-tok/s** (125k tok in 6372s gen time) | 8.1 out-tok/s — machine was loaded, not the model | **43.9 out-tok/s** (36df4f2b 43.6, 31d5e7be 45.7 — 35B idle ≈ 44–46) |

**Speed, local vs local:** the mtplx 27B checkpoint is NOT faster than the other local — it is
~2.3× slower. Measured from the wire `generation` records (output tokens / generation seconds,
not wall clock): mtplx 19.6 out-tok/s vs the 35B MoE's steady ~44–46 out-tok/s on the same server
port when idle (`37875e19`/`36df4f2b`/`31d5e7be`). The `739076f1` capture's 8.1 out-tok/s was
machine load, not the model — do not read it as 35B being slow. Generation time ≈ wall time in
the mtplx sweep (6372s gen of ~6270s total), so server throughput is the bottleneck, not tool
turnaround.

Reading of the mtplx run **against the other local runs**: same pass surface as the most recent
35B capture (`739076f1`: 8 scoreable ok + hollow T8, the P1-22 class) but slower than the best
local run (`37875e19`, 9/9 ok in ~33 min). Tool
precision is equal-best locally (zero invalid-tool-input until T8; the 2026-08-30 35B run failed
T4/T5/T6 outright). The real regression is **T6** (formula_correctness is a HARD row): mtplx drops 8 of 14 golden-required
formulas (67.7) vs 6 (93.5) and 0 (97.7) on the 35B arms. Trace-verified 2026-09-04, this is **two
defect classes, not one** — (1) **scope under-expansion** (context defect): the scoping hops stopped at
13 of the 28 upstream nodes — `spImportOrders`, `spCleanOrders`, `spRefreshPrices` and the raw feeds
`SapOrders`/`OracleOrders` (golden `reach_required`) never entered scope, so 4 of the 8 missing
formulas (`negative_qty_clamp`, `orderqty_null_fill`, `orderamount_null_fill`, `markup_default_15pct`)
never appeared anywhere in the trace — never captured, so never carryable; (2) **synthesis-carry** for
the other 4 (`discountval_product`, `unitprice_zero_fallback`, `discount_zero_fallback`,
`region_name_fallback`), all in-scope with DDL fragments present in the trace — the P1-20
mandatory-carry class. Both PROVISIONAL until journaled. Azure `gpt-5.4-mini` (`c9408a87`) remains the
correctness ceiling: 9/9 ok in ~27.5 min, T6 99.9.

**Historical, T1–T8, one run each (2026-08-30, `testing01` tree):**

| Case | oMLX `Qwen3.6-35B-A3B-8bit` (21:20 UTC+2) | Azure `gpt-5.4-mini` (`baseline-main-1.1.0`) |
| --- | --- | --- |
| T1 | ✅ ok, 3 calls, 16s | ✅ ok, 3 calls, 7s |
| T2 | ✅ ok, 3 calls, 13s | ✅ ok, 3 calls, 6s |
| T3 | ✅ ok, 4 calls, 6s | ✅ ok, 3 calls, 4s |
| T4 | ❌ error — 3 invalid-tool-input | ✅ ok, 8 calls, 87s |
| T5 | ❌ error — 1 invalid-tool-input | ✅ ok, 7 calls, 60s |
| T6 | ❌ error — 26 calls, 8 rejects, 18m | ✅ ok, 16 calls, 271s |
| T7 | ✅ ok, 15 calls, 222s | ✅ ok, 15 calls, 214s |
| T8 | ✅ ok, 13 calls, 194s | ✅ ok, 17 calls, 252s |
| **Total** | **5/8 pass, ~27 min** | **8/8 pass, ~15 min** |

LM Studio `qwen/qwen3.8-27b`: **no full T1–T8 capture exists** — only P1 smoke attempts in
`test-results/e2e-smoke/` (7 errors then 1 ok on 2026-08-30). Reading of the 2026-08-30 oMLX run:
the lane was healthy (T7/T8, the harder column-trace loops, passed with zero rejections); failures
clustered on tool-input precision in T4/T5/T6 — a model capability finding for the checkpoint, not
a harness defect.

## Model-Agnostic AI Robustness (PM ruling 2026-09-13)
**Never blame a model in the task list, issue journal, or reports — the goal is a runtime that
works across several models.** An AI failure is framed as a containment gap of the runtime
(model port, agent graph, lane/server config) that any model can hit; the model that exposed it
is evidence, never the verdict. Case in force — 2026-09-13 headless `local-mlx` capture
(`test-results/e2e/ornith-t2-t8-local-mlx`, T2–T8S): T6/T7/T8/T8S ended terminal
`model_output_truncated` because the chain has **no output-ceiling containment at any layer**:
the port sends no `max_tokens` by design (`lanes.ts:68-73`), there is no stream early-abort in
tool-required phases, and the 32,768-token cut was the local server's default cap — so any model
that streams long chain-of-thought into the text channel during a tool-required phase truncates
identically. T2–T5 passed factcheck on the same capture, identical to the pinned lane's arm.
The mitigation seams are model-agnostic by construction (any one suffices): (1) stream
early-abort in tool-required phases at the port boundary, (2) a per-phase completion-token cap,
(3) a request-level `max_tokens` option / lane or server output ceiling. Full package:
`issues/runaway-text-toolcall.md`.

## Hard Rules (short form — full text in `AGENTS.md` / `CLAUDE.md`)
1. Two push gates. GATE 1 deterministic: full `npm run gate` + `npm run test:edh` + type check, green at the exact pushed tree, reported as one statement. GATE 2 measurement: `verdict_gate.py` vs `main` and the last baseline — PUSH needs every row passing on the gated lane `fireworks` (PM ruling 2026-09-06; non-gated lanes — `gemini-flash`, `azure-foundry`, `local-mlx` — are sidecars: recorded and tasked, never blocking) (`test-results/GATE.txt`, hook-enforced; never edit it by hand).
2. Never change the package version, CHANGELOG headings, or `AI_TEMPLATE_SCHEMA_VERSION` without explicit user approval. `AI_TEMPLATE_SCHEMA_VERSION` / `schemaVersion` versions the template schema like DDL, not DML — only a structural change (key/field added, removed, renamed, retyped, moved, made required) warrants a bump; prompt text, wording, examples, and ordering never do.
3. Never commit gitignored artifacts (`AGENTS.md`, `CLAUDE.md`, `GLM.md`, `.claude/`, `.agents/`, `internal-tests/`, `.glm-skills/`, `tmp/`, `test-results/`, `.env*`).
4. `activatePendingExploration` is the only navigation-engine publisher; every mutating AI tool call runs under the active turn lease; model choice is always `ChatRequest.model`.
5. Tracked tests prove the deterministic core only — no prompt text, scoring, or real-model evidence in tracked paths.
6. Log via `src/utils/log.ts` helpers only; single-line output-channel messages.
7. Zod at untrusted boundaries; unknown tool parameters are rejected, never silently stripped.
8. Parser files and prompt surfaces have their own gated skills (`parser-change`, `prompt-change`) — use them.
9. AI failures are framed model-agnostically (PM 2026-09-13): never blame a model — name the runtime containment gap and a fix that works across several models (see §Model-Agnostic AI Robustness).

## Trace Artifacts — What Each Layer Holds (verified on run-T4)
A headless run dir `test-results/e2e/<batch>/run-<Tn>/` carries five files; they are four views
of the same turn, each deliberately lossy in a different way:

| Artifact | Holds | Blind spot |
| --- | --- | --- |
| `lm-trace/trace-*.ndjson` | Lifecycle records (`turn-start`, `phase`, `gate`, `tool`, `turn-terminal`; correlation `requestId`+`seq`) + wire records (`wire-request`/`wire-response` with full messages/tools, `generation` with model/latency/usage; correlation `requestId`+`generation`) | NO prose: no prompt text, no rejection reasons, no budget proximity |
| `sm-state.json` | Navigation-engine snapshot: `scopeNodeIds`, `nodeStates` (verdict `analyze`/`passthrough`/`prune` + reason), `agenda`, `memory` (detailSlots, missionBrief), `engineInternals` (depth budget) | Point-in-time only; mtime-nearest dump may belong to an earlier run — attribute carefully |
| `host.log` | The prose the NDJSON omits: full gate proposal text, `[Attempt]` budget counters, rejection reasons | Pruned by VS Code when captured interactively (not headless) |
| `answer.md` + `present-result.json` | The committed user-visible answer and its structured sections/badges | Nothing about why alternatives failed |
| Langfuse Cloud | Queryable copy of runs exported with `--langfuse` (headless) — opt-in per invocation | Absent unless the flag was set; Copilot-OTel is a separate switch |

Key misread trap (confirmed on T4): `tool` records carry the **UI status phase** (`tool`), never
the graph phase — correlate `requestId`+timestamp with the enclosing wire records to get the real
phase (`detect_entry`, `discover`, `active`, …) before evaluating tool policy. Analyzer:
`python .claude/skills/trace-debug/scripts/analyze_trace.py --workspace .`.

## Environment Gaps Found And Fixed (2026-08-30)
1. **Fresh `npm ci` breaks two ways.** (a) npm 10.9.x does not materialize the target of the
   `langsmith` file-override symlink → `node_modules/langsmith` dangles and the esbuild bundle
   fails with `Could not resolve "langsmith"`. FIXED IN-REPO: the `postinstall` hook runs
   `scripts/repair-langsmith-stub.mjs`, which detects the dangling link and copies the stub in
   (idempotent, offline; manual fallback: `node scripts/repair-langsmith-stub.mjs`).
   (b) A stale `node_modules` (pre-lockfile monaco 0.53) fails the webview build on
   `monaco-editor/editor/editor.api` — the lockfile pins 0.56.0; `npm ci` fixes it, and
   postinstall re-applies repair (a). Toolchain floors (Node ≥20, npm ≥10) are now declared in
   `engines` and documented in `docs/DEVELOPER_GUIDE.md` §Toolchain requirements;
   migration gotchas live in `docs/TROUBLESHOOTING.md` §Development environment.
2. **Vitest worker stack size.** Dagre's recursive layout overflows the worker stack at ≥1500
   nodes (`largeGraph.test.ts`) while Node main-thread and the Chromium webview both succeed.
   Fix: `test.execArgv: ['--stack-size=8000']` in `vitest.config.ts` — vitest 4 reads the
   TOP-LEVEL `execArgv`; `poolOptions.<pool>.execArgv` is silently ignored.
3. **Node stream scheduler drift.** `IterableReadableStream.fromAsyncGenerator` no longer
   read-aheads one chunk on Node 22.23 — `vscode-model-port.stream-ceiling.test.ts` now accepts
   5 or 6 `next()` calls (the invariant — POISON chunk never pulled, stream closed once — is
   unchanged).
4. **`vsce ls` vs npm overrides.** npm ls reports any override-replaced dependency as `invalid`
   regardless of version, failing `vsce ls` (and thus packaging). The gate's
   `assert-package-contents.mjs` falls back to `vsce ls --no-dependencies` when the failure is
   exactly the langsmith-override false positive. `npm run package` now passes
   `--no-dependencies` itself (everything is bundled by esbuild/Vite anyway); direct
   `vsce package` / `vsce publish` invocations still need the flag until npm fixes arborist.
5. **VSIX leak closed.** `vsce` ignores `.gitignore`: `GLM.md`, `.glm-skills/**`, `.agents/**`
   were being packaged into the VSIX. `.vscodeignore` now excludes them and the gate's
   forbidden list flags them (`.glm-skills` + `GLM*`/`AGENTS*` patterns).

6. **`.gitignore` blocked the repair script.** `scripts/*` is ignored wholesale; without a
   `!scripts/repair-langsmith-stub.mjs` negation the `postinstall` hook would reference a file
   missing from the remote — fresh clones would fail again. Added, alongside the script itself.

## Verification Status (2026-09-06, `testing03` @ `2e06a6d1`)
- Tree clean. The 2026-09-05 review session's owed items all landed: `7a966099` (auto-fixes +
  VSIX exclusion), `c739f0a4` (BB differential driver), `76337b07` (P1-61 `structural_callouts`
  one home, schemaVersion 3), `c4dffe2c` (`walkFromEntry`), `8d98c6ab` + `6833d109` (docs);
  GATE 1 was green at `c4dffe2c`.
- Loop commits since: `ea2af760`, `e59aa819`, `db8643b8`, `e7f6c058`, `5155ebd1`, `c7b8a8c5`,
  `6e9c9a92`, `2e06a6d1` — prompt fixes (Hermes/XML prose tool-call recognition, depth seeding,
  read-dedupe, `[Prune]` logging, CT prune-trigger parity, callout classes,
  comment-verification contract).
- GATE 1 not yet re-run on `2e06a6d1` — re-run on the quiet tree before any push.
- Measurement gate: FAIL per `test-results/GATE.txt` (see Current state above).

## LangSmith Containment
Inert behind four layers: the npm `overrides` stub (`stubs/langsmith`), the fail-closed tracing
guard in `src/ai/host/agentRuntime.ts`, the `assert-no-langsmith` gate step, and the
`@langchain/core` pin. Never remove a layer, unpin, or suppress the gate. Trace export is
Langfuse-only via `internal-tests/harness/langfuseExport.ts` — the sanctioned test-only REST
exporter, never upgraded to an SDK.

## Vendored GLM Skills
Official GLM skills (Z.ai) are cloned at `.glm-skills/` (gitignored) — `glm-master-skill/` is the
catalog; per-skill `SKILL.md` files describe OCR, image-gen, and GLM-V capabilities. They require
`ZHIPU_API_KEY` and are unrelated to the extension runtime; treat them as optional agent tooling.
