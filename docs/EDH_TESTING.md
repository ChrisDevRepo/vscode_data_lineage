# Local Testing

Tests run on the developer workstation before push. GitHub runs repository
security checks only; it does not run this test framework.

## What the public suite proves

Two tiers exist here, and the tier — not the subsystem it covers — decides what a green run is
evidence of.

| Tier | Model | Runs through | Suites | A green run proves |
|---|---|---|---|---|
| **none** | no provider at all | stubbed `vscode`, or a real host with no provider | `test:core`, `test:runtime`, EDH `bare-environment`, `tools` | Deterministic logic and extension wiring |
| **scripted** | fixture replaying fixed output | real Electron host, real `vscode.lm` | EDH `participant-turn` | One `@lineage` turn completes through the real runtime and the real `vscode.lm` registration/dispatch path |

Real-model behaviour — how good an answer is, prompt wording, scoring against any target — is
measured internally, not by anything in this repository. Nothing here proves answer quality, and no
suite may be reported as if it did.

### Reporting rule

State the tier, the suite names, and their exit codes. Two statements are prohibited because each has
been made and each was false:

- "the tests pass" without naming which ran
- "the AI tests pass" for anything in this repo — nothing here calls a real model

Unit suites cannot answer EDH questions: activation, command registration, and `vscode.lm` behaviour
do not exist outside a real host. EDH lanes cannot answer model-behaviour questions, for the same
structural reason — the scripted fixture never performs inference.

The deterministic core is SQL parsing and BFS graph traversal — dependency extraction from DDL,
graph construction, and the traversal and analysis built on it. That is what the **none**-tier suites
are built to prove, and what a change should be measured against.

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
check (`tests/tools/assert-honest-test-labels.mjs`), the no-legacy-assertions
scan (`tests/tools/assert-no-legacy-assert.mjs`), the core-case-completeness
check (`tests/tools/assert-core-cases-complete.mjs`), the unit-project coverage
check that makes the two unit steps add up to the whole suite
(`tests/tools/assert-unit-projects-cover-all.mjs`), the core unit project — run
under v8 coverage with per-file floors on `sqlBodyParser.ts`, `graphAnalysis.ts`,
`graphBuilder.ts`, `shared/sqlRegex.ts`, and `shared/nodeIdResolution.ts` — and
the agent-runtime unit project, both bundles plus the integration-test compile,
package-content safety, and the no-LangSmith boundary. The gate reports every
configured step instead of stopping after the first failure. It does not launch
VS Code Electron or contact a model provider.

## Unit tests

`npm test` runs every `tests/unit/**/*.test.ts` file in one Vitest suite. The
two unit projects and the focused Core subsets can also run independently:

```bash
npm run test:core
npm run test:runtime
npm run test:parser
npm run test:bfs
```

`test:core` runs parser and non-AI engine tests (`tests/unit/parser`,
`tests/unit/engine`).
`test:runtime` runs agent-runtime and state-machine tests (`tests/unit/ai-core`,
`tests/unit/sm`) — deterministic logic, stubbed `vscode`, scripted doubles, zero model calls.

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
deterministic `npm run gate`. They are a small, optional smoke tier: proving the
extension activates, its commands and tools register, and one AI turn completes —
nothing about prompt wording or answer quality.

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
externally reachable when it should not be can fail **only** here — and a plain
Vitest run cannot fail on any of them because it never calls `activate()`.

The converse holds too: everything a host adds beyond that is deterministic
wiring, so a host does not need to run a real model to prove it. Model
behaviour is measured internally, headless, never through this fixture — the
fixture is scripted-only and deliberately carries no live-provider mode.

`npm run test:edh` runs every configured label. It automatically builds the
extension host and webview bundles and compiles `tests/integration/**` into
`out/test/` first. Run `npm run pretest:integration` once yourself only when
invoking a label directly. The normal gate also performs this compile without
launching Electron.

```bash
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:participant-turn
npx vscode-test --label kill-switch
```

| Label | Fixture model | Proves | If it goes red |
|---|---|---|---|
| `bare-environment` | none, deliberately | Activation completes and the core command surface registers with no Copilot, no chat model and no `ms-mssql.mssql`. Adding the provider fixture here would void the proof. | The extension may fail to start for a user who has none of the optional integrations. A throw escaping `activate()` unregisters *everything*, so someone who only opens a `.dacpac` loses the graph because of an AI feature they never use. Treat as release-blocking. |
| `tools` | none, deliberately | Every contributed lineage tool is registered with `vscode.lm` and answers through `vscode.lm.invokeTool` — the external entry point Copilot agent mode uses — including the phase-authorization refusal an out-of-phase external call must get. | Either an outside caller (Copilot agent mode, a `#lineage_*` reference) gets broken results, or — worse — a tool that should not be externally reachable now is. Check which assertion failed before shipping. |
| `participant-turn` | scripted | A real `@lineage` turn through the production `handleChatRequest` API: the no-data notice, and a full turn that streams progress and settles with a terminal `ChatResult`. | A chat turn does not complete: it throws, hangs, or never reaches a terminal result. Users see a stuck or empty response. |
| `kill-switch` | none, seeded `--user-data-dir` | With `dataLineageViz.ai.enabled: false` on disk before activation — the branch a real user reaches from the Settings UI — the core product still registers in full while the AI surface genuinely does not: no participant gate command, and an unregistered tool rejects cleanly on invocation rather than hanging. No npm alias: run it as `npx vscode-test --label kill-switch`. | Disabling the AI setting no longer actually removes the AI surface, or breaks the core product it should leave untouched. Treat as release-blocking — this is the only proof a real user's opt-out works. |

The three fixture-less lanes (`bare-environment`, `tools`, `kill-switch`) assert the host's
emptiness before asserting anything else, so a green result cannot be explained by a leaked model.

### One host at a time — the lanes are serial by design

Run the lanes through `npm run test:edh`, or one label at a time. Never run two
labels concurrently, and never edit [`.vscode-test.mjs`](../.vscode-test.mjs) to
make concurrency possible.

Every label shares one Electron profile — `@vscode/test-electron` appends
`--user-data-dir=<cache>/user-data` whenever `launchArgs` does not already carry
one — and they share the single `out/` build the whole run reads from. Two hosts
at once contend for both. This is not a limit worth engineering around: these
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
