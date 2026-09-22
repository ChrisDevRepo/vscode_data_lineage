# Local Testing

Tests run on the developer workstation. GitHub runs repository security checks
only; it does not run this test framework.

## What the public suite proves

| Tier | Model | Runs through | Suites | A green run proves |
|---|---|---|---|---|
| **none** | no provider | stubbed `vscode`, or a real host with no provider | `test:core`, `test:runtime`, EDH `bare-environment`, `tools` | Deterministic logic and extension wiring |
| **scripted** | fixture replaying fixed output | real Electron host, real `vscode.lm` | EDH `participant-turn` | One `@lineage` turn completes through the real runtime and the real `vscode.lm` path |

Nothing in this repository calls a real language model. A green run is not
evidence of answer quality.

Unit suites cannot answer EDH questions: activation, command registration, and
`vscode.lm` behaviour do not exist outside a real host. EDH lanes cannot answer
model-behaviour questions — the scripted fixture never performs inference.

The deterministic core is SQL parsing and BFS graph traversal — dependency
extraction from DDL, graph construction, and the traversal and analysis built
on it.

### Live database import is not a suite

No runner connects to a database. Live-database ingestion — connecting through
`ms-mssql.mssql`, executing the DMV queries, `{{SCHEMAS}}` expansion against a
real catalog, result shapes, platform detection, and loading a custom
`dmvQueriesFile` — is verified by hand against a real server.

What the suite does cover is everything downstream of the wire that needs no
server: `tests/unit/parser/dmvExtractor.test.ts` drives `buildModelFromDmv`,
`validateQueryResult`, `mapServerInfoPlatform`, and `isPhase2Query` over
synthetic result sets.

A custom `dmvQueriesFile` that fails its `version` check falls back to the
built-in queries, so the import still succeeds. Confirm the file was applied
by reading the **Data Lineage Viz** output channel — a green import alone does
not prove it.

## Pre-push gate

```bash
npm run gate
```

Steps live in [`tests/tools/gate.mjs`](../tests/tools/gate.mjs): production and
test type-checking, tool-manifest drift check, output-template schema-version
check, prompt-golden-sync check, honest-test-label check, core-case-completeness check, unit-project
coverage check, layer-direction guard (`src/engine/**` must not import
`src/components/**`), core unit project under v8 coverage floors, agent-runtime
unit project, both bundles plus the integration-test compile, package-content
safety, and the no-LangSmith boundary. The gate reports every configured step
instead of stopping after the first failure. It does not launch VS Code
Electron or contact a model provider.

## Unit tests

`npm test` runs every `tests/unit/**/*.test.ts` and `tests/unit/**/*.test.tsx`
file. Focused subsets:

```bash
npm run test:core
npm run test:runtime
npm run test:parser
npm run test:bfs
```

`test:core` runs parser, non-AI engine, and webview tests
(`tests/unit/parser`, `tests/unit/engine`, `tests/unit/webview`).
`test:runtime` runs agent-runtime and state-machine tests
(`tests/unit/ai-core`, `tests/unit/sm`) — deterministic logic, stubbed
`vscode`, zero model calls.

`test:parser` covers SQL parsing and dependency extraction. `test:bfs` runs
all of `tests/unit/engine` — graph construction, traversal, and analysis plus
schema, search, and model-building coverage. `NavigationEngine` coverage
lives in `test:runtime`.

```bash
node tests/tools/run-vitest.mjs run tests/unit/path/file.test.ts
node tests/tools/run-vitest.mjs run -t "test name"
```

## Extension Development Host lanes

These are the only checks that run inside a real VS Code host. Each launches
the VS Code version declared in [`.vscode-test.mjs`](../.vscode-test.mjs).
None needs credentials or a real provider. They are an optional smoke tier:
the extension activates, its commands and tools register, and one AI turn
completes.

"Scripted" means a local test extension registers a
`vscode.LanguageModelChatProvider` inside the Extension Development Host and
returns fixed text and tool calls. This exercises the real public `vscode.lm`
path without performing inference or making a network request.

`npm run test:edh` runs every configured label. It automatically builds the
extension host and webview bundles and compiles `tests/integration/**` into
`out/test/` first. Run `npm run pretest:integration` once yourself only when
invoking a label directly.

```bash
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:participant-turn
npx vscode-test --label kill-switch
```

| Label | Fixture model | Proves | If it goes red |
|---|---|---|---|
| `bare-environment` | none | Activation completes and the core command surface registers with no Copilot, no chat model and no `ms-mssql.mssql`. | The extension may fail to start for a user who has none of the optional integrations. A throw escaping `activate()` unregisters *everything*. |
| `tools` | none | Every contributed lineage tool is registered with `vscode.lm` and answers through `vscode.lm.invokeTool`, while the mutating tools stay unregistered. | Either an outside caller gets broken results, or a tool that should not be externally reachable now is. |
| `participant-turn` | scripted | A real `@lineage` turn through `handleChatRequest`: the no-data notice, and a full turn that streams progress and settles with a terminal `ChatResult`. | A chat turn throws, hangs, or never reaches a terminal result. |
| `kill-switch` | none, seeded `--user-data-dir` | With `dataLineageViz.ai.enabled: false` on disk before activation, the core product still registers while the AI surface does not. No npm alias: run `npx vscode-test --label kill-switch`. | Disabling the AI setting no longer removes the AI surface, or breaks the core product. |

The three fixture-less lanes assert the host's emptiness before asserting
anything else.

### One host at a time

Run the lanes through `npm run test:edh`, or one label at a time. Never run
two labels concurrently.

Every label except `kill-switch` shares one Electron profile and the single
`out/` build. Two hosts at once contend for both.

Do not add a per-label `--user-data-dir` with a relative path — Electron
resolves it against the downloaded VS Code install and dies with `EPERM`. Do
not rebuild while a host is live: `npm run pretest:integration` overwrites
the `out/` tree the running host has already loaded.

### Host log noise on Windows

Every host boot may print two lines that look like failures and are not.
Neither comes from this extension:

```
[main …] Error: Error mutex already exists
Warning: 'cached-data' is not in the list of known options, but still passed to Electron/Chromium.
```

The mutex line appears when another VS Code of the same build is already
running. The `cached-data` line is Electron reporting `--no-cached-data`,
which `@vscode/test-electron` passes to every host. Judge a lane by its Mocha
summary and exit code.

## Package and evidence safety

The package-content allow/deny contract lives in
[`tests/tools/assert-package-contents.mjs`](../tests/tools/assert-package-contents.mjs).
It verifies publishable runtime artifacts and rejects development-only or
sensitive content.

Runtime diagnostics can contain database identifiers. Keep them local, review
them before sharing, and never commit credentials, customer SQL, proprietary
database archives, raw model conversations, or tool payloads.
