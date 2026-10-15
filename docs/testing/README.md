# Testing

The single reference for test tiers, lanes and commands. Machine needs are in [Test environments](ENVIRONMENTS.md).

## Default checks

These need no database, model provider or display. Parser and lineage scenarios are zero-regression.

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

The gate prints `PASS`, `FAIL` and `SKIP` per step and exits nonzero on any `FAIL`. A `SKIP` is unverified: the template-schema step skips without a `v*` tag or `origin/main`, and fails instead when `CI` is set. Failed step logs go to `test-results/gate`.

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
| [Presentation schemas](../../src/ai/tools/toolSchemas.ts) and [draft/merge rules](../../src/ai/tools/presentResult.ts) | [schemas](../../tests/unit/ai-core/present-result-schema.test.ts), [repairs](../../tests/unit/ai-core/present-result-repair.test.ts), [coverage](../../tests/unit/ai-core/present-result-coverage.test.ts) | Unit / runtime |
| [Presentation handler](../../src/ai/tools/handlers/presentResult.ts) and [presentation rules](../../src/ai/interaction/rules/presentResultRules.ts) | [functional presentation](../../tests/unit/ai-core/present-result-functional.test.ts), [SQL/evidence boundary](../../tests/unit/ai-core/present-result-sql-fence-boundary.test.ts) | Functional; SQL expansion also unit / runtime |
| Storage, database adapters and webview | Owning `engine`, `engine/db` and `webview` suites | Unit + functional / support |
| VS Code API, native controls and live answers | [host tests](../../tests/integration), Electron/Playwright/headless commands below | Optional host/end-to-end or live review |

`tests/tools` owns execution and partition checks; `tests/unit/helpers` owns shared input builders; domain helpers stay beside their suites. `tests/cases` and typed rows own independently authored inputs and expectations. `tests/harness` adapts the real runtime for optional service checks. There is no universal runbook interpreter. Add a regression or hypothesis as a row in its owner; do not repeat the same rule's matrix in every layer or enumerate arbitrary combinations without expected outcomes.

The gate runs core once and runtime once, with disjoint file membership; duplicate declarations fail partition validation. `npm test` is their aggregate, parser/lineage commands select subsets, and `test:bfs` aliases lineage. These selectable commands are not extra gate executions. Path arguments override the lane selection.

The partition check requires the complete aggregate npm recipes and enabled core coverage. It rejects filters, shell suffixes, embedded command newlines and coverage-disabling flags in those recipes. Pass options or file filters to an individual run after `--` instead.

Retirement is applied: nine fragmented presentation files are replaced by the four presentation owners above; synthetic traversal/depth assertions have moved out of the two graph-builder suites into the traversal table. The historical schema comparator derived from the current schema is removed; explicit acceptance/rejection expectations remain. A shared shape or SQL input across different entry boundaries is retained only for a distinct contract.

## Case catalogs

Add a supporting check as one row in an existing file or case catalog; a new file needs a contract no lane already owns. Coverage floors stay at their current numbers.

- SQL/parser case: one row in `tests/cases/parser/exact-edges.yaml`, run by `tsql-coverage-matrix.test.ts`, with `id`, `description`, `sql` and exact `sources`, `targets`, `exec`, `cross_db_sources` and `cross_db_targets` lists (omitted lists mean empty). Optional `case_modes: [ci, cs]` preserves case-sensitive scenarios; the default is `[ci]`. Add exact `mutations` or `external` lists when those contracts matter. For model behavior, add `graph` with independent `tables`, catalog `metadata`, optional `current_database` and the complete expected `edges`, including type and `deleteOnly`; the subject procedure is `gen.Subject`. Do not derive expected graph edges from parser output. Keep custom-rule setup, extractor/API contracts and generated performance cases in their existing tests.
- AI column-trace state contracts (not deterministic SQL-to-column inference): a `runners: [scripted]` row in [`tests/cases/lineage-cases.yaml`](../../tests/cases/lineage-cases.yaml), run by `tests/unit/backend/lineage-cases.test.ts` on `npm run test:runtime` and the gate.
- Playwright, Electron and headless rows use the matching `runners` tag and stay outside the gate. Keep the prompt and expected result on the row, not in the runner.

The backend catalog's `contract: stored-arrival` rows share one producer → table → receiver fixture. Each row declares receiver type, SQL and column metadata, supplied `column_flow`, optional `terminated_inputs`, and independent expected mapped inputs, receiver rows, sink mode and sink columns. Partial-consumption rows also declare the rejection expected before termination is supplied. Adding another consumption variant needs a row, not another runner. Keep unique contracts such as separate write destinations, final endpoints and sibling independence as focused tests, using shared graph/render setup. Do not derive expected results from the submitted mappings or from production output.

The same catalog's `contract: self-prune` rows declare a `story`, BB/CT `mode`, route fixture, optional `sender_verdict`, `graph.edges` and independent `expect` values. Use `mode: [bb, ct]` when both modes share the fixture and expectations; each still runs separately with its mode-prefixed case ID. They check the single eligibility rule (routing through passthrough), immediate hard cuts, shared descendants and removal of cut column evidence. Tool-boundary and dispatcher tests check conditional delivery, strict input and shared completion. These are backend enforcement tests, not evidence that the model judged SQL relevance correctly.

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
| `start_exploration` | Fresh/refine/completed provider schemas; strict `StartExplorationInputSchema` | E, C |
| `submit_findings` | Broad provider schema; live `submitFindingsSchemaForMode` | B, T |
| `prune_current` | `PruneCurrentInputSchema`; engine passthrough eligibility | B, T when eligible |
| `present_result` | Broad provider schema; live `presentResultSchemaForPhase` and authorized repair schema | P, S, C |

Zod shape checks and engine admission are separate contracts. Submit schemas depend on BB/CT, classification, fresh/held content, assigned columns, writer/return destinations and caller context; CS/CI identity resolution also uses model metadata. Nested contracts include column identifiers/transforms, `upstream_columns`, exclusive `writes_to`/`returns_to`, qualified `terminated_inputs`, `questions[].caller_context` and scope depth/exclusions. Presentation schemas depend on stage, retained sections/highlights and authorized repair fields. Provider JSON Schema projection cannot establish every Zod refinement or graph rule. Test schema-invalid payloads at raw handler/registry boundaries, and malformed transport arguments at the model-port/dispatcher boundary; a typed direct-engine call does not test either boundary. Valid held repair content may change after rejection, while committed graph, columns and tasks must not.

`model/vscodeModelPort.ts` detects non-object arguments and unavailable tools; `agent/toolAttempt.ts` consumes those classifications and owns ordered rejection/dispatch, call/result pairing, duplicate reads, repeated rejected calls, progress limits, cancellation and phase closure. Submit and self-prune compete for one hop evaluation per reply even if the first rejects; presentation also has a single-evaluation rule. `toolProvider.ts` serializes mutating effects and the registry tracks in-flight calls. Internal `getHopContext`, `getResult` and `supplementAgenda` are engine APIs; supplements enter through `start_exploration`, not another tool.

Coverage limits remain explicit: the current suites do not establish a complete stage-by-tool truth table or concurrent-effect ordering, nor complete scalar-return, external-endpoint and completed-supplement runbooks. Architecture checks in `rule-gates` do not substitute for executing interaction rules.

## What these checks establish

Deterministic tests verify parser, graph and runtime contracts. A structurally valid AI result does not establish complete SQL lineage, correct model-authored argument bindings or inclusion of every contributor. Fixed-response host tests establish API wiring and lifecycle, not inference quality. Current escaped-bracket identifiers are covered in both case modes. Ambiguous identifiers in older saved views or checkpoints cannot always be recovered: legacy references resolve only when they have a unique owner in the current model. Statement scanning uses semicolons or recognised top-level statement keywords; identifier tests do not establish complete parsing of arbitrary SQL without delimiters. See [parser limits](../PARSE_RULES.md).

Headless AI uses simulated consent decisions and its own transport. It does not test interactive approval controls or the VS Code account's model integration. Badge replay checks the rendered follow-up control and live suggestion call, but does not prove fresh synthesis. Inspecting headless Markdown does not establish rendered layout; native UI checks remain separate. Live checks can incur provider charges.

Layout timings describe the tested dataset, hardware and runtime, not a general performance threshold. For manual performance review, record warm/cold state, repetitions, median and p95. Preserve each distinct contract and failure assertion when consolidating tests; coverage totals alone do not prove scenario preservation.

## Optional checks

| Check | Command | What it verifies |
|---|---|---|
| Database metadata smoke | `npm run test:db:smoke` | SQL-login or Entra ID discovery and import, read-only against a disposable or demo database |
| Electron host lanes | `npm run test:edh` | Activation, tool invocation and participant turn through the VS Code API |
| Playwright GUI smoke | `npm run test:gui:host`, then `npm run test:gui:smoke` | Opens the demo in an isolated VS Code host and checks the graph renders |
| Playwright chat UI | `npx vscode-test --config .vscode-test.chat-ui.mjs` | Native chat confirmations, approval/cancellation, scope revisions and suggestion badges |
| Real-model smoke | `npm run test:ai:smoke` | One live `@lineage` turn against the demo DACPAC |
| Headless review | `npm run test:ai:headless` | Loops the `headless` catalog rows against `AI_TEST_PROVIDER` (flags: `-- --help`) |
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

Native chat UI runs with `npx vscode-test --config .vscode-test.chat-ui.mjs`, adding `--label live`, `badge` or `column` as needed, after `npm run pretest:integration`. The default label takes its prompt from the `electron-fixture-trace` row of `tests/cases/lineage-cases.yaml`; the `live`, `badge` and `column` prompts are in `tests/integration/chat-ui.test.ts`.

| Label | What it verifies |
|---|---|
| default | Chat input, plan approval and cancellation with scripted responses |
| `live` | The same controls against `AI_TEST_PROVIDER` and `tests/fixtures/AdventureWorks2025_AI.dacpac` |
| `badge` | The follow-up suggestion badge, replaying a qualifying `live` analysis under `tmp/lm-trace/` and making a live model call for suggestions |
| `column` | A column-trace query and the rendered report |

Check `live` answers against the fixture's SQL and graph. Keep reports, screenshots and traces out of git.

To run `badge` without a recorded trace, use `DLV_CHAT_UI_BADGE_LIVE=1 npx vscode-test --config .vscode-test.chat-ui.mjs --label badge`. This executes fresh real-model analysis and the same native consent, graph and suggestion assertions. The default badge mode still requires a qualifying recorded trace.

## Live-model and database settings

Copy [`.env.example`](../../.env.example) to `.env` and fill only the section you need; never commit `.env`, traces or answers. `AI_TEST_PROVIDER` is required (`azure`, `fireworks`, `openrouter` or `openai-compatible`); there is no default. `AI_TEST_API_KEY` must be non-empty (any placeholder for a keyless local server). For Azure, `AI_TEST_MODEL` is the deployment name. These settings configure test harnesses only; the extension itself uses the VS Code chat model.

`AI_TEST_TIMEOUT_MS` sets the AI budget (default: two hours), covering the whole headless catalog run or each native test. `AI_TEST_REQUEST_TIMEOUT_MS` bounds each provider request and defaults to that budget. Increase these settings for slower local models; headless `--timeout-ms` and `--request-timeout-ms` override their respective settings. Native live UI waits use the AI budget, with an additional minute for test teardown. Captured provider failures end UI waits immediately with the request number and error. Database smoke retains its five-minute default. Native chat runs pin the host version in `.vscode-test.chat-ui.mjs`; baseline comparisons must verify the same resolved host version in both launcher logs. For Entra ID database checks, set `DB_TEST_AUTH_TYPE=entraId` and `DB_TEST_TOKEN` (an existing SQL access token); the default is SQL login.

Headless follow-ups receive prior visible questions and answers through the same runtime history input as native chat. Each catalog case starts with a separate session and empty history.
The harness removes a leading `@lineage` participant mention before dispatch, preserving slash commands and the remaining SQL text. A catalog row's configured consent steps must execute in order on its first turn; an answer that bypasses them fails the case.

Headless artifacts go under ignored `test-results/headless/`. Completion is runtime evidence, not answer-quality evidence. Optional `--langfuse` export requires all three `LANGFUSE_*` settings and access to that endpoint; its separate deadline is 30 seconds. Full prompt/system and provider bodies require `--trace-verbose`, while ordinary answers and tool artifacts can already contain database metadata. `--attach` additionally exports evidence files. Use synthetic/public input, review captured content and keep artifacts out of Git.

`AI_TEST_REASONING_EFFORT` depends on provider/model support; leave it empty when unsupported. Identically named effort levels do not establish equivalent reasoning across providers. Harness settings do not configure the installed extension.

## Packaging

`npm run package` creates `data-lineage-viz-<version>.vsix` without publishing it; install it in a separate VS Code profile to inspect it.

## Before-deployment baseline review

For a prompt or model-behavior change, run an unchanged baseline and the candidate with the same dataset, question, scope and provider: `npm run test:ai:headless -- --prompt "QUESTION"` (uses `assets/demo.dacpac` unless `--dacpac FILE` is given; `--trace-verbose` adds prompts and provider bodies). Review both answers against the SQL and graph (columns, formulas, filters, joins, grain, scope) and record the SQL evidence for any accepted difference.

- `node tests/tools/trace-metrics.mjs --latest` (or `BASELINE.ndjson CANDIDATE.ndjson`) compares tokens, rejections, repairs and lineage, with `GREEN`/`AMBER`/`RED` ratings.
- `node tests/tools/case-scorecard.mjs BASE_RUN_DIR CANDIDATE_RUN_DIR` scores each catalog case of two headless runs and copies both answers to `test-results/scorecard/` for side-by-side reading. Its scores rank what to read first.
