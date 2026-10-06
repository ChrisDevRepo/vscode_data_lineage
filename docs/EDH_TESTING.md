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
| `tools` | Contributed read-only language-model tools register and respond through the VS Code API. |
| `participant-turn` | The `@lineage` participant handles an empty-data case and completes a turn through the public chat API. A fixture provider supplies fixed responses to exercise API wiring and turn lifecycle. |
| `kill-switch` | Disabling the AI feature before activation leaves the non-AI extension surface available. |

The fixture provider does not perform inference and does not test answer correctness, prompt quality, or provider behavior. Use an explicitly configured real-model smoke check for those purposes; the public demo DACPAC is the appropriate data source.

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

Formula verification runs separately through headless production AI with the same public DACPAC, model and original question. Inspect the generated Markdown and fresh NDJSON for contextual prose around substantive formula groups, or short explanatory descriptions alongside formulas in tables, and the absence of formula-only headings or subsections. This establishes generated-content behavior; it does not establish rendered webview layout. These are dataset-specific acceptance observations; one run is not a universal latency or model-quality guarantee.

Check capture memory before synthesis and assess factual correctness separately from layout. A contextual formula still fails acceptance if its deciding SQL is missing or its explanation contradicts the SQL. For window-based duplicate removal, distinguish partition keys from ordering columns and describe the surviving grain after removal; a formatted equation alone cannot establish that grain. Preserve failed captures in ignored local artifacts and do not report a model-quality pass from deterministic renderer tests.

The input helper pastes through VS Code's public clipboard API into the real editor and presses Enter. It asserts the exact input before submission. This avoids CDP's incomplete support for Chromium EditContext whitespace; it does not invoke a participant handler or a hidden submit API. Production keeps the platform's normal editor settings.

Screenshots, rendered report/follow-up text and provider requests are written only to ignored `tmp/chat-ui/{fixture,live}/`. They contain public-demo content, not keys. Keep the profile and model fixed for comparisons; use distinct `PLAYWRIGHT_CDP_PORT` values for simultaneous hosts. Never attach a test to the user's normal VS Code window. Fixed-response host tests and the deterministic gate remain separate from this live inference check.
