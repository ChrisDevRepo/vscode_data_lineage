# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values rather than trusting any number written here. The **Output → Data Lineage Viz** channel is the first place to look for any unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / Azure Data Studio (file lock). Only SSDT- and SDK-style archives are supported.

**Database connection fails.** Install or update the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql) and configure a connection profile. Data Lineage Viz requires an MSSQL release that exposes the connection-sharing API (v1.34 or later). Database import uses that profile; `@lineage` reads only the already-loaded model and never opens a database connection. Imports need metadata visibility such as `VIEW DEFINITION` plus permission to run the configured catalog queries. Profiling also needs `SELECT` on profiled tables and catalog visibility for `sys.partitions` row counts.

**Cross-database refs missing.** Fully qualified three- or four-part names can surface as virtual external nodes, but remote database internals are not imported. Unqualified names are ambiguous and may not resolve.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**"saved projects could not be read and were skipped".** A stored project was missing a field the schema requires, or carried one of the wrong type, and was left out of the project list. A field this build merely does not recognise is dropped instead and never costs you the project. The warning appears once per session; **Output → Data Lineage Viz** names the rejected field paths (names only, never values). A credential cannot be written to the store in the first place, and is dropped rather than replayed if an older record carries one — recreate the project instead of editing stored state.

## Graph and webview

**Blank or stuck graph.** Open Webview Developer Tools, check the console, then reload the window.

**"Render limit reached".** `dataLineageViz.renderLimit` is the hard visual ceiling after load — raise it (default 750, maximum 1500). Raising `dataLineageViz.maxNodes` will not help: it already ships at its maximum of 2000. `dataLineageViz.overview.threshold` only dictates whether a new load defaults to Schema View or fully-expanded Object View.

**Theme colours wrong after switching themes.** Reload the window.

## `@lineage` chat participant

**No response.** Load a graph first, then make sure a VS Code Language Model Chat provider is installed, configured, and available to Chat. [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is one supported provider.

**The request is redirected because the scope exceeds its budget.** Narrow the requested scope or approve the offered deep analysis. For deliberately larger discovery answers, adjust `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget` within their documented ranges; `ai.maxRounds` does not change the discovery bundle limits. If an approved deep analysis reports an over-budget scope during hops, raise `dataLineageViz.ai.explorationNodeCap` or `dataLineageViz.ai.explorationTokenBudget` instead — those bound the active-exploration scope, not discovery.

**Deep-analysis confirmation.** The assistant asks before starting hop-by-hop
analysis. This path is used by `/trace`, named-column traces, explicit deeper
analysis, and discovery scopes that exceed their configured budget. A graph
request uses the bounded **AI Preview** path and does not open this gate.

**The response ends when I click Change scope.** By design. VS Code keeps the chat
input locked while a request is still running, so the turn finishes and the input is
prefilled with `@lineage`. Type the change — for example `remove DimCalendar` — and send
it; the proposal stays pending and comes back revised. **Cancel** or a slash command
abandons it instead.

**Related paths beyond the approved scope.** By design — deep analysis locks the schema
border at confirmation. After synthesis the chat reports the number of deferred
routes, and a completed result offers **Explore related objects…**. The current
UI does not create a separate button for each deferred route.

**Deep analysis stops before the whole scope is covered.** No error is shown: on reaching the hop cap the engine stops exploring and synthesizes what it already has, so the answer is a partial result rather than a failure. Narrow the scope or raise `dataLineageViz.ai.maxRounds`, then reload the window — the runtime reads that setting once at activation.

**Model choice.** Per-hop latency and protocol compliance differ by model. Models running
directly on Microsoft infrastructure — Copilot-native Anthropic Claude Sonnet and OpenAI GPT, or
an Azure AI Foundry deployment — gave the best results in testing. Of several models tested via
"Manage Models", most had latency and reliability issues; a few (e.g. MiniMax) produced acceptable
results but were still slower. A long silence during deep analysis usually means the provider is
still generating — the hop counter advances as hops complete — up to the zero-output limit below.

**"The language model produced no output within 600s; the request was aborted (first-output
timeout)."** The provider accepted the request and then streamed nothing at all for ten minutes, so
the turn was cancelled rather than left hanging. The limit covers only the silence before the first
output of any kind: once a model has emitted anything — text or a tool call — the rest of that
generation is never interrupted, however long it takes. A model that hits this repeatedly is not
usable for deep analysis; pick one from the Model choice guidance above and re-ask.

## Export and profiling

- Draw.io export mirrors the current webview layout.
- Profiling is live-DB only (no dacpac). See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).
- On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`; `APPROX_COUNT_DISTINCT` requires SQL Server 2019 or later.

## Development environment

**`Could not resolve "langsmith"` at bundle time.** The npm `overrides` entry that
contains the LangSmith dependency (see [`ARCHITECTURE.md`](ARCHITECTURE.md)) can
leave `node_modules/langsmith` as a dangling symlink on some npm 10.x releases.
The `postinstall` hook (`scripts/repair-langsmith-stub.mjs`) repairs this
automatically; if it was skipped — `node_modules` copied between machines,
`--ignore-scripts` in effect — run `node scripts/repair-langsmith-stub.mjs`
manually, or reinstall with `npm ci`.

**`WARNING: a non-stub "langsmith" resolves from …` from that hook.** A real
LangSmith package — not the inert stub — is resolving from somewhere in
`node_modules` that the root stub cannot shadow (a tree copied between machines,
an `overrides` entry temporarily reverted). The hook reports it instead of
claiming success, because writing the root stub would not change what resolves.
Delete `node_modules`, reinstall with `npm ci`, and confirm the `overrides`
entry for `langsmith` in [`package.json`](../package.json) is intact. The
`assert-no-langsmith` gate step is the fail-closed check that must stay green.

**Bundle fails after pulling changes with a missing or wrong package version.**
The `node_modules` tree predates the lockfile. Delete `node_modules` and run
`npm ci`; a carried-over tree from another machine or OS (e.g. a Windows
checkout moved to macOS) resolves stale package versions and cannot be
incrementally repaired.

**`vsce package` / `vsce publish` fails with `code ELSPROBLEMS`
(`invalid: langsmith@…`).** npm `ls` misreports dependencies replaced by npm
`overrides` as invalid — a false positive on this repo's intentional LangSmith
containment stub, independent of the installed versions. Run
`npm run package`, or pass `--no-dependencies` to a direct `vsce` invocation;
all production dependencies are bundled into `out/` and `dist/` before
packaging, so dependency resolution at package time is unnecessary.

**Tests hang or crash on large graphs (`Maximum call stack size exceeded`).**
The vitest workers need the enlarged stack configured in [`vitest.config.ts`](../vitest.config.ts)
(`test.execArgv: ['--stack-size=8000']`) — layout tests with ≥1500 nodes
overflow Node's default worker stack. If the config is edited, keep that entry
top-level: Vitest 4 ignores `poolOptions.*.execArgv`.

## Bug reports

Run **Data Lineage: Copy Debug Info** and include the relevant section from
**Output → Data Lineage Viz**. For AI issues, **Data Lineage: Dump AI State Machine**
writes the current exploration state to a JSON file under the workspace's `tmp/sm-dumps/`
and opens it (an open workspace folder and an active hop-by-hop exploration are required;
a bounded graph preview has no state machine to dump — use its AI NDJSON trace instead).
Review and redact project, source, schema, object, filter, and model identifiers before
sharing, and apply the same review to the dump. Do not attach customer dacpacs.
