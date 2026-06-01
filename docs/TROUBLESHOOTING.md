# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values rather than trusting any number written here. The **Output → Data Lineage Viz** channel is the first place to look for any unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / Azure Data Studio (file lock). Only SSDT- and SDK-style archives are supported.

**Database connection fails.** Install the [mssql extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql); `@lineage` reuses its profile. Imports need metadata visibility such as `VIEW DEFINITION` plus permission to run the configured catalog queries. Profiling also needs `SELECT` on profiled tables and catalog visibility for `sys.partitions` row counts.

**Cross-database refs missing.** Fully qualified three- or four-part names can surface as virtual external nodes, but remote database internals are not imported. Unqualified names are ambiguous and may not resolve.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

## Graph and webview

**Blank or stuck graph.** Open Webview Developer Tools, check the console, then reload the window.

**"Node limit reached".** `dataLineageViz.renderLimit` is the hard visual ceiling after load. `dataLineageViz.overview.threshold` only decides whether a new load starts in Schema View or Object View. Raise `dataLineageViz.maxNodes` / `dataLineageViz.renderLimit` if needed.

**Theme colours wrong after switching themes.** Reload the window.

## `@lineage` chat participant

**No response.** Install and sign in to [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot). Load a graph before asking.

**"Scope exceeds budget".** Narrow the question, rerun at the suggested `safe_depth_hint`, or raise `dataLineageViz.ai.maxRounds`.

**"Confirm SM start" gate.** Sliding-Memory mode asks once before burning hops. Triggered by graph render, column trace, deeper hop-by-hop analysis, or `over_discovery_budget` from a discovery bundle.

**"Unanswered (out of approved scope)".** By design — SM locks the border at confirmation. The **Show deferred questions** button pre-fills them for a new run.

**"Exploration incomplete — N rounds pending".** The hop cap was reached before the agenda drained. Narrow the scope or raise `ai.maxRounds`.

**Tool-call clutter in chat.** Turn off `dataLineageViz.ai.showToolInvocations`.

**Formulas or math artifacts in the AI description panel.** Re-run the `@lineage` query to regenerate the description with the current format.

## Export and profiling

- Draw.io export mirrors the current webview layout.
- Profiling is live-DB only (no dacpac). See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Run **Data Lineage: Copy Debug Info** and paste the output into the issue along with the relevant section from **Output → Data Lineage Viz**. Do not attach customer dacpacs.
