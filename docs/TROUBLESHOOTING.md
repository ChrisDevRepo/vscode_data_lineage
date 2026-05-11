# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values rather than trusting any number written here. The **Output → Data Lineage Viz** channel is the first place to look for any unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / Azure Data Studio (file lock). Only SSDT- and SDK-style archives are supported; SQL Server, Azure SQL, Fabric DW, and Synapse Dedicated SQL Pool targets only.

**Database connection fails.** Install the [mssql extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql); `@lineage` reuses its profile. The account needs `db_datareader` on the database (plus `GRANT VIEW SERVER STATE` for profiling row counts). Local SQL Server: TCP/IP enabled + Mixed Mode auth.

**Cross-database refs missing.** Only **schema-qualified** names resolve. Unqualified `SELECT * FROM SomeTable` is intentionally dropped — there is no safe fallback because the default schema depends on the caller.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md). Loader errors land in the Output channel with the missing column name or invalid regex.

## Graph and webview

**Blank or stuck graph.** **Developer: Open Webview Developer Tools** → check the console. Then **Developer: Reload Window**.

**"Node limit reached".** Schema Overview auto-fires above `dataLineageViz.overview.threshold`. To go higher, raise `dataLineageViz.maxNodes` / `dataLineageViz.renderLimit`. React Flow degrades past a few thousand nodes regardless.

**Theme colours wrong after switching themes.** Reload the window — some webview CSS variables resolve at mount.

## `@lineage` chat participant

**No response.** Install and sign in to [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) — `@lineage` delegates every LLM call through Copilot. Load a graph before asking.

**"Scope exceeds budget".** The exploration would exceed `dataLineageViz.ai.maxRounds`. Narrow the question, accept the `safe_depth_hint`, or raise the setting.

**"Confirm SM start" gate.** Sliding-Memory mode asks once before burning hops. Triggered when you ask for a graph render, a column trace, or when discovery exceeds its scope budget — otherwise the assistant stays in chat (discovery). The chat-vs-SM thresholds live in `dataLineageViz.ai.discoveryNodeCap` and `dataLineageViz.ai.discoveryTokenBudget`. The gate detail now includes an estimated scope DDL token/char footprint to explain budget-triggered escalations.

**"Unanswered (out of approved scope)".** By design — SM locks the border at confirmation. The **Show deferred questions** button pre-fills them for a new run.

**"Exploration incomplete — N rounds pending".** The hop cap was reached before the agenda drained. The partial archive is discarded on purpose — incomplete lineage can invert the picture. Narrow the scope or raise `ai.maxRounds`.

**Tool-call clutter in chat.** Turn off `dataLineageViz.ai.showToolInvocations`.

**Formulas or math artifacts in the AI description panel.** Formulas render as display math in the result panel. In the VS Code chat stream, the same formula source appears as a labeled code block (VS Code chat does not render math natively). If you see raw formula text (`\begin{cases}…`) or dollar-sign artifacts in the result panel, the stored description was generated before the current format was enforced — re-run the `@lineage` query to regenerate it.

## Export and profiling

- Draw.io export mirrors the current webview layout — re-layout before exporting if node positions are messy.
- Profiling is live-DB only (no dacpac). Fabric DW does not support `TABLESAMPLE`; the profiler falls back to `TOP N`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Run **Data Lineage: Copy Debug Info** and paste the output into the issue along with the relevant section from **Output → Data Lineage Viz**. Do not attach customer dacpacs — reproduce with **Data Lineage: Open Demo** wherever possible.

