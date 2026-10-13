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
| `npm run test:runtime` | Schema, redaction, cancellation, template structure, `scripted` catalog rows |
| `npm run test:support` | Webview, database connection, AI routing and operator tools (not in `npm test` or the gate) |
| `npm run typecheck`, `npm run typecheck:tests` | TypeScript checks; there is no lint script |
| `npm run gate` | Everything above except `test:support`, plus coverage floors, build and repository checks; CI runs this |

A path argument to `test:core`, `test:lineage`, `test:runtime` or `test:support` runs that file only: `npm run test:core -- tests/unit/parser/identifier-case.test.ts`.

The gate prints `PASS`, `FAIL` and `SKIP` per step and exits nonzero on any `FAIL`. A `SKIP` is unverified: the template-schema step skips without a `v*` tag or `origin/main`, and fails instead when `CI` is set. Failed step logs go to `test-results/gate`.

## Case catalogs

Add a supporting check as one row in an existing file or case catalog; a new file needs a contract no lane already owns. Coverage floors stay at their current numbers.

- Parser edge: one row in `tests/cases/parser/exact-edges.yaml` with `id`, `description`, `sql` and the exact lists it checks (`sources`, `targets`, `exec`, `cross_db_sources`, `cross_db_targets`, and `external` only when checked). Lists are compared exactly, so a missing name is asserted absent.
- Column flow: a `runners: [scripted]` row in [`tests/cases/lineage-cases.yaml`](../../tests/cases/lineage-cases.yaml), run by `tests/unit/sm/lineage-cases.test.ts` on `npm run test:runtime` and the gate.
- Playwright, Electron and headless rows use the matching `runners` tag and stay outside the gate. Keep the prompt and expected result on the row, not in the runner.

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
| `badge` | The follow-up suggestion badge, replaying the newest `live` trace under `tmp/lm-trace/` |
| `column` | A column-trace query and the rendered report |

Check `live` answers against the fixture's SQL and graph. Keep reports, screenshots and traces out of git.

## Live-model and database settings

Copy [`.env.example`](../../.env.example) to `.env` and fill only the section you need; never commit `.env`, traces or answers. `AI_TEST_PROVIDER` is required (`azure`, `fireworks`, `openrouter` or `openai-compatible`); there is no default. `AI_TEST_API_KEY` must be non-empty (any placeholder for a keyless local server). For Azure, `AI_TEST_MODEL` is the deployment name. These settings configure test harnesses only; the extension itself uses the VS Code chat model.

Headless `--timeout-ms` bounds the whole run and `--request-timeout-ms` each request. Native smoke and live chat use fixed per-request deadlines (120 s and 300 s). For Entra ID database checks, set `DB_TEST_AUTH_TYPE=entraId` and `DB_TEST_TOKEN` (an existing SQL access token); the default is SQL login.

## Packaging

`npm run package` creates `data-lineage-viz-<version>.vsix` without publishing it; install it in a separate VS Code profile to inspect it.

## Before-deployment baseline review

For a prompt or model-behavior change, run an unchanged baseline and the candidate with the same dataset, question, scope and provider: `npm run test:ai:headless -- --prompt "QUESTION"` (uses `assets/demo.dacpac` unless `--dacpac FILE` is given; `--trace-verbose` adds prompts and provider bodies). Review both answers against the SQL and graph (columns, formulas, filters, joins, grain, scope) and record the SQL evidence for any accepted difference.

- `node tests/tools/trace-metrics.mjs --latest` (or `BASELINE.ndjson CANDIDATE.ndjson`) compares tokens, rejections, repairs and lineage, with `GREEN`/`AMBER`/`RED` ratings.
- `node tests/tools/case-scorecard.mjs BASE_RUN_DIR CANDIDATE_RUN_DIR` scores each catalog case of two headless runs and copies both answers to `test-results/scorecard/` for side-by-side reading. Its scores rank what to read first.
