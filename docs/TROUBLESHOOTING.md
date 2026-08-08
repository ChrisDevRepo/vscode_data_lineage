# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values rather than trusting any number written here. The **Output → Data Lineage Viz** channel is the first place to look for any unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / Azure Data Studio (file lock). Only SSDT- and SDK-style archives are supported.

**Database connection fails.** Install or update the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql) and configure a connection profile. Data Lineage Viz requires an MSSQL release that exposes the connection-sharing API (v1.34 or later). Database import uses that profile; `@lineage` reads only the already-loaded model and never opens a database connection. Imports need metadata visibility such as `VIEW DEFINITION` plus permission to run the configured catalog queries. Profiling also needs `SELECT` on profiled tables and catalog visibility for `sys.partitions` row counts.

**Cross-database refs missing.** Fully qualified three- or four-part names can surface as virtual external nodes, but remote database internals are not imported. Unqualified names are ambiguous and may not resolve.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**"Saved projects could not be read and were skipped".** A stored project failed validation and was left out of the project list. The warning appears once per session; **Output → Data Lineage Viz** names the rejected field paths (names only, never values). Records carrying a credential field are rejected by design — recreate the project instead of editing stored state.

## Graph and webview

**Blank or stuck graph.** Open Webview Developer Tools, check the console, then reload the window.

**"Render limit reached".** `dataLineageViz.renderLimit` is the hard visual ceiling after load — raise it (default 750, maximum 1500). Raising `dataLineageViz.maxNodes` will not help: it already ships at its maximum of 2000. `dataLineageViz.overview.threshold` only dictates whether a new load defaults to Schema View or fully-expanded Object View.

**Theme colours wrong after switching themes.** Reload the window.

## `@lineage` chat participant

**No response.** Load a graph first, then make sure a VS Code Language Model Chat provider is installed, configured, and available to Chat. [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is one supported provider.

**"Scope exceeds budget".** Narrow the requested scope or approve the offered deep analysis. For deliberately larger discovery answers, adjust `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget` within their documented ranges; `ai.maxRounds` does not change the discovery bundle limits. If an approved deep analysis reports an over-budget scope during hops, raise `dataLineageViz.ai.explorationNodeCap` or `dataLineageViz.ai.explorationTokenBudget` instead — those bound the active-exploration scope, not discovery.

**Deep-analysis confirmation.** The assistant asks before starting hop-by-hop
analysis. This path is used by `/trace`, named-column traces, explicit deeper
analysis, and discovery scopes that exceed their configured budget. A graph
request uses the bounded **AI Preview** path and does not open this gate.

**Related paths beyond the approved scope.** By design — deep analysis locks the schema
border at confirmation. After synthesis the chat reports the number of deferred
routes, and a completed result offers **Explore related objects…**. The current
UI does not create a separate button for each deferred route.

**"Exploration incomplete — N rounds pending".** The hop cap was reached before the agenda drained. Narrow the scope or raise `dataLineageViz.ai.maxRounds`, then reload the window.

## Export and profiling

- Draw.io export mirrors the current webview layout.
- Profiling is live-DB only (no dacpac). See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).
- On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`; `APPROX_COUNT_DISTINCT` requires SQL Server 2019 or later.

## Bug reports

Run **Data Lineage: Copy Debug Info** and include the relevant section from
**Output → Data Lineage Viz**. Review and redact project, source, schema, object,
filter, and model identifiers before sharing. Do not attach customer dacpacs.
