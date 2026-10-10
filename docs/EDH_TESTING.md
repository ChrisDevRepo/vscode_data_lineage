# VS Code Extension Host Tests

Extension Development Host (EDH) tests run the extension inside the VS Code Electron host. They cover host activation and public VS Code API contracts that unit tests cannot exercise.

## Run

```sh
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:participant-turn
npx vscode-test --label kill-switch
```

On Linux without a desktop session, prefix each command with `xvfb-run -a`; see [Test Environments](testing/ENVIRONMENTS.md#linux-without-a-desktop-session).

`npm run test:edh` builds the extension and webview, compiles the integration tests, and runs all configured lanes. Run one lane at a time because lanes share the build output and VS Code test profile.

| Lane | What it verifies |
|---|---|
| `bare-environment` | The extension activates when optional host integrations are absent. |
| `tools` | The external language-model tools (reads, scope walk, AI view render by `scope_id` and its prune by `view_id`) register and answer through `vscode.lm.invokeTool`; the MCP kill switch is off by default and no MCP code is loaded. |
| `participant-turn` | The `@lineage` participant handles an empty-data case and completes a turn through the public chat API. A fixture provider supplies fixed responses to exercise API wiring and turn lifecycle. |
| `kill-switch` | Disabling the AI feature before activation leaves the non-AI extension surface available. |
| `mcp-live` | Keeps a real host alive with the MCP server seeded on before activation and the public AdventureWorks AI fixture loaded, so an external MCP client can test it from outside; the host also checks that the deferred MCP bundle registered `dataLineageViz.copyMcpConfig`. The `tools` lane checks the off side: no MCP code is loaded. Driven only by `npm run test:mcp:live`; see [MCP server deep test](#mcp-server-deep-test-live-host). |

The fixture provider does not perform inference and does not test answer correctness, prompt quality, or provider behavior. Use an explicitly configured real-model smoke check for those purposes; the public demo DACPAC is the appropriate data source.

## MCP server deep test (live host)

`npm run test:mcp:live` compiles the integration tests, starts the `mcp-live` lane in an isolated, throwaway user-data directory (`tmp/mcp-live/`, ignored) with `dataLineageViz.mcp.enabled` on, and drives the running server from a separate Node process (`tests/tools/mcp-live.mjs`) with the official MCP client SDK, as an external client would. On Linux without a desktop it starts `xvfb-run` itself. The first run downloads the VS Code test build. Options: `--port N` (default 39372) and `--only TEXT` (run matching cases). The profile stays in `tmp/mcp-live/` (ignored) for inspection, including the extension log the log case reads. Under `npm run test:edh` the `mcp-live` suite skips itself, because there is no external client to wait for.

The host test loads the demo and then the AdventureWorks AI fixture, publishes `ready.json`, and stays up serving a small command channel (toggle the setting, change the port, load the demo or the fixture) until the orchestrator finishes or a 15-minute bound passes. It asserts nothing about MCP itself.

`ready.json` identifies this session's private discovery and proxy paths. The session owns its token and endpoint; an occupied port is an error, with no automatic takeover. Copy client configuration again after reloading the window. The stdio proxy returns an error for a failed request without replaying it; a later request may reconnect to this session's restarted endpoint.

| Area | Cases |
|---|---|
| Discovery and identity | Private (0600) local discovery file; server name; exactly the eight external tools, each with the right read-only hint; hop tools not exposed. |
| Transport guards | No, wrong, equal-length-wrong and Basic credentials get 401 with a bearer challenge; foreign `Host` or `Origin` get 403; unknown path 404; oversized body 413; malformed JSON-RPC, unknown method and unknown tool are refused and the server keeps serving. |
| Tool contracts on the fixture | Project facts (148 nodes, 170 edges, 32 objects in `ai`); search, detail and DDL search return the known lineage; hubs include `Person.Person`; `not_found`, `invalid_input` and `over_discovery_budget` name the fault and the action. |
| Hand-off | A scope bundle renders as a view (`scope_id`), the view is edited by `view_id`, and bad or conflicting handles are refused. |
| Concurrency and cancellation | 20 parallel calls from two clients each get their own answer; an aborted call leaves the server responsive. |
| Stdio proxy | The proxy, started with the host's Electron binary, relays the same tools. |
| Debug log | The VS Code extension log shows the MCP lifecycle, every tool call in the shared `[AI] Invoking …` format marked `[external]`, rejections as `[AI] [Reject] …`, and transport refusals as `Refused request (401/403/404)`, and never a token. |
| Lifecycle | Reloading the project invalidates old handles; turning the setting off stops the server, removes the discovery file and revokes the token, and turning it on issues a new token; changing the port moves the server. |

Single sources of truth: the expected tool list is the generated manifest in `package.json`, and the expected project facts are `tests/fixtures/graph-baseline-aw.json`. Host lifecycle and client helpers live in `tests/tools/mcp/` and are shared with the facts toolbelt below.

### Facts toolbelt

`node tests/tools/mcp/facts.mjs <command>` asks the running product for facts about the loaded AdventureWorks AI project over MCP, so ground truth does not need an ad-hoc extractor bundle or a regex script: `counts`, `find <text>`, `object <id>` (what it reads and what reads or writes it), `ddl <text>`, `hubs`, `bundle <id> [up] [down]` (scope size), `verify-baseline` (counts and patterns against the graph baseline), `tools` and `call <tool> '<json>'`. Add `--json` for raw output. A host starts for the call (about 12 s); `host up` keeps one running between calls (`host status`, `host down`). These are facts about what the product reports; they cannot show that the product matches the SQL, so read the SQL for that.

Exit codes: 0 all cases passed, 1 a case failed, 4 a prerequisite or the host failed (see the host log in `tmp/mcp-live/host.log`). The result is written to `tmp/mcp-live/report.json`. No model is involved: a pass says nothing about answer quality. Failure meanings for the host itself are in [Test Environments](testing/ENVIRONMENTS.md).

## Electron And UI Automation

EDH tests already launch the extension in VS Code Electron. For UI automation, start one EDH instance with remote debugging enabled and connect Playwright to its CDP endpoint. Keep UI assertions based on visible roles, labels and outcomes. See [Testing](testing/README.md) for optional test configuration and the boundary between smoke and performance checks.

Hosts sharing a profile or CDP port must run sequentially. Independent chat UI hosts may run in parallel with isolated profiles and distinct CDP ports after one shared build. Do not rebuild `out/` while a host is running; the active host may have loaded files from that directory.

## Test Safety

The default EDH lanes require no database or model-provider credentials. Data-bearing lanes use the bundled public demo fixture. The optional `test:ai:smoke` lane requires an explicitly configured provider. Keep credentials in the ignored `.env` file. Do not commit credentials, customer SQL, database archives, raw conversations, traces, or generated test output.

## Native chat and generated report acceptance (Playwright)

`tests/integration/chat-ui.test.ts` runs against an isolated VS Code 1.140 Electron profile with CDP on loopback (fixture port 9377, live port 9376 by default). Build and compile once, then repeat the same command after each test-only adjustment:

```sh
npm run pretest:integration
npx vscode-test --config .vscode-test.chat-ui.mjs
npx vscode-test --config .vscode-test.chat-ui.mjs --label live
npx vscode-test --config .vscode-test.chat-ui.mjs --label badge
npx vscode-test --config .vscode-test.chat-ui.mjs --label column
```

Both lanes check Approve & Proceed, Change scope and Cancel, typed `approve`, typed scope changes and typed `no`, `stop` and `no stop`. Cancel must discard the plan without a hop; stale approval must be ignored. A scope change must produce a reviewable revision without starting analysis. The fixture lane also checks that an unrelated typed question receives an answer while preserving the proposal. Buttons may show their short action labels; internal routing instructions and confirmation status prose must not appear in chat.

Typed intent is classified by the selected model, not by keyword or regex guesses. A bare refusal declines approval. After an ordinary question, the latest answer repeats the native plan buttons while the proposal remains pending, because VS Code can collapse older responses. The live test must exercise those latest controls rather than relying on an expanded history card.

The default fixture lane checks the real native chat input and plan lifecycle with scripted responses. It does not prove generated answer quality. The live lane uses the existing provider profile (`AI_TEST_PROVIDER`, default Fireworks) from ignored `.env` or process variables and `tests/fixtures/AdventureWorks2025_AI.dacpac`. It repeats `Trace all dependencies upstream from  [ai].[spImportOrders]  all level up and one level down`. It explicitly sends `reasoning_effort: low` and `temperature: 0.1` through the test model-provider adapter; neither knob changes the user's Copilot BYOK configuration. Its model/provider identity is printed without credentials. Missing configuration fails the run rather than skipping it.

The live report scenario selects the contributed model in the actual picker, submits the original question, clicks preview and Run trace, and verifies no hop before consent. If the proposed classification is not already both business and technical, Change scope requests that classification while preserving the original depth. Assertions check all upstream levels, one downstream level, both classifications and the eight-node scope before Approve & Proceed starts analysis. The separate action matrix covers typed approval, scope changes and cancellation.

The live lane clicks the actual next-question badge and checks short question bullets, no heading, the invitation to choose a question, one tool-free model call, and unchanged completed analysis. The faster `--label badge` lane replays a previously successful public AdventureWorks AI analysis for setup, then clicks the real badge and makes one live suggestion call. It proves badge submission and the newly generated suggestion, not fresh exploration or synthesis. Missing successful replay evidence fails setup.

The `--label column` lane (also part of `--label live`) sends `@lineage /trace [ai].[PriceMaster].[ListPrice] — trace this column back to its original sources.` through the same input path, approves the plan, then opens the report with the real **Show full description** follow-up. It reads the rendered DOM: the Column Chain lists the value input `CostPrice` and has no source row from `[ai].[CurrencyConfig]`, which `spRefreshPrices` only joins and filters on; that object is still named in the report. Rendering must not break: no literal code fence in the text, no ordered list restarting above 1, and every SQL fence of the assembled description on its own line. Assertions are structural and model-agnostic; the report and a screenshot go to `tmp/chat-ui/live/column-report.txt` and `column-trace.png`.

Formula verification runs separately through headless production AI with the same DACPAC, model and question: inspect the generated Markdown and NDJSON for contextual prose around formulas and no formula-only headings. A formula still fails if its deciding SQL is missing or the explanation contradicts it; for window-based duplicate removal, distinguish partition keys from ordering columns and state the surviving grain. This does not establish rendered layout or general model quality. Keep failed captures in ignored local artifacts.

The input helper pastes through VS Code's public clipboard API into the real editor and presses Enter. It asserts the exact input before submission. This avoids CDP's incomplete support for Chromium EditContext whitespace; it does not invoke a participant handler or a hidden submit API. Production keeps the platform's normal editor settings.

Screenshots, rendered report/follow-up text and provider requests are written only to ignored `tmp/chat-ui/{fixture,live}/`. They contain public-demo content, not keys. Keep the profile and model fixed for comparisons; use distinct `PLAYWRIGHT_CDP_PORT` values for simultaneous hosts. Never attach a test to the user's normal VS Code window. Fixed-response host tests and the deterministic gate remain separate from this live inference check.
