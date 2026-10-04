# Testing

## Default Checks

```sh
npm install
npm test                    # deterministic unit tests
npm run test:core           # parser, engine and webview
npm run test:runtime        # AI runtime contracts, without inference
npm run gate                # configured deterministic checks
```

Focused parser and graph checks are `npm run test:parser` and `npm run test:bfs`. TypeScript checks are `npm run typecheck` and `npm run typecheck:tests`. The repository has no lint script.

Function caller-context and findings-schema regressions can be checked together:

```sh
npm test -- tests/unit/sm/function-caller-context.test.ts tests/unit/sm/fresh-kept-schema-parity.test.ts
```

These tests cover qualified scalar destinations, TVF argument context, directed
contributors, stale SQL and checkpoint provenance, input identity, fresh kept
requirements, legal cuts and held repairs. They create no model calls. Check
model-authored argument bindings and omitted SQL contributors separately; a
structurally valid delivered graph does not establish complete SQL lineage.

Identifier-policy regressions include synthetic CI/CS metadata, messy delimited SQL,
case-only schema/object/function/column twins, CT route rejection and completeness,
saved-run policy, metadata display names, and graph/export consumers:

```sh
npm test -- tests/unit/parser/identifier-case.test.ts tests/unit/sm/identifier-policy-checkpoint.test.ts tests/unit/ai-core/identifier-runtime-flow.test.ts tests/unit/engine/columnTraceView.test.ts
```

These cases exercise backend contracts without a live database or model inference.
The complete deterministic gate also checks coverage floors, layering, build and packaging.
Large-input regressions require complete extraction beyond the former 10,000-match
cutoff and termination for zero-width custom rules, including Unicode text.
The runtime fixture uses the real tool registry and approval, BB/CT hop, retry,
synthesis and checkpoint paths with a fixed-response model port. It verifies the
metadata-derived CS hint reaches the authoring stages; it does not measure whether
an inference model follows that hint. Legacy CI escaped-bracket ID ambiguity and
complex SQL without statement delimiters remain outside this case-policy guarantee.

## Build And Install A VSIX

Build the extension package from the repository root:

```sh
npm install
npm run package
```

This runs the VS Code packaging tool and creates `data-lineage-viz-<version>.vsix` in the repository root. In VS Code, open **Extensions**, select the **…** menu, choose **Install from VSIX…**, and select that file. The `code` command line is also available:

```sh
code --install-extension ./data-lineage-viz-<version>.vsix
```

Test the VSIX in a separate VS Code profile before sharing it. Packaging does not publish the extension.

## Optional Integration Checks

`npm test` and `npm run gate` require no database, model provider, tracing account, or graphical session.

| Check | Setup | Purpose and limit |
|---|---|---|
| Database metadata smoke | Configure `DB_TEST_SERVER`, `DB_TEST_DATABASE`, `DB_TEST_USER`, `DB_TEST_PASSWORD`, optional TLS/port settings; run `npm run test:db:smoke`. | SQL-login connection, schema discovery and metadata import through the built-in provider. Read-only queries against your disposable/demo database; no provisioning. For Microsoft Entra ID or the mssql extension provider, use the extension connection flow manually. |
| Electron host | `npm run test:edh` | Exercises extension behavior in the VS Code Electron host. The fixture-backed participant lane is deterministic API wiring, with no model inference. |
| Playwright UI smoke | Run `npm run build`, then `npm run test:gui:host`; in another terminal, run `npm run test:gui:smoke`. | Uses an isolated downloaded VS Code test host, opens the demo through the command palette and confirms a React Flow graph renders in the workbench. |
| UI performance | Use the same EDH/CDP setup with a fixed public demo dataset and a named device/runtime. | Manual measurement: record warm/cold state, dataset size, repetitions, median and p95. Results describe that setup only; do not use one-machine timings as general thresholds. |
| Real-model Electron smoke | Configure `AI_TEST_PROVIDER`, `AI_TEST_ENDPOINT`, `AI_TEST_API_KEY`, `AI_TEST_MODEL`, and optionally `AI_TEST_REASONING_EFFORT`; run `npm run test:ai:smoke`. Provider profiles cover Azure OpenAI, Fireworks, OpenRouter and OpenAI-compatible APIs. | Calls a real model through a `vscode.LanguageModelChatProvider` adapter and the `@lineage` participant against the public demo DACPAC. It checks that the turn completes and returns text; review answer correctness and completeness against SQL/graph yourself. This smoke is opt-in and may incur provider cost. |

## Optional Headless AI And Langfuse

```sh
npm run test:ai:headless -- --prompt "Summarize the loaded database"
npm run test:ai:headless -- --dacpac /path/to/test.dacpac --prompt "Trace dependencies" --followup "Explain the upstream objects"
npm run test:ai:headless -- --prompt "Summarize the loaded database" --langfuse
npm run test:ai:headless -- --help
npm run test:db:smoke -- --help
npm run test:scale
```

Headless AI loads `assets/demo.dacpac` by default and invokes the production runtime in Node with an OpenAI-compatible transport. It uses the same `AI_TEST_*` profiles as the Electron smoke. Supply your own prompts; the public runner has no question bank, scorer, provider campaign, or benchmark history. Consent gates receive simulated approvals, so this checks runtime execution rather than interactive consent or VS Code provider behavior. Electron and Playwright remain separate optional tools.

Headless AI and database smoke have a five-minute whole-run deadline; override it with `--timeout-ms` (1–7,200,000). Results and diagnostic files go under ignored `test-results/headless/`. `run.json` reports runtime outcome, duration, turn/model-call counts where applicable, and an independent export outcome. Exit codes are 0 for completion, 2 for runtime/export failure, 3 for cancellation, and 4 for configuration failure. Completion alone is not answer correctness evidence.

Langfuse export has a separate 30-second timeout. It receives traces only with `--langfuse` and all three `LANGFUSE_*` settings. The exporter uses [Langfuse's OTLP/HTTP JSON endpoint](https://langfuse.com/integrations/native/opentelemetry); no telemetry SDK is added. Prompt/system bodies are omitted by default; `--trace-verbose` explicitly enables their capture and export. Local diagnostic answers and tool artifacts can contain your supplied database metadata: use public/synthetic data and keep artifacts ignored.

`test:scale` exercises layout correctness at the 1,500-node render ceiling. It is deliberately outside `npm test` and `gate`; printed timings describe this run and are not performance thresholds. Fast size-limit and traversal assertions remain in the default suite.

## Environment Template

Copy `.env.example` to `.env`; `.env` is ignored by Git. Fill only the section for the optional check being run. Do not paste secrets into shell history or test logs.

For provider configuration, choose one active profile per run. The adapter uses the Chat Completions API. For Azure, provide either the resource URL (the adapter adds the deployment route and `api-version=2024-10-21`) or an Azure `/openai/v1` endpoint. `AI_TEST_MODEL` is the Azure deployment name. For an OpenAI-compatible service, provide its API base URL and model id. Alternatively, set `AI_TEST_PROVIDER` to `azure`, `fireworks`, or `openrouter` to read a matching provider profile from `.env` or the process environment; `openai-compatible` reads generic `AI_TEST_*` values. Keep credentials in ignored `.env`, never in the template.

`AI_TEST_REASONING_EFFORT` describes the provider's supported reasoning level. Accepted values vary by provider/model; leave it empty when unsupported. Do not assume that the same label produces equivalent reasoning across providers.

For Playwright, start the host:

```sh
npm run build
npm run test:gui:host
```

Then run the smoke from another terminal:

```sh
npm run test:gui:smoke
```

`test:gui:host` uses the VS Code build managed by `@vscode/test-electron`, fresh temporary workspace, user-data and extensions directories, and a loopback-only CDP endpoint. It writes an ignored active-session marker that the smoke validates before attaching, so the smoke does not connect to a normal VS Code instance. Stop the host with Ctrl-C after the smoke finishes.

## Reading AI Evidence

Compare AI answers with the public fixture's SQL and graph before comparing token usage or latency. For debugging, inspect the model context, tool calls and results in the session trace and extension log. See [AI architecture](../ARCHITECTURE.md) for the runtime and diagnostics.

## Keeping The Suite Lean

Public checks protect deterministic product contracts; local checks retain editorial prompt expectations, answer scoring, trace-replay corpora, exhaustive matrices, and benchmark campaigns. A deterministic runtime check is useful publicly even when it uses a synthetic question. Select representative missing contracts rather than publishing every local regression file.

Before deleting or merging a test, identify the retained assertion protecting its behavior, including relevant failure cases. Prefer a shared fixture or parameterized cases over repeated setup. Preserve parser cases, input identity, cancellation, trust boundaries, persistence, accessibility, packaging, and LangSmith containment. Coverage floors apply to the existing core modules; they are supporting evidence, not an answer-quality score.

The warm default-suite review budget is 30 seconds on the documented reference machine, not a timing assertion or universal promise. No file-count, line-count, or repository-wide coverage target is imposed. Optional services and large layouts stay outside the default gate. No test CI or scheduler is introduced.

For approval controls, pending chat input and next-question badges, run the opt-in [native chat Playwright acceptance lanes](../EDH_TESTING.md#native-chat-and-generated-report-acceptance-playwright). Run the fixture lane for request lifecycle and the live lane for the actual follow-up badge and generated reply. The fast `npx vscode-test --config .vscode-test.chat-ui.mjs --label badge` lane replays a successful public analysis for setup and makes one live call after clicking the actual badge; it does not prove fresh synthesis. Verify contextual formulas separately with headless production AI and direct inspection of the generated Markdown and fresh NDJSON, using the same public DACPAC, model and original question; this does not prove rendered webview layout. A synthetic answer or a direct call to `handleChatRequest` cannot establish end-to-end UI or model correctness. Repeat these CLI commands using the same saved approval prefix instead of constructing a new shell command for each attempt.
