# Local Testing

Tests run on the developer workstation before push. GitHub runs repository
security checks only; it does not run this test framework.

## Two runners, three suites

There are two runners, split by whether a real VS Code is running:

| Tier | Runner | Speed | Answers |
|---|---|---|---|
| **Unit** | Vitest, `vscode` stubbed | seconds | Is the logic right? Parsing, graph building, prompts, schemas, storage. |
| **Extension Development Host** | `@vscode/test-electron`, real VS Code | minutes | Does it work as an extension? Activation, contributed commands, `vscode.lm` registration, and a participant turn driven by a local scripted provider. |

They expose three logical suites: **Core** and **AI** run under Vitest, while
**E2E** runs under VS Code Electron. Focused parser/BFS commands and the five
E2E labels are shortcuts within those suites, not additional test kinds.

Unit tests cannot answer EDH questions: activation, command registration, and
`vscode.lm` behaviour do not exist outside a real host. EDH tests are the only
place those are provable, and the only place they are proven.

### What “AI tests” means

The name identifies the product subsystem under test, not the presence of a
real AI service. `npm run test:ai` runs the AI-core and state-machine unit
projects with a stubbed `vscode` module and deterministic model doubles. No
network request, API key, Copilot installation, or external model is involved.

Those tests exercise our LangGraph phases and termination, model-bridge
translation, tool schemas and dispatch, approval/refinement gates, navigation
rules, cancellation and provider-failure handling, sessions, history, tracing,
and security boundaries. Fixed model responses make the expected state and
tool calls repeatable.

They do **not** measure model reasoning, prompt quality, instruction following,
provider availability, latency, or compatibility with a particular real model.

## Pre-push gate

```bash
npm run gate
```

The maintained steps live in
[`tests/tools/gate.mjs`](../tests/tools/gate.mjs). They cover production and
test type-checking, the core and AI unit projects, both bundles plus the
integration-test compile, package-content safety, and the no-LangSmith boundary.
The gate reports every configured step instead of stopping after the first
failure. It does not launch VS Code Electron or contact a model provider.

## Unit tests

`npm test` runs every `tests/unit/**/*.test.ts` file in one Vitest suite. Core
and AI unit projects can also run independently:

```bash
npm run test:core
npm run test:ai
npm run test:parser
npm run test:bfs
```

`test:core` runs parser and non-AI engine tests. `test:ai` runs AI-core and
state-machine tests. `test:bfs` remains the focused graph traversal/analysis
subset.

Run one file or test name directly when developing:

```bash
node tests/tools/run-vitest.mjs run tests/unit/path/file.test.ts
node tests/tools/run-vitest.mjs run -t "test name"
```

## Extension Development Host lanes

These are the only checks that run inside a real VS Code host. The four lanes
below are the routine set; `scenario-matrix` is a fifth, on-demand lane
documented after them. Each launches the VS Code version declared in
[`.vscode-test.mjs`](../.vscode-test.mjs). None needs credentials or a real
provider, and all are intentionally separate from the deterministic
`npm run gate`.

`npm run test:e2e` runs *every* configured label, `scenario-matrix` included —
one extra host boot, since that lane's own assertions are seconds.

“Scripted” means a local test extension registers a
`vscode.LanguageModelChatProvider` inside the Extension Development Host and
returns fixed text and tool calls. This exercises the real public `vscode.lm`
registration, selection, request, streaming, and tool-result path without
performing inference or making a network request.

`npm run test:e2e` automatically builds the extension host and webview bundles and compiles
`tests/integration/**` into `out/test/` before running every label. Run
`npm run pretest:integration` once first only when invoking a label directly.
The normal gate also performs this compile without launching Electron.

```bash
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:ai-backend
npm run test:participant-turn
```

| Label | Fixture model | Proves | If it goes red |
|---|---|---|---|
| `bare-environment` | none, deliberately | Activation completes and the core command surface registers with no Copilot, no chat model and no `ms-mssql.mssql`. Adding the provider fixture here would void the proof. | The extension may fail to start for a user who has none of the optional integrations. A throw escaping `activate()` unregisters *everything*, so someone who only opens a `.dacpac` loses the graph because of an AI feature they never use. Treat as release-blocking. |
| `tools` | none, deliberately | Every contributed lineage tool is registered with `vscode.lm` and answers through `vscode.lm.invokeTool` — the external entry point Copilot agent mode uses — including the phase-authorization refusal an out-of-phase external call must get. | Either an outside caller (Copilot agent mode, a `#lineage_*` reference) gets broken results, or — worse — a tool that should not be externally reachable now is. Check which assertion failed before shipping. |
| `ai-backend` | scripted | Selected-model adapter, production runtime, canonical dispatcher, approval gate, and revision-bound pending-scope refinement without pre-approval engine publication. | The AI path is broken end to end, but the core product still works. Ships only if the AI surface is knowingly degraded. |
| `participant-turn` | scripted | A real `@lineage` turn through the production `handleChatRequest` API: the no-data notice, and a full turn that streams progress and settles with a terminal `ChatResult`. | A chat turn does not complete: it throws, hangs, or never reaches a terminal result. Users see a stuck or empty response. |

The two fixture-less lanes assert the host's emptiness before asserting
anything else, so a green result cannot be explained by a leaked model.

### The `scenario-matrix` lane

A fifth label exists but is **not** part of `npm run test:e2e`. It is run on
demand:

```bash
npm run pretest:integration
npm run test:scenario-matrix
```

**Purpose.** Drive the provider fixture's scripted **T1–T7 scenario matrix**
(`lineageTestModel.setCase`) through the production `LineageRuntime`, against
the real `tests/fixtures/AdventureWorks2025_AI.dacpac` model rather than a
synthetic graph.

| Case | Shape | Scripted tool / mode |
|---|---|---|
| T1–T3 | one discovery turn | `lineage_get_context`, `lineage_search_objects`, `lineage_search_ddl` |
| T4–T5 | one discovery turn | `lineage_get_scope_bundle` (bounded, then unbounded upstream) |
| T6 | full SM loop | business blueprint, `/trace`-pinned route, upstream depth `all` |
| T7 | full SM loop | column trace of `[ai].[FactSalesReport].TotalRevenue` |

**Runtime expectation.** Fast. The scripted provider answers in-process, so the
nine tests take roughly three seconds in total (slowest case under a second)
inside the usual VS Code host boot. The label carries a 180 s per-test Mocha
timeout anyway — headroom for the suite-level dacpac extraction on a cold
machine and for T6/T7's hop count growing with the fixture graph, not a measured
need. Runtime is therefore *not* the reason this is its own label: it is
separate because it answers a different question than `ai-backend` (full SM loop
versus adapter and dispatcher), and because it is run on demand, outside
`npm run gate` — the gate's footer names it as not covered.

**What it proves.**

- Each scripted discovery tool call is dispatched exactly once and **accepted**
  by the canonical dispatcher (Zod schema plus handler validation), and the
  provider call id survives the dispatch round trip back to the model.
- A `/trace` prompt pins the route deterministically: no entry-detector
  generation happens for T6.
- `session.stateMachine` is published **only after** the consent gate. The gate
  is resolved through the production `LineageRuntime.resumeGate` seam — the same
  call the chat participant's approve action makes — not by reaching into
  `session.activatePendingExploration`.
- The full hop loop terminates: the engine reaches `complete`, the turn reaches
  a single terminal `ok`, and synthesis commits an accepted `present_result`.
- Engine output agrees with structural ground truth
  (`tests/fixtures/ai-graph-groundtruth.json`): every node T6 keeps in scope is
  genuinely upstream of the origin, and T7's origin-anchored column chain
  bottoms out on real upstream nodes. Every T7 column position is additionally
  checked against the ColumnStore, so no edge can name a column the dacpac does
  not have.
- The oracles can fail. A mandatory negative control reruns T4 with an
  unresolvable origin and asserts the run does **not** reach the success oracle.
- The fixture's legacy no-case path is untouched: a guard test reproduces
  `ai-backend`'s first probe with no case selected.

**What it does not prove.** Nothing about model reasoning or prompt quality —
the model side is scripted, so a green run means the runtime handled a
*compliant* model correctly, not that a real model would comply. It also says
nothing about provider availability, latency, or rendering; real-model lanes
remain separate and are started explicitly.

**Known fixture gap (T7).** The scripted `column_flow` never emits
`writes_to`, the field that redirects a writer procedure's output column onto
the table column it writes. Every stored-procedure hop is therefore a dead end
in the column chain, and the branches feeding it are not connected to
`TotalRevenue`. This is a limitation of the script, not of the engine, so the
test pins it: it asserts that every stranded chain bottoms out on a
**procedure**. That fails both if the engine ever strands a chain on a table or
view (a real defect) and once the fixture learns `writes_to` — at which point
the block should be replaced with a plain zero-off-trace assertion.

**If it goes red.** Check whether the failure is a dispatch rejection (a tool
contract or the dacpac fixture moved) or a loop/gate failure (the SM pipeline
regressed). A red T6/T7 with green `ai-backend` means the multi-hop loop broke
while the adapter still works.

The participant-turn lane records calls made to `ChatResponseStream`; it does
not automate or inspect the rendered Chat panel. Visual rendering remains a
manual UAT concern. Real-model lanes are also separate from this tracked test
suite and must be started explicitly with their required provider setup.

Why separate lanes and not one merged run: the lanes need two different launch
profiles (with and without the language-model fixture), and merging within a
profile would trade the ability to name the broken concern for two fewer VS
Code startups. Boot dominates the runtime — `bare-environment`'s assertions
take well under a second inside a lane that spends minutes starting the host —
so the saving is small and the diagnostic loss is not. `scenario-matrix` is the
one lane where boot does *not* dominate, which is the separate reason it stays
its own label rather than joining `ai-backend`.

## Headless real-model lanes

The third runner. It is neither Vitest nor VS Code: a plain Node process drives
the **production** pipeline (discovery → consent gate → hops → synthesis)
against a real provider over an OpenAI-compatible `/chat/completions` endpoint,
and records every byte both ways. It answers the one question the other two
cannot — *what does a real model actually do with our prompts?* — and it is
therefore a measurement instrument, not a pass/fail test. It is never part of
`npm run gate`; the gate's footer names it as not covered.

```bash
npm run compile:harness
npm run test:e2e-real -- --lane openrouter --prompt P1 --runs 1 --trace-verbose
npm run test:e2e-real -- --help          # flags and the full prompt registry
```

The harness lives in [`tests/harness/`](../tests/harness/) and is **tracked, not
gitignored**, so the gate typechecks it on every run. It ships to nobody:
`.vscodeignore` excludes it and
[`assert-package-contents.mjs`](../tests/tools/assert-package-contents.mjs)
additionally forbids `out/test/` and `stubs/` in the VSIX, so its absence is
proven rather than assumed.

### Lanes

| Lane | Endpoint | Default model | Context window | Notes |
|---|---|---|---|---|
| `azure-foundry` | `https://<resource>.services.ai.azure.com/openai/v1` — **must** come from the environment; the resource name is customer-specific and is never committed | `gpt-4.1` | 128k | Serves both protocols; the harness always uses `/chat/completions` so lane traces stay diffable |
| `openrouter` | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | 64k | `echoReasoning` on: DeepSeek routes answer `500` when a prior assistant turn comes back without its `reasoning_content`. No request tuning by default — see below |
| `local-mlx` | `http://127.0.0.1:8080/v1` | `local-model` | 32k | The local oMLX server is key-protected; the key is sent as a Bearer header exactly like the hosted lanes |

Configuration is read from the gitignored `.env` (loaded by the launcher without
overwriting anything already exported) using three variables per lane:

```
LINEAGE_<LANE>_API_KEY      required — its absence is what makes the lane self-skip
LINEAGE_<LANE>_BASE_URL     optional override; REQUIRED for azure-foundry
LINEAGE_<LANE>_MODEL        optional override
```

`<LANE>` is the lane id upper-cased with `-` → `_`
(`LINEAGE_AZURE_FOUNDRY_API_KEY`, `LINEAGE_OPENROUTER_API_KEY`,
`LINEAGE_LOCAL_MLX_API_KEY`). **No environment value is ever printed** — not the
key, not the base URL. The banner reports `key=<VARNAME>:present` and nothing
more, and no record of any kind carries request headers.

**Request tuning: seam only, no lane defaults.** The port exposes
`requestTuning` ([`lanes.ts`](../tests/harness/lanes.ts) /
[`openAiCompatiblePort.ts`](../tests/harness/openAiCompatiblePort.ts)):
`reasoning` (`{enabled: false}` or `{effort: …}`) and `providerSort`
(`throughput` | `latency` | `price`), each sent verbatim in the request body
and therefore visible in every verbose trace's `provider-raw` capture. **No
lane sets either by default**, a decision made from measurement (2026-08-07,
six T6 runs on `deepseek/deepseek-v4-flash`):

| Config | Backend routed | Result |
|---|---|---|
| default routing, default reasoning | DeepInfra | `ok` in 534s (5 hops), and `cancelled` at the 15-min watchdog when the model chose `depth="all"` (12 hops × 30–182s reasoning-heavy generations, 99.8% of wall clock inside model calls — no loop, no stall) |
| `provider: {sort: "throughput"}`, any reasoning level (off / low / default) | CoreWeave | ~10x faster per generation, but **all four runs failed**: the model re-sent the same over-length `badge_label` until the 3-failure semantic budget stopped the turn — the same mistake both DeepInfra runs repaired in one retry |

Two published behaviors explain the latency side: DeepSeek reasons by default
and under `stream: false` time-to-first-byte is the full reasoning duration
([DeepSeek-V3#1464](https://github.com/deepseek-ai/DeepSeek-V3/issues/1464));
and OpenRouter's default load balancer weights by inverse-square *price*, with
a ~14x throughput spread across backends serving the same model
([provider routing docs](https://openrouter.ai/docs/guides/routing/provider-selection)).
The schema-repair split between backends was only attributable because the
verbose trace captures the response's `provider` field — a lane default that
silently changed backend or reasoning behavior would distort exactly what the
harness measures, so tuning is opt-in per experiment. A watchdog `cancelled`
on a legitimately huge plan is a recorded measurement, not a defect; widen
`--timeout-ms` for runs where unbounded-depth plans are the subject.

**Self-skip contract.** A lane with no key prints
`[e2e] SKIP lane=<id> reason=missing-env:<VAR>` and exits **0**. A lane that is
configured *incorrectly* — a base URL that is not http(s), or one carrying a
`/chat/completions` or `/responses` suffix the port appends itself — prints a
message naming the variable and exits **4**. Never confuse the two: a machine
without OpenRouter credentials must still be able to run everything else.

### Run directories and exit codes

```
test-results/e2e/<iso>-<lane>/
  batch.json                     every run's summary, plus the lane and prompt
  run-<n>/
    run.json                     the measurement row (see runSummary.ts)
    answer.md                    the user-visible answer text
    host.log                     the [AI]/[Hop]/[CT]/[Reject] DEBUG trail
    hop-log.json                 session hop log
    sm-state.json                engine dump — ABSENT when no exploration ran
    present-result.json          the accepted presentation artifact, when one exists
    lm-trace/trace-<iso>.ndjson  the full NDJSON trace (production layout)
```

| Code | Meaning |
|---|---|
| 0 | Every run reached a terminal `ok`, or the lane self-skipped |
| 2 | At least one run ended in an error |
| 3 | At least one run was cancelled (including the `--timeout-ms` watchdog) |
| 4 | Configuration error — bad flags, or a lane that is configured wrongly |

`--runs N` performs N **independent** runs and never retries anything: a
failure is a measurement. The process code is the worst outcome across runs,
ranked `ok < cancelled < error < config`.

### Prompt registry

`--prompt` takes a registry id or free text (free text is recorded as
`source: 'free-text'` so it can never be mistaken for a baseline run).

- **P1–P3** — the quality baseline the AI scoring loop uses. ⚠ These texts are
  **RECONSTRUCTED** (2026-08-07): the verbatim originals lived in a `tmp/baseline/`
  directory this machine does not have, so they were expanded from the quality
  skill's abbreviated forms, the baseline was declared **reset**, and the
  constants in [`tests/harness/prompts.ts`](../tests/harness/prompts.ts) are
  frozen. Changing one silently invalidates every cross-run comparison — treat
  it as an `ai-change-guard` change.
- **T1–T7** — the same seven scenarios the scripted `scenario-matrix` lane pins,
  with the same prompt texts. The difference is what is pinned: there the answer
  is scripted and the runtime is under test; here only the prompt is fixed and
  the model chooses the route. A T-run whose model picks a different tool than
  the scripted case is a finding about the model or the prompt — not a failure.

### Langfuse

`--langfuse` posts each parsed run to Langfuse Cloud's public ingestion API
(one trace per turn, one generation observation per model call) using
`LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`. Zero new
dependencies — it is a hand-rolled `fetch` client. Without those variables the
flag self-skips and the run is unaffected; message content is attached only when
the trace ran `--trace-verbose`, because a non-verbose trace records the system
prompt's hash and not its text.

### LangSmith

`--langsmith` posts each parsed run to LangSmith's `POST /runs/batch` REST
endpoint (one root `chain` run per turn, one child `llm` run per model call,
nested by `trace_id`/`parent_run_id`/`dotted_order`) using `LANGSMITH_API_KEY`
(required), `LANGSMITH_PROJECT` (optional, sets `session_name`), and
`LANGSMITH_BASE_URL` (optional, defaults to `https://api.smith.langchain.com`).
Both `--langfuse` and `--langsmith` can be passed together. This is unrelated
to the LangSmith containment invariant in `CLAUDE.md`/`AGENTS.md`: the exporter
is a hand-rolled `fetch` client in test tooling, never imports the `langsmith`
package, and never sets `LANGSMITH_TRACING`/`LANGCHAIN_TRACING*` — it only
posts trace data the harness already captured, over the network, from outside
the extension bundle. Without `LANGSMITH_API_KEY` the flag self-skips; as with
Langfuse, message content is attached to a generation only under
`--trace-verbose`, while token usage is always attached.

### Two lane differences you must account for when comparing

1. **A real `{role:'system'}` message.** `vscode.lm` has no system role, so the
   Copilot lane folds the system instruction onto the leading user turn. This
   lane sends a genuine system message. That is a fidelity improvement — it
   closes the system-prompt blind spot — but the two lanes do **not** send
   byte-identical requests, and a prompt-following difference between them may
   be this and nothing else.
2. **Output templates are loaded here.** The harness session loads
   `assets/aiOutputTemplates.yaml` exactly as activation does, which the scripted
   EDH lanes do not. Synthesis is therefore shaped by the real templates on this
   lane and by `EMPTY_AI_TEMPLATES` there.

### Proving the path offline

A hidden `--fixture <file>` flag swaps only the transport for a rule table read
from a tracked JSON file
([`tests/fixtures/e2e-cli/`](../tests/fixtures/e2e-cli/)); lane resolution, the
port, the runtime, the session, the trace writer and the summary all run
unchanged. Use it to prove the whole CLI path with zero network before spending
a credentialed run:

```bash
npm run test:e2e-real -- --lane openrouter --prompt T1 --runs 1 \
  --trace-verbose --fixture tests/fixtures/e2e-cli/t1-discovery.json
```

## Package and evidence safety

The package-content allow/deny contract lives in
[`tests/tools/assert-package-contents.mjs`](../tests/tools/assert-package-contents.mjs).
It verifies publishable runtime artifacts and rejects development-only or
sensitive content.

Runtime diagnostics can contain database identifiers. Keep them local, review
them before sharing, and never commit credentials, customer SQL, proprietary
database archives, raw model conversations, or tool payloads.
