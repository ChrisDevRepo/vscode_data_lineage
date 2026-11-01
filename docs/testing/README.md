# Testing

The single reference for test tiers, lanes and commands. Machine needs are in [Test environments](ENVIRONMENTS.md).

## Default checks

These need no database, model provider or display. Parser and lineage scenarios are zero-regression. Run `npm run gate` before a push.

| Command | What it runs |
|---|---|
| `npm test` | Parser, lineage and the deterministic AI/trust contracts in `tests/tools/unit-lanes.mjs` |
| `npm run test:core` | Parser and lineage |
| `npm run test:parser` | Parser only |
| `npm run test:lineage` | Lineage only |
| `npm run test:runtime` | Backend graph contracts, tool registration/dispatch, identifier boundaries, schema, redaction (including the operator runner's secret boundary), cancellation and templates |
| `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`, `npm run format:check`, `npm run knip` | TypeScript, lint, formatting and unused-code checks |
| `npm run gate` | Everything above, plus coverage floors, build and repository checks; CI runs this |

A path argument to `test:core`, `test:lineage` or `test:runtime` runs that file only: `npm run test:core -- tests/unit/parser/identifier-case.test.ts`.

The gate prints `PASS`, `FAIL` and `SKIP` per step and exits nonzero on any `FAIL`. A `SKIP` is unverified: the template-schema step skips without a `v*` tag or `origin/main`, and fails instead when `CI` is set. Failed step logs and `test-results/gate/summary.json` (step outcomes, unit test counts) stay in untracked local output.

## Where tests live

`tests/unit/` holds the Vitest suites, `tests/cases/` the shared case catalogs (parser rows in `tests/cases/parser/exact-edges.yaml`, headless demo rows in `tests/cases/lineage-cases.yaml`), `tests/integration/` the VS Code host lanes, `tests/harness/` the optional headless runner and `tests/tools/` the lane runners. The gate runs the core and runtime lanes once each; `npm test` is their aggregate. Add a check as one row in an existing file or catalog.

## What these checks establish

Deterministic tests verify parser, graph and runtime contracts. A structurally valid AI result does not establish complete SQL lineage or correct model-authored column mappings, and fixed-response host tests establish API wiring, not inference quality. Headless AI uses simulated consent decisions and its own transport; it does not test the approval controls or the VS Code account's model integration. Statement scanning uses semicolons or recognised top-level statement keywords ([parser limits](../PARSE_RULES.md)). A live check spends provider tokens.

## Optional checks

| Check | Command | What it verifies |
|---|---|---|
| Electron host lanes | `npm run test:edh` | Activation and tool invocation through the VS Code API |
| Real-model smoke | `npm run test:ai:smoke` | One live `@lineage` turn against the demo DACPAC |
| Headless question | `npm run test:ai:headless -- --prompt TEXT` | Asks one question (with optional `--followup` turns) against `assets/demo.dacpac` or `--dacpac FILE`; `--case ID` runs one demo row (`headless-summary`, `headless-procedure-dependencies`, `headless-view-chain`) with its checks (flags: `-- --help`). |
| Large layout scale | `npm run test:scale` | Layout check for a 1,500-node model |

## VS Code host checks

These run the extension in an isolated VS Code host (Extension Development Host) and stay outside `npm test` and the gate. On Linux without a display, prefix the commands with `xvfb-run -a`. Run labels one at a time; never attach to your normal VS Code session.

`npm run test:edh` builds and runs every lane in `.vscode-test.mjs`. To run one lane, run `npm run pretest:integration` first, then `npm run test:bare-environment`, `npm run test:tools` or `npx vscode-test --label kill-switch`.

| Lane | What it verifies |
|---|---|
| `bare-environment` | Activation without optional host integrations |
| `tools` | Read-only LM tools respond through `vscode.lm.invokeTool` |
| `kill-switch` | Disabling AI leaves the non-AI features working |

## Live-model settings

Copy [`.env.example`](../../.env.example) into the local environment file the harness reads, and fill only the section you need. Leave that file, traces, and answers untracked. `AI_TEST_PROVIDER` is required (`azure`, `fireworks`, `openrouter` or `openai-compatible`); there is no default. `AI_TEST_API_KEY` must be non-empty (any placeholder for a keyless local server). For Azure, `AI_TEST_MODEL` is the deployment name. These settings configure test harnesses only; the extension itself uses the VS Code chat model.

`AI_TEST_TIMEOUT_MS` sets the AI budget (default: two hours), covering the whole headless run or the real-model smoke. `AI_TEST_REQUEST_TIMEOUT_MS` bounds each provider request and defaults to that budget. Increase these settings for slower local models; headless `--timeout-ms` and `--request-timeout-ms` override their respective settings.

Generated answers, metrics and traces stay untracked. Completion is runtime evidence, not answer-quality evidence.

Headless and real-model smoke runs write a local trace, log and answer and upload nothing. Answers and tool artifacts can contain database metadata, so use the AdventureWorks demo or other synthetic input and review captured content. The installed extension never uploads traces.

## Packaging

`npm run package` creates `data-lineage-viz-<version>.vsix` without publishing it; install it in a separate VS Code profile to inspect it.
