# Testing

The single reference for test tiers, lanes and commands. Machine needs are in [Test environments](ENVIRONMENTS.md).

## Default checks

These need no database, model provider or display. Parser and lineage scenarios are zero-regression. Run tests and `npm run gate` only when code changes need verification and before a push; do not redundantly re-test already verified changes before commit, and when no code changes are done, no test run must be performed.

| Command | What it runs |
|---|---|
| `npm test` | Parser, lineage and the deterministic AI/trust contracts in `tests/tools/unit-lanes.mjs` |
| `npm run test:core` | Parser and lineage |
| `npm run test:parser` | Parser only |
| `npm run test:lineage` | Lineage only (`test:bfs` is the same lane) |
| `npm run test:runtime` | Backend graph contracts, tool registration/dispatch, identifier boundaries, schema, redaction, cancellation, templates and `scripted` catalog rows |
| `npm run test:support` | Webview, database connection, AI routing and operator tools (not in `npm test` or the gate) |
| `npm run typecheck`, `npm run typecheck:tests` | TypeScript checks; there is no lint script |
| `npm run gate` | Everything above except `test:support`, plus coverage floors, build and repository checks; CI runs this |

A path argument to `test:core`, `test:lineage`, `test:runtime` or `test:support` runs that file only: `npm run test:core -- tests/unit/parser/identifier-case.test.ts`.

Every rendered model-visible text (stage prompts, output templates, hop and synthesis messages, served tool schemas, the rejection table) is stored under `tests/unit/ai-core/__model_visible__/` and compared by [`model-visible-requests.test.ts`](../../tests/unit/ai-core/model-visible-requests.test.ts) on the gate. A change to any of that text fails the lane until the stored text is regenerated with `node tests/tools/run-vitest.mjs run tests/unit/ai-core/model-visible-requests.test.ts -u` in the same commit; a regenerated snapshot marks that commit as a prompt change.

The gate prints `PASS`, `FAIL` and `SKIP` per step and exits nonzero on any `FAIL`. A `SKIP` is unverified: the template-schema step skips without a `v*` tag or `origin/main`, and fails instead when `CI` is set. Failed step logs and `test-results/gate/summary.json` (step outcomes, unit test counts) stay in untracked local output.

## Ownership and evidence

Each contract has one owning suite. **Unit contracts** invoke a schema, rule or graph API directly. **Functional contracts** run real handlers, registries or the navigation engine with supplied messages and assert rejection, state and delivered results. Both run in ordinary Vitest lanes. **Host/end-to-end checks** exercise VS Code or rendered UI; live model answers need separate SQL review. Fixed responses prove wiring and lifecycle.

| Production contract | Owning executable tests | Level / lane |
|---|---|---|
| [SQL parsing](../../src/engine/sqlBodyParser.ts) and extractors | [parser catalog runner](../../tests/unit/parser/tsql-coverage-matrix.test.ts), focused `parser` suites | Unit / core |
| [Traversal](../../src/engine/graphBuilder.ts) and [removal policy](../../src/engine/graphGuards.ts) | [traversal cases](../../tests/unit/engine/traversal-edge-cases.test.ts), [removal cases](../../tests/unit/engine/directed-removal-policy.test.ts); `graphBuilder` suites own construction/layout/extraction integration | Unit + functional / core |
| [Tool catalog](../../src/ai/tools/toolDefs.ts), [policy](../../src/ai/tools/toolPolicy.ts) and registry | [registration](../../tests/unit/ai-core/ai-tool-registration.test.ts) | Unit + registry / runtime |
| [Zod/tool schemas](../../src/ai/tools/toolSchemas.ts), provider projection and [error envelopes](../../src/ai/support/toolErrorEnvelope.ts) | [findings schemas](../../tests/unit/ai-core/submit-findings-schema.test.ts), [issue matrix](../../tests/unit/ai-core/zod-issue-matrix.test.ts), [envelopes](../../tests/unit/ai-core/tool-error-envelope.test.ts), [malformed objects](../../tests/unit/ai-core/tool-boundary-malformed-input.test.ts) | Unit / runtime |
| [Start rules](../../src/ai/interaction/rules/startExplorationRules.ts), [submit rules](../../src/ai/interaction/rules/submitFindingsRules.ts) and raw handler admission | [tool boundaries](../../tests/unit/ai-core/tool-boundary-precedence.test.ts) | Functional / runtime |
| [Instruction delivery](../../src/ai/agent/instructionPlan.ts), [model port](../../src/ai/model/vscodeModelPort.ts) and [dispatcher](../../src/ai/agent/toolAttempt.ts) | [dispatcher matrix](../../tests/unit/ai-core/dispatcher-matrix.test.ts); malformed transport, unavailable calls, conditional tools, pairing, siblings and budgets | Unit + functional / runtime |
| [BB/CT engine](../../src/ai/sm/smBase.ts), [routing](../../src/ai/sm/smRouteValidation.ts), [task ledger](../../src/ai/sm/taskLedger.ts) and [column tracing](../../src/ai/sm/columnTracer.ts) | [lineage runbooks](../../tests/unit/backend/lineage-cases.test.ts), [BB shapes](../../tests/unit/backend/bb-lineage-shapes.test.ts), [function columns](../../tests/unit/backend/function-column-contracts.test.ts) | Functional / runtime |
| [Presentation schemas](../../src/ai/tools/toolSchemas.ts), [shared drafts](../../src/ai/support/toolDraft.ts) and [ingestion](../../src/ai/support/toolIngestion.ts) | [schemas](../../tests/unit/ai-core/present-result-schema.test.ts), [repairs](../../tests/unit/ai-core/present-result-repair.test.ts), [coverage](../../tests/unit/ai-core/present-result-coverage.test.ts) | Unit + functional / runtime |
| [Presentation handler](../../src/ai/tools/handlers/presentResult.ts) | [functional presentation](../../tests/unit/ai-core/present-result-functional.test.ts), [SQL/evidence boundary](../../tests/unit/ai-core/present-result-sql-fence-boundary.test.ts) | Functional; SQL expansion also unit / runtime |
| Storage, database adapters and webview | Owning `engine`, `engine/db` and `webview` suites | Unit + functional / support |
| VS Code API, native controls and live answers | [host tests](../../tests/integration), Electron/Playwright/headless commands below | Optional host/end-to-end or live review |

`tests/tools` owns execution and partition checks; `tests/unit/helpers` owns shared input builders; domain helpers stay beside their suites. `tests/cases` and typed rows own independently authored inputs and expectations. `tests/harness` adapts the real runtime for optional service checks. There is no universal runbook interpreter. Add a regression or hypothesis as a row in its owner; do not repeat the same rule's matrix in every layer or enumerate arbitrary combinations without expected outcomes.

Presentation repair owners cover large held bodies, whole-list replacement, preview start corrections, malformed retries and complete-candidate validation. Small corrections prove transport retention, not inference cost or answer quality.

The tool-boundary suite covers malformed findings repairs without losing held content. Description-render parity tests also assert raw HTML escaping, unsafe URL removal, section-id restrictions and sanitizer isolation.

The gate runs core once and runtime once, with disjoint file membership; duplicate declarations fail partition validation. `npm test` is their aggregate, parser/lineage commands select subsets, and `test:bfs` aliases lineage. These selectable commands are not extra gate executions. Path arguments override the lane selection.

The partition check requires the complete aggregate npm recipes and enabled core coverage. It rejects filters, shell suffixes, embedded command newlines and coverage-disabling flags in those recipes. Pass options or file filters to an individual run after `--` instead.

A shared shape or SQL input across entry boundaries is retained only for a distinct contract, with independently authored acceptance/rejection expectations.

## Case catalogs

Add a supporting check as one row in an existing file or case catalog; a new file needs a contract no lane already owns. Coverage floors stay at their current numbers.

- SQL/parser case: one row in `tests/cases/parser/exact-edges.yaml`, run by `tsql-coverage-matrix.test.ts`, with `id`, `description`, `sql` and exact `sources`, `targets`, `exec`, `cross_db_sources` and `cross_db_targets` lists (omitted lists mean empty). Optional `case_modes: [ci, cs]` preserves case-sensitive scenarios; the default is `[ci]`. Add exact `mutations` or `external` lists when those contracts matter. For model behavior, add `graph` with independent `tables`, catalog `metadata`, optional `current_database` and the complete expected `edges`, including type and `deleteOnly`; the subject procedure is `gen.Subject`. Do not derive expected graph edges from parser output. Keep custom-rule setup, extractor/API contracts and generated performance cases in their existing tests.
- AI column-trace state contracts (not deterministic SQL-to-column inference): a `runners: [scripted]` row in [`tests/cases/lineage-cases.yaml`](../../tests/cases/lineage-cases.yaml), run by `tests/unit/backend/lineage-cases.test.ts` on `npm run test:runtime` and the gate.
- Playwright, Electron and headless rows use the matching `runners` tag and stay outside the gate. Keep the prompt and expected result on the row, not in the runner.

The backend catalog's `contract: stored-arrival` rows share one producer → table → receiver fixture. Each row declares receiver type, SQL and column metadata, supplied `column_flow`, and independent expected mapped inputs, receiver rows, sink mode and sink columns. An unmapped candidate ends at the receiver without a rejection. Adding another consumption variant needs a row, not another runner. Keep unique contracts such as separate write destinations, final endpoints and sibling independence as focused tests, using shared graph/render setup. Do not derive expected results from the submitted mappings or from production output.

The same catalog's `contract: self-prune` rows declare a `story`, BB/CT `mode`, route fixture, optional `sender_verdict`, `graph.edges` and independent `expect` values. Use `mode: [bb, ct]` when both modes share the fixture and expectations; each still runs separately with its mode-prefixed case ID. They check the single eligibility rule (routing through passthrough), immediate hard cuts, shared descendants and removal of cut column evidence. Tool-boundary and dispatcher tests check conditional delivery, strict input and shared completion. These are backend enforcement tests, not evidence that the model judged SQL relevance correctly.

The same catalog's `contract: walk` rows are run by `tests/unit/backend/lineage-walk.test.ts` through the registered tools. A row declares a synthetic graph (object types, columns, `[source, target]` edges, optional `excluded` and `levels`), `mode`, `direction`, the decisions per hop in walk order (`map`, `ask`, `prune`, and an optional `refuse` carrying the rejection code, field path and issue code the backend must return before the correction in `decide`) and the independent final nodes, edges and column edges. Decisions are semantic and use short object names. `authorReply` in [`walkRows.ts`](../../tests/unit/backend/helpers/walkRows.ts) is the only place that turns a decision into the current wire shape, so a contract change edits that function and no row. Every hop of every row, scripted or generic (ask every open neighbor ahead), is checked for: (a) no served list offers entries that no allowed value satisfies, and the reply built from the allowed values is admitted by the served schema; (b) the hop message names every endpoint of the current column tasks; (c) a refused reply returns the expected rejection, and the correction changes only the fields the rejection names; (d) every correction is accepted and the walk ends complete. The generic walk also checks (e) that the delivered graph equals the independent directed closure of the origin.

The runner creates synthetic objects from edge endpoints and qualifies short names in schema `d`. [`makeIndexedModel`](../../tests/unit/helpers/modelFixtures.ts) builds complete neighbor metadata; existing [`makeGraph`](../../tests/unit/helpers/modelFixtures.ts) builds the directed graph. Other fixtures can reuse these builders with explicit object types, columns and SQL. `makeModel` retains its empty-index default for missing-metadata tests. [`generateDwhModel`](../../tests/unit/helpers/dwhGraphGenerator.ts) remains the larger dataset/scale generator; its extractor round-trip and backend graph checks through 5,000 objects run in core. Layout remains in `test:scale`.

For an inherited case, `Origin` directly reaches `Current`; arbitrary continuation edges after it need only a catalog row. See the diamond rows in [`lineage-cases.yaml`](../../tests/cases/lineage-cases.yaml) for complete examples. The helper generates structure, never expected cuts: `expect.unvisited`, `pruned`, `inspected`, `kept` and `edges` are authored independently. Tests check the exact cut immediately, then the remaining visits and complete surviving graph. Mode lists and YAML anchors reuse fixtures and expectations.

The BB graph suite runs named graph regressions in `npm test`, `npm run test:runtime` and `npm run gate`. Expected nodes are declared independently; expected edges use those expected nodes, never the returned graph. Connectivity checks on returned data are additional invariants, not completeness oracles. Mixed prune/question/mapping submissions and rejected-submission atomicity use focused regressions with explicit expected graphs and column endpoints. Add a hypothesis as a typed row in its owning suite; retain a discovered failure as a regression.

## Backend contract inventory

The source catalog is `src/ai/tools/toolDefs.ts`; availability is owned by `toolPolicy.ts`, narrowed in `agent/instructionPlan.ts` and checked again by `ToolHandler.authorizeTool`. The table lists every tool (omit the common `lineage_` prefix). Stages: D discovery, E entry, B active BB, T active CT, P preview, S synthesis, C completed, X other VS Code agents. X is a caller surface, not an external graph object.

| Tool | Input boundary in `src/ai/tools/toolSchemas.ts` | Allowed stages |
|---|---|---|
| `get_context` | `GetContextInputSchema` | D, C, X |
| `get_screen_state` | `GetScreenStateInputSchema` | D, E, C, X |
| `search_objects` | `SearchObjectsInputSchema` | D, E, C, X |
| `get_scope_bundle` | `GetScopeBundleModelSchema`, runtime `GetScopeBundleInputSchema` | D, C |
| `get_object_detail` | `GetObjectDetailInputSchema` | D, E, C, X |
| `detect_graph_patterns` | `DetectGraphPatternsInputSchema` | D, C, X |
| `search_ddl` | `SearchDdlInputSchema` | D, C, X |
| `get_neighbor_columns` | `GetNeighborColumnsInputSchema`, engine scope/adjacency | T, X; needs an active engine |
| `start_exploration` | Fresh/refine provider schemas; actual-state `startExplorationSchemaForState` admission | E, C |
| `submit_findings` | Broad provider schema; live `submitFindingsSchemaForMode` | B, T |
| `prune_current` | `PruneCurrentInputSchema`; engine passthrough eligibility | B, T when eligible |
| `present_result` | Full `presentResultSchemaForPhase`; held values applied before validation | P, S, C |

Zod authors tool schemas; canonical Ajv admission validates them once and supplies native field facts to engine rules. Submit schemas depend on BB/CT, classification, required content, assigned columns, out_node/return destinations and caller context; CS/CI resolution also uses model metadata. Nested contracts include column identifiers/transforms, `upstream_columns`, exclusive `out_node`/`returns_to`, `questions[].caller_context` and scope depth/exclusions. Presentation schemas depend on stage and committed-section retention, and stay full during repair. Model-facing projection alone cannot establish every admission or graph rule. Test schema-invalid input at raw handler/registry boundaries and malformed transport at the model-port/dispatcher boundary; typed engine calls test neither. Held draft content may change after rejection; committed graph, columns and tasks must not.

`model/vscodeModelPort.ts` detects non-object arguments and unavailable tools; `agent/toolAttempt.ts` consumes those classifications and owns ordered rejection/dispatch, call/result pairing, duplicate reads, repeated rejected calls, progress limits, cancellation and phase closure. Submit and self-prune compete for one hop evaluation per reply even if the first rejects; presentation also has a single-evaluation rule. `toolProvider.ts` serializes mutating effects and the registry tracks in-flight calls. `getHopContext` and `getResult` are engine APIs; additional SQL requires a fresh exploration proposal and approval.

Coverage limits remain explicit: the current suites do not establish a complete stage-by-tool truth table or concurrent-effect ordering, nor complete scalar-return and external-endpoint runbooks. Architecture checks in `rule-gates` do not substitute for executing interaction rules.

## What these checks establish

Deterministic tests verify parser, graph and runtime contracts. A structurally valid AI result does not establish complete SQL lineage, correct model-authored argument bindings or inclusion of every contributor. Fixed-response host tests establish API wiring and lifecycle, not inference quality. Current escaped-bracket identifiers are covered in both case modes. Ambiguous identifiers in older saved views or checkpoints cannot always be recovered: legacy references resolve only when they have a unique owner in the current model. Statement scanning uses semicolons or recognised top-level statement keywords; identifier tests do not establish complete parsing of arbitrary SQL without delimiters. See [parser limits](../PARSE_RULES.md).

Headless AI uses simulated consent decisions and its own transport. It does not test interactive approval controls or the VS Code account's model integration. Badge replay checks the rendered follow-up control and live suggestion call, but does not prove fresh synthesis. Inspecting headless Markdown does not establish rendered layout; native UI checks remain separate. A live check spends provider tokens. Run one only under [When a live run is worth its cost](#when-a-live-run-is-worth-its-cost).

Layout timings describe the tested dataset, hardware and runtime, not a general performance threshold. For manual performance review, record warm/cold state, repetitions, median and p95. Preserve each distinct contract and failure assertion when consolidating tests; coverage totals alone do not prove scenario preservation.

## Complete inventory

[The test inventory](INVENTORY.md) enumerates every deterministic, host, Playwright, database and provider-backed surface. “All” means that inventory; the three public headless demo rows alone are not complete coverage.

## Optional checks

| Check | Command | What it verifies |
|---|---|---|
| Database metadata smoke | `npm run test:db:smoke` | Read-only discovery/import against local SQL Server; Azure/Entra only with an explicitly selected available manual profile |
| Electron host lanes | `npm run test:edh` | Activation, tool invocation and participant turn through the VS Code API |
| Playwright GUI smoke | `npm run test:gui:host`, then `npm run test:gui:smoke` | Opens the demo in an isolated VS Code host and checks the graph renders |
| Playwright chat UI | `npx vscode-test --config .vscode-test.chat-ui.mjs` | Native chat confirmations, approval/cancellation and scope revisions |
| Real-model smoke | `npm run test:ai:smoke` | One live `@lineage` turn against the demo DACPAC |
| Headless review | `npm run test:ai:headless` | With no selector every headless catalog row runs in one capture; `--all` runs each row as its own capture and writes `inventory.json`. `--case ID` selects one row; `--list` prints IDs/descriptions/hashes without provider calls. An explicit question uses `--prompt` (flags: `-- --help`). Full execution is baseline work. |
| Large layout scale | `npm run test:scale` | Layout check for a 1,500-node model |

## VS Code host checks

These run the extension in an isolated VS Code host (Extension Development Host) and stay outside `npm test` and the gate. On Linux without a display, prefix the commands with `xvfb-run -a`. Run labels one at a time; never attach to your normal VS Code session.

`npm run test:edh` builds and runs every lane in `.vscode-test.mjs`. To run one lane, run `npm run pretest:integration` first, then `npm run test:bare-environment`, `npm run test:tools`, `npm run test:participant-turn` or `npx vscode-test --label kill-switch`.

| Lane | What it verifies |
|---|---|
| `bare-environment` | Activation without optional host integrations |
| `tools` | Read-only LM tools respond through `vscode.lm.invokeTool` |
| `participant-turn` | `@lineage` completes a turn through the chat API (fixed response) |
| `kill-switch` | Disabling AI leaves the non-AI features working |

Native chat UI runs with `npx vscode-test --config .vscode-test.chat-ui.mjs`, optionally adding `--label live`, after `npm run pretest:integration`. Both use the `electron-fixture-trace` prompt from `tests/cases/lineage-cases.yaml` and the controls in `tests/integration/chat-ui.test.ts`.

| Label | What it verifies |
|---|---|
| default | Chat input, plan approval and cancellation with scripted responses |
| `live` | The same controls against `AI_TEST_PROVIDER` and `assets/demo.dacpac` |

Check `live` answers against the fixture's SQL and graph. Badge/column selectors have no matching tests in this checkout; zero discovered tests establish no coverage. Keep reports, screenshots and traces out of git.


## Live-model and database settings

Copy [`.env.example`](../../.env.example) into the local environment file the harness reads, and fill only the section you need. Leave that file, traces, and answers untracked. `AI_TEST_PROVIDER` is required (`azure`, `fireworks`, `openrouter` or `openai-compatible`); there is no default. `AI_TEST_API_KEY` must be non-empty (any placeholder for a keyless local server). For Azure, `AI_TEST_MODEL` is the deployment name. These settings configure test harnesses only; the extension itself uses the VS Code chat model. Keep the configured provider, model, and reasoning effort.

`AI_TEST_TIMEOUT_MS` sets the AI budget (default: two hours), covering the whole headless catalog run or each native test. `AI_TEST_REQUEST_TIMEOUT_MS` bounds each provider request and defaults to that budget. Increase these settings for slower local models; headless `--timeout-ms` and `--request-timeout-ms` override their respective settings. Native live UI waits use the AI budget, with an additional minute for test teardown. Captured provider failures end UI waits immediately with the request number and error. Database smoke retains its five-minute default. Native chat runs pin the host version in `.vscode-test.chat-ui.mjs`; baseline comparisons must verify the same resolved host version in both launcher logs. For Entra ID database checks, set `DB_TEST_AUTH_TYPE=entraId`. The runner reuses a supplied `DB_TEST_TOKEN`, uses an explicitly configured noninteractive client login, or obtains an Azure SQL token from the already signed-in Azure CLI. It never starts interactive login or saves a token. Native Windows and WSL CLI launchers are supported; see [Test environments](ENVIRONMENTS.md) for precedence and a nonstandard CLI launcher. The default is SQL login.

Headless follow-ups receive prior visible questions and answers through the same runtime history input as native chat. Each catalog case starts with a separate session and empty history.
The harness removes a leading `@lineage` participant mention before dispatch, preserving slash commands and the remaining SQL text. A catalog row's configured consent steps must execute in order on its first turn; an answer that bypasses them fails the case.

PASS/FAIL describe deterministic assertions only. Report AI runtime as completed/error, hard-fact differences as “Unresolved differences — review required”, and content separately as unreviewed, SQL-supported or issue. Runtime completion does not establish content correctness.

Generated answers, metrics, and traces stay untracked. Headless turns persist `metrics.json` beside their answer. Native Playwright cases persist metrics and a trace slice for each run, including failures. Metrics identify the case by its recorded question and fixture hashes and preserve provider, model, effort, settings, and source hashes. Unknown usage or final graph values remain unknown. Rendered native text has character counts and no Markdown delimiter counts. Completion is runtime evidence, not answer-quality evidence. Review uses the sources applicable to the run: verbose NDJSON, VS Code debug log, Langfuse evidence and exploration state. Recorded no-exploration means a state-machine dump is not applicable; an opened exploration without its dump is missing evidence, and uncertain applicability stays unknown. New runners may still write `explorationOpened: false` markers. All runs capture local evidence and export Langfuse traces/spans; ordinary-run NDJSON, debug logs, SM dumps and other files remain local only. `--attach` (headless) uploads the complete allowlisted evidence files of an ordinary run, which keeps tag `verification`. Baseline mode (`--baseline --branch NAME` for headless; `AI_TEST_BASELINE=1` with `AI_TEST_BRANCH=NAME` for native; default off) is a separate, explicit step per branch: it uploads the same files, sets session `baseline-NAME-COMMIT` and tag `baseline:NAME`, and fails without a branch name. A trace tagged `baseline` is not a baseline until it is registered in `traces/baselines/manifest.json`. Generated comparisons, scorecards, triage and draft reviews always stay local only; never upload a whole temporary directory. Baseline comparisons may hydrate uploaded evidence; local cleanup alone never justifies another paid run. A successful upload receipt is required but is not the underlying span data. Capture and Langfuse storage are required defaults: preflight before provider use, validate evidence after capture, and stop further paid cases when required trace, debug log or export evidence is missing. All three `LANGFUSE_*` settings must resolve before the first model call. `tests/harness/langfuseExport.ts` holds the free-plan limits and spaces those calls. The export deadline follows that spacing for the run's attachment count, and includes one retry without another model call. `--langfuse` and `--trace-verbose` stay accepted and do not turn capture off; `--attach` uploads the evidence files. Ordinary answers and tool artifacts can already contain database metadata. The installed extension does not upload traces. Use the AdventureWorks demo or other synthetic input, review captured content, and leave artifacts untracked.

Before export, runners freeze allowlisted, redacted source bytes in a write-once local `evidence-snapshot.json`, with byte lengths, SHA-256 hashes and attachment mode (`--attach` or baseline). Retries and saved-capture reexports use `readFrozenRunEvidence` from `tests/harness/langfuseExport.ts`; hash failures or conflicting historical attachments remain errors. Headless logging and later native log copies use `runner-diagnostics.log` after freezing. The snapshot stays local; only `--attach` or baseline mode uploads its source attachments. An existing export receipt does not establish recovery of historical conflicting evidence.

`AI_TEST_REASONING_EFFORT` stays at the configured value (`low` in [`.env.example`](../../.env.example)). Keep it. Identically named effort levels do not establish equivalent reasoning across providers. Harness settings do not configure the installed extension.

## Packaging

`npm run package` creates `data-lineage-viz-<version>.vsix` without publishing it; install it in a separate VS Code profile to inspect it.

## When a live run is worth its cost

A live model run spends the external API provider's tokens. Deterministic `npm test` and `npm run gate` come first and do not call a provider. Keep that external test profile's provider, model, and reasoning effort. The coding agent reviewing the repository is a separate model.

- Debugging one issue: run the one live case that shows that issue. A headless question is `npm run test:ai:headless -- --prompt "QUESTION"`. A native check uses the one label that renders the defect.
- A new baseline: one full comparable run, after the previous baseline no longer matches because the question set, fixture, or settings changed, or because a broad behavior change invalidated the stored answers. Later work reuses that baseline.
- A prompt comparison: the frozen question once before the change, when no matching baseline exists, and once after it. Add one held-out question only to check that unchanged behavior still holds.
- Run a case again only when the code, question, fixture, or settings changed. A full catalog run is a new baseline, not a way to obtain a passing prompt. Leave another full run unstarted while known failures from the last baseline remain.

Generated run output stays untracked.

## Before-deployment baseline review

Follow [When a live run is worth its cost](#when-a-live-run-is-worth-its-cost). For a prompt or model-visible behavior change, compare one frozen question on the public demo (`assets/demo.dacpac` unless `--dacpac FILE` is given):

`npm run test:ai:headless -- --prompt "QUESTION"`

Reuse a baseline whose question, fixture, and settings still match when measuring equivalent work. Run the candidate once after the change. The run captures the applicable evidence sources above. Set `AI_TEST_PREVIOUS_RUN` and `AI_TEST_MAIN_RUN` to those existing run directories so the harness writes the comparison beside the new run. Baseline question history, fixture, provider, model, actual reasoning settings and approved workload are informational comparison facts: differences do not deny approval or fail the candidate run. Reports retain raw measurements and label the workload aligned, different, or unknown; incomplete evidence stays unknown. Depth workload equality uses the engine’s resolved execution border; different declarations with the same border remain visible as informational differences. The case’s YAML `gate` policy controls simulated consent. An approve row may declare `expect: classification~business` and `onMismatch` using the existing refinement payload. An aligned proposal approves immediately; a mismatch requests Change once, rechecks the revised proposal, then approves while recording any remaining mismatch. Original and revised proposals, the correction and its provider cost remain captured; baseline differences never trigger Change. Production consent remains bound to the proposal the user reviews. Historical headless evidence without manifest gate decisions can establish approval through one turn and gate, a uniquely timestamp-matched host approval, and subsequent active work; ambiguous evidence remains unknown. Intentional prompt or source changes remain recorded comparison context.

Review both answers against the SQL and graph: requested facts, formulas, filters, joins, grain, row rules, scope, output instructions, and unsupported claims. Record the SQL evidence for any accepted difference.

Two review helpers read existing captures; they do not justify another model run and remain outside the deterministic gate.

- **Countable facts (tracked):** `node tests/tools/lineage-score.mjs CANDIDATE_RUN_DIR --previous PREVIOUS_RUN_DIR --main MAIN_RUN_DIR --out DIR`; use its `--trace` mode for trace analysis (`--latest`, `--case-manifest`, `--output` remain available). It compares tokens, durations, raw feedback/clarification/retry counts, preview/chat characters, SQL fences/formulas, visit sets/order, column pairs and prune/supplement counts; communication comparisons include backend request and AI reply sizes, measured timing and deduplicated generation usage, with scope and unknowns retained. Differences use `differs`: **Unresolved differences — review required**; a match means **No measured difference; content unverified**. Different question/fixture identities are not comparable. Diagnostic arrays are not SQL correctness verdicts.
- **Content quality:** review separately whether the core question is answered and whether individual claims are supported by source SQL, false, unsupported or ambiguous. Explain each issue’s impact on the requested answer; incidental scope, correct extras, callouts and formatting carry less weight unless requested or meaning-changing. Keep structural graph defects and runtime/render/performance results separate; countable comparisons alone do not grade prose.

The score helper must correlate applicable NDJSON, Langfuse trace/span data, VS Code debug log and state-machine evidence; missing sources stay explicit, and a receipt alone does not establish span coverage. Helpers can hydrate durable evidence and report unverified correlation explicitly; permanent local payloads are not required. A recorded no-hop turn has no applicable state-machine dump; opened-but-missing state is missing, uncertain state remains unknown. SQL-fence/formula counts do not establish the truth of SQL or formulas.


