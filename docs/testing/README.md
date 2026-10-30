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

The gate runs core once and runtime once, with disjoint file membership; duplicate declarations fail partition validation. `npm test` is their aggregate, parser/lineage commands select subsets, and `test:bfs` aliases lineage. These selectable commands are not extra gate executions. Path arguments override the lane selection.

The partition check requires the complete aggregate npm recipes and enabled core coverage. It rejects filters, shell suffixes, embedded command newlines and coverage-disabling flags in those recipes. Pass options or file filters to an individual run after `--` instead.

A shared shape or SQL input across entry boundaries is retained only for a distinct contract, with independently authored acceptance/rejection expectations.

## Case catalogs

Add a supporting check as one row in an existing file or case catalog; a new file needs a contract no lane already owns. Coverage floors stay at their current numbers.

- SQL/parser case: one row in `tests/cases/parser/exact-edges.yaml`, run by `tsql-coverage-matrix.test.ts`, with `id`, `description`, `sql` and exact `sources`, `targets`, `exec`, `cross_db_sources` and `cross_db_targets` lists (omitted lists mean empty). Optional `case_modes: [ci, cs]` preserves case-sensitive scenarios; the default is `[ci]`. Add exact `mutations` or `external` lists when those contracts matter. For model behavior, add `graph` with independent `tables`, catalog `metadata`, optional `current_database` and the complete expected `edges`, including type and `deleteOnly`; the subject procedure is `gen.Subject`. Do not derive expected graph edges from parser output. Keep custom-rule setup, extractor/API contracts and generated performance cases in their existing tests.
- AI column-trace state contracts (not deterministic SQL-to-column inference): a `runners: [scripted]` row in [`tests/cases/lineage-cases.yaml`](../../tests/cases/lineage-cases.yaml), run by `tests/unit/backend/lineage-cases.test.ts` on `npm run test:runtime` and the gate.
- Playwright, Electron and headless rows use the matching `runners` tag and stay outside the gate. Keep the prompt and expected result on the row, not in the runner.

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

`AI_TEST_TIMEOUT_MS` sets the AI budget (default: two hours), covering the whole headless catalog run or each native test. `AI_TEST_REQUEST_TIMEOUT_MS` bounds each provider request and defaults to that budget. Increase these settings for slower local models; headless `--timeout-ms` and `--request-timeout-ms` override their respective settings. Native live UI waits use the AI budget, with an additional minute for test teardown. Captured provider failures end UI waits immediately with the request number and error. Database smoke retains its five-minute default. Native chat runs pin the host version in `.vscode-test.chat-ui.mjs`. For Entra ID database checks, set `DB_TEST_AUTH_TYPE=entraId`. The runner reuses a supplied `DB_TEST_TOKEN`, uses an explicitly configured noninteractive client login, or obtains an Azure SQL token from the already signed-in Azure CLI. It never starts interactive login or saves a token. Native Windows and WSL CLI launchers are supported; see [Test environments](ENVIRONMENTS.md) for precedence and a nonstandard CLI launcher. The default is SQL login.

Headless follow-ups receive prior visible questions and answers through the same runtime history input as native chat. Each catalog case starts with a separate session and empty history.
The harness removes a leading `@lineage` participant mention before dispatch, preserving slash commands and the remaining SQL text. A catalog row's configured consent steps must execute in order on its first turn; an answer that bypasses them fails the case.

Generated answers, metrics, and traces stay untracked. Headless turns persist `metrics.json` beside their answer. Native Playwright cases persist metrics and a trace slice for each run, including failures. Metrics identify the case by its recorded question and fixture hashes and preserve provider, model, effort, settings, and source hashes. Unknown usage or final graph values remain unknown. Rendered native text has character counts and no Markdown delimiter counts. Completion is runtime evidence, not answer-quality evidence. Review uses the sources applicable to the run: verbose NDJSON, VS Code debug log, Langfuse evidence and exploration state. Recorded no-exploration means a state-machine dump is not applicable; an opened exploration without its dump is missing evidence, and uncertain applicability stays unknown. New runners may still write `explorationOpened: false` markers. All runs capture local evidence and export Langfuse traces/spans; ordinary-run NDJSON, debug logs, SM dumps and other files remain local only. `--attach` (headless) uploads the complete allowlisted evidence files of an ordinary run, which keeps tag `verification`. Generated comparisons, scorecards, triage and draft reviews always stay local only; never upload a whole temporary directory. Local cleanup alone never justifies another paid run. A successful upload receipt is required but is not the underlying span data. Capture and Langfuse storage are required defaults: preflight before provider use, validate evidence after capture, and stop further paid cases when required trace, debug log or export evidence is missing. All three `LANGFUSE_*` settings must resolve before the first model call. `tests/harness/langfuseExport.ts` holds the free-plan limits and spaces those calls. The export deadline follows that spacing for the run's attachment count, and includes one retry without another model call. `--langfuse` and `--trace-verbose` stay accepted and do not turn capture off; `--attach` uploads the evidence files. Ordinary answers and tool artifacts can already contain database metadata. The installed extension does not upload traces. Use the AdventureWorks demo or other synthetic input, review captured content, and leave artifacts untracked.

`AI_TEST_REASONING_EFFORT` stays at the configured value (`low` in [`.env.example`](../../.env.example)). Keep it. Identically named effort levels do not establish equivalent reasoning across providers. Harness settings do not configure the installed extension.

## Packaging

`npm run package` creates `data-lineage-viz-<version>.vsix` without publishing it; install it in a separate VS Code profile to inspect it.
