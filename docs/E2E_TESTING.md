# Local Testing

Tests run on the developer workstation before push. GitHub runs repository
security checks only; it does not run this test framework.

## Model tiers — the axis that decides what a result may be quoted as

Four tiers exist. Every suite belongs to one, and the tier — not the subsystem it
covers — decides what a green run is evidence of. **Nothing automated runs the
product's real path.**

| Tier | Model | Runs through | Suites | A green run proves |
|---|---|---|---|---|
| **none** | no provider at all | stubbed `vscode`, or a real host with no provider | `test:core`, `test:runtime`, `test:prompts`, EDH `bare-environment`, `tools` | Deterministic logic and extension wiring |
| **scripted** | fixture replaying fixed output | real Electron host, **real `vscode.lm`** | EDH `scripted-provider`, `participant-turn`, `scenario-matrix` | Runtime wiring: dispatch, schemas, gates, engine scope vs ground truth |
| **live provider** | **real inference, real network** | headless — the harness's own model port plus a `vscode` shim, so **`vscode.lm` is bypassed** | `test:live-provider` | How a model behaves against these prompts, through a substitute port |
| **product** | the user's own Copilot / BYOK model | real VS Code, real user | **none — UAT only** | The thing that actually ships |

Note the asymmetry, because it is the honest limit of this framework: the only
automated tier that exercises the real `vscode.lm` path performs no inference,
and the only tier that performs inference does not use that path. Nothing
combines them. "Real" is therefore not a name any script may carry — that is
what UAT is for, and `assert-honest-test-labels.mjs` enforces it.

One consequence worth carrying: because `test:live-provider` measures through
[`tests/harness/openAiCompatiblePort.ts`](../tests/harness/openAiCompatiblePort.ts)
rather than `VscodeModelPort`, any drift between those two ports means a
model measurement describes code the product does not run. That drift is what
the shared port contract exists to catch — see §Port equivalence below for what
it does and does not cover.

A suite is never named for AI on
the strength of the subsystem it covers: `test:runtime` exercises the LangGraph
phases, model-bridge translation, tool schemas and dispatch, gates, navigation
rules, cancellation, sessions, history and trace security — with a stubbed
`vscode` and scripted doubles, so it is a functional test of the agent runtime,
not an AI test. `npm run gate` prints `MODEL CALLS: 0` for the same reason, and
every EDH lane prints its own tier before its first assertion.

### Reporting rule

State the tier, the suite names, and their exit codes. Four statements are
prohibited because each has been made and each was false:

- "the tests pass" without naming which ran
- "the AI tests pass" for anything below the **live provider** tier
- "e2e succeeded" as an answer to a question about model behaviour, answer
  quality, NDJSON traces, or Langfuse — none of which the **none** or
  **scripted** tiers produce
- anything at all reported as "real". No automated suite runs the product path;
  `test:live-provider` calls a model but not through `vscode.lm`, and the
  Electron lanes use `vscode.lm` but call no model

An NDJSON trace and a Langfuse export come only from
[`tests/harness/cli.ts`](../tests/harness/cli.ts), which `npm run test:e2e-electron` never
enters. A run that produced no trace cannot be checked with `/trace-debug`.

Unit suites cannot answer EDH questions: activation, command registration, and
`vscode.lm` behaviour do not exist outside a real host. EDH lanes cannot answer
model questions, for the same structural reason.

The deterministic core is SQL parsing and BFS graph traversal — dependency
extraction from DDL, graph construction, and the traversal and analysis built on
it. That is what the **none**-tier suites are built to prove, and what a change
should be measured against.

### Live database and DMV import are UAT, not a suite

No runner connects to a database. Live-database ingestion — connecting through
`ms-mssql.mssql`, executing the DMV queries, `{{SCHEMAS}}` expansion against a
real catalog, result shapes, platform detection, and loading a custom
`dmvQueriesFile` — is verified by manual UAT against a real server and is
deliberately outside the automated framework. Do not add unit or EDH coverage
for it, and do not report its absence as a coverage gap.

What the suite does cover is everything downstream of the wire that needs no
server: `tests/unit/parser/dmvExtractor.test.ts` drives `buildModelFromDmv`,
`validateQueryResult`, `mapServerInfoPlatform`, and `isPhase2Query` over
synthetic result sets. That is model building from DMV-shaped data, not database
access, and the distinction is the whole reason it can be automated.

One consequence worth knowing when planning UAT: a custom `dmvQueriesFile` that
fails its `version` check falls back to the built-in queries, so the import
still succeeds. Confirm the file was actually applied by reading the
**Data Lineage Viz** output channel — a green import alone does not prove it.

## Pre-push gate

```bash
npm run gate
```

The maintained steps live in
[`tests/tools/gate.mjs`](../tests/tools/gate.mjs). They cover production and
test type-checking, the generated-tool-manifest drift check
(`scripts/generate-tool-manifest.mjs --check`), the AI template schema-version
gate (`tests/tools/assert-template-schema-version.mjs`), the honest-test-label
check (`tests/tools/assert-honest-test-labels.mjs`), the unit-project coverage
check that makes the three unit steps add up to the whole suite
(`tests/tools/assert-unit-projects-cover-all.mjs`), the core, agent-runtime
and prompt-golden unit projects, both bundles plus the integration-test compile,
package-content safety, and the no-LangSmith boundary. The gate reports every
configured step instead of stopping after the first failure. It does not launch
VS Code Electron or contact a model provider.

## Unit tests

`npm test` runs every `tests/unit/**/*.test.ts` file in one Vitest suite. The
three unit projects and the focused Core subsets can also run independently:

```bash
npm run test:core
npm run test:runtime
npm run test:prompts
npm run test:parser
npm run test:bfs
```

`test:core` runs parser and non-AI engine tests (`tests/unit/parser`,
`tests/unit/engine`).
`test:runtime` runs agent-runtime and state-machine tests (`tests/unit/ai-core`,
`tests/unit/sm`). `test:prompts` runs the prompt golden tests
(`tests/unit/prompts`).

`test:parser` and `test:bfs` are the two focused Core subsets, and they are the
deterministic heart of the product: `test:parser` covers SQL parsing and
dependency extraction, `test:bfs` covers graph construction, traversal, and
analysis only (`graphBuilder`, `graphAnalysis`, `graph-analysis-aw`).
`NavigationEngine` and state-machine coverage lives in `test:runtime`.

Run one file or test name directly when developing:

```bash
node tests/tools/run-vitest.mjs run tests/unit/path/file.test.ts
node tests/tools/run-vitest.mjs run -t "test name"
```

## Extension Development Host lanes

These are the only checks that run inside a real VS Code host. Each launches the
VS Code version declared in [`.vscode-test.mjs`](../.vscode-test.mjs). None needs
credentials or a real provider, and all are intentionally separate from the
deterministic `npm run gate`.

"Scripted" means a local test extension registers a
`vscode.LanguageModelChatProvider` inside the Extension Development Host and
returns fixed text and tool calls. This exercises the real public `vscode.lm`
registration, selection, request, streaming, and tool-result path without
performing inference or making a network request.

### What a host buys, and why no lane here calls a model

These lanes prove the extension *is* an extension. `activate()`, contribution
points, command registration, `vscode.lm` provider registration, and
`vscode.lm.invokeTool` do not exist in a Node process, so a broken activation
event, a missing manifest entry, an unregistered command, or a tool that became
externally reachable when it should not be can fail **only** here — and the
headless harness cannot fail on any of them because it never calls `activate()`.

The converse holds too, which is why the fixture is scripted-only and deliberately
carries no live-provider mode. Everything a host adds is deterministic wiring:
the LangChain↔`vscode.lm` translation does not care whether the text it carries
came from inference or from a fixture. Putting a real model behind Electron would
re-prove, expensively and non-deterministically, what
`npm run test:live-provider` already proves headless. Model in the cheap place,
wiring in the host — the split is intentional, not a missing capability.

### Port equivalence

The seam between those two surfaces — whether
[`openAiCompatiblePort.ts`](../tests/harness/openAiCompatiblePort.ts) still
matches `VscodeModelPort`, which it mirrors by hand — is a deterministic
equivalence question, so it is answered by a differential unit test rather than
a credentialed host lane.
[`tests/unit/ai-core/helpers/portContract.ts`](../tests/unit/ai-core/helpers/portContract.ts)
exports one port-agnostic acceptance suite, `describePortContract`, and both
ports run it unchanged:
[`vscode-model-bridge.contract.test.ts`](../tests/unit/ai-core/vscode-model-bridge.contract.test.ts)
scripts the `vscode.lm` transport,
[`openai-model-port.contract.test.ts`](../tests/unit/ai-core/openai-model-port.contract.test.ts)
hands the HTTP port a canned `/chat/completions` body. Both run in
`npm run test:runtime`, so a semantic divergence fails in the gate rather than
in a live-provider run.

Read the scope honestly. The suite pins the part of the boundary the graph
depends on and cannot re-check for itself: validation happens *before* dispatch
(an invalid call is a completed generation carrying a rejection, never an
exception), provider input is never mutated, a rejected call is classified by a
stable code, exactly one physical provider attempt is made per generation, and a
pre-aborted signal spends nothing. It is not a byte-level equivalence proof of
everything the two transports do — a case that can only hold on one transport
lives in that port's own file, by construction.

`npm run test:e2e-electron` runs every configured label. It automatically builds the
extension host and webview bundles and compiles `tests/integration/**` into
`out/test/` first. Run `npm run pretest:integration` once yourself only when
invoking a label directly. The normal gate also performs this compile without
launching Electron.

```bash
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:scripted-provider
npm run test:participant-turn
npm run test:scenario-matrix
```

| Label | Fixture model | Proves | If it goes red |
|---|---|---|---|
| `bare-environment` | none, deliberately | Activation completes and the core command surface registers with no Copilot, no chat model and no `ms-mssql.mssql`. Adding the provider fixture here would void the proof. | The extension may fail to start for a user who has none of the optional integrations. A throw escaping `activate()` unregisters *everything*, so someone who only opens a `.dacpac` loses the graph because of an AI feature they never use. Treat as release-blocking. |
| `tools` | none, deliberately | Every contributed lineage tool is registered with `vscode.lm` and answers through `vscode.lm.invokeTool` — the external entry point Copilot agent mode uses — including the phase-authorization refusal an out-of-phase external call must get. | Either an outside caller (Copilot agent mode, a `#lineage_*` reference) gets broken results, or — worse — a tool that should not be externally reachable now is. Check which assertion failed before shipping. |
| `scripted-provider` | scripted | Selected-model adapter, production runtime, canonical dispatcher, approval gate, and revision-bound pending-scope refinement without pre-approval engine publication. | The AI path is broken end to end, but the core product still works. Ships only if the AI surface is knowingly degraded. |
| `participant-turn` | scripted | A real `@lineage` turn through the production `handleChatRequest` API: the no-data notice, and a full turn that streams progress and settles with a terminal `ChatResult`. | A chat turn does not complete: it throws, hangs, or never reaches a terminal result. Users see a stuck or empty response. |
| `scenario-matrix` | scripted, **mandatory** | The tracked S1–S7 scenario matrix driven through the production `LineageRuntime`: that the dispatcher accepted each tool input against its Zod schema, that call ids survived the round trip, that every turn reached a terminal state, and that engine scope agrees with the dacpac ground truth. The fixture scripts the model side; every assertion is about something it cannot fake. Runs on a 180s timeout for cold-machine dacpac extraction. | The runtime mis-handles a scripted route that used to work, or engine scope has drifted from ground truth. Read which scenario failed: a schema rejection and a scope mismatch are different defects. |

The two fixture-less AI lanes assert the host's emptiness before asserting
anything else, so a green result cannot be explained by a leaked model.

### One host at a time — the lanes are serial by design

Run the lanes through `npm run test:e2e-electron`, or one label at a time. Never run two
labels concurrently, and never edit [`.vscode-test.mjs`](../.vscode-test.mjs) to
make concurrency possible.

Every label shares one Electron profile — `@vscode/test-electron` appends
`--user-data-dir=<cache>/user-data` whenever `launchArgs` does not already carry
one — and they share the single `out/` build the whole run reads from. Two hosts
at once contend for both. This is not a limit worth engineering around: the five
lanes together finish in well under a minute of host time, so the only thing
parallelism can buy is a class of failure that does not otherwise exist.

Two specific edits are prohibited, because both have already produced a red run
that had nothing to do with the code under test:

- **A per-label `--user-data-dir`.** A *relative* path is resolved by Electron
  against its own working directory — the downloaded VS Code install, which on
  Windows sits under `C:\Program Files\` — so the host dies with
  `EPERM: operation not permitted, mkdir` and a modal error dialog before a
  single suite runs. Any surviving host keeps that dialog open until it is
  dismissed by hand.
- **Rebuilding while a host is live.** `npm run pretest:integration` overwrites
  the `out/` tree the running host has already loaded. Build once, before the
  first label.

A lane result is only evidence if it came from a host launched this way. Report
which labels ran and their exit codes; never infer a lane from another lane.

### Host log noise on Windows

Every host boot prints two lines that look like failures and are not. Neither
comes from this extension or its tests; both are the downloaded VS Code build
logging about itself. Judge a lane by its Mocha summary and exit code.

```
[main …] Error: Error mutex already exists
    at Ls.installMutex (…/resources/app/out/main.js)
Warning: 'cached-data' is not in the list of known options, but still passed to Electron/Chromium.
```

The mutex line appears when another VS Code of the same build is already
running — including the editor the lane was launched from. It is logged after
the host window is already up and nothing depends on the mutex. The
`cached-data` line is Electron reporting `--no-cached-data`, which
`@vscode/test-electron` passes to every host. Neither can be suppressed from
this repository.

## Package and evidence safety

The package-content allow/deny contract lives in
[`tests/tools/assert-package-contents.mjs`](../tests/tools/assert-package-contents.mjs).
It verifies publishable runtime artifacts and rejects development-only or
sensitive content.

Runtime diagnostics can contain database identifiers. Keep them local, review
them before sharing, and never commit credentials, customer SQL, proprietary
database archives, raw model conversations, or tool payloads.
