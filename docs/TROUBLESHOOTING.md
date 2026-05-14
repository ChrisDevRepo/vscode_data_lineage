# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values rather than trusting any number written here. The **Output → Data Lineage Viz** channel is the first place to look for any unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / Azure Data Studio (file lock). Only SSDT- and SDK-style archives are supported.

**Database connection fails.** Install the [mssql extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql); `@lineage` reuses its profile. The account needs `db_datareader` on the database (plus `GRANT VIEW SERVER STATE` for profiling row counts).

**Cross-database refs missing.** Only **schema-qualified** names resolve. Unqualified names are intentionally dropped.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

## Graph and webview

**Blank or stuck graph.** Open Webview Developer Tools, check the console, then reload the window.

**"Node limit reached".** Schema Overview auto-fires above `dataLineageViz.overview.threshold`. Raise `dataLineageViz.maxNodes` / `dataLineageViz.renderLimit` if needed.

**Theme colours wrong after switching themes.** Reload the window.

## `@lineage` chat participant

**No response.** Install and sign in to [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot). Load a graph before asking.

**"Scope exceeds budget".** Narrow the question, accept the `safe_depth_hint`, or raise `dataLineageViz.ai.maxRounds`.

**"Confirm SM start" gate.** Sliding-Memory mode asks once before burning hops. Triggered by graph render, column trace, deeper hop-by-hop analysis, or `over_discovery_budget`.

**"Unanswered (out of approved scope)".** By design — SM locks the border at confirmation. The **Show deferred questions** button pre-fills them for a new run.

**"Exploration incomplete — N rounds pending".** The hop cap was reached before the agenda drained. Narrow the scope or raise `ai.maxRounds`.

**Tool-call clutter in chat.** Turn off `dataLineageViz.ai.showToolInvocations`.

**Formulas or math artifacts in the AI description panel.** Re-run the `@lineage` query to regenerate the description with the current format.

## Export and profiling

- Draw.io export mirrors the current webview layout.
- Profiling is live-DB only (no dacpac). See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Run **Data Lineage: Copy Debug Info** and paste the output into the issue along with the relevant section from **Output → Data Lineage Viz**. Do not attach customer dacpacs.
