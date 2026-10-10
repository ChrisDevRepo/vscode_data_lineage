# Troubleshooting

Defaults change between versions — check **Settings → Data Lineage**. **Output → Data Lineage Viz** is the first place to look.

## Import and connection

**`.dacpac` won't load.** The file must be a ZIP archive containing `model.xml` with a `DataSchemaModel/Model` element. A file-lock error means another program holds the file.

**Database connection fails.** The notification names the connection and driver message (credential-shaped text removed) and offers buttons that fit the error: Retry, Edit Connection, Choose Database, Update Password, Trust Server Certificate, Sign in with another account, Copy GRANT Statement or Show Log. The built-in connection retries the transient codes 4060, 10928, 10929, 40197, 40501 and 40613 up to three times with five-second waits, so a mistyped database name (4060) adds 15 seconds before the error appears. Firewall errors are shown as the server reports them; Data Lineage does not change firewall rules.

Required permissions: `VIEW DEFINITION` on the database for lineage; `SELECT` on the tables to profile for table statistics. See [`DMV_QUERIES.md`](DMV_QUERIES.md). `@lineage` reads only the loaded model and never opens a connection.

**SQL Server (mssql) provider unavailable.** Install or enable the SQL Server extension, or select **Use built-in provider** in the new-project screen. `dataLineageViz.database.connectionProvider` selects the provider; saved built-in connections are managed with **Data Lineage: Add Database Connection**.

**Cross-database refs missing.** Three- and four-part names can appear as virtual external nodes; remote database internals are not imported. Unqualified names may not resolve.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout` (per query; Phase 2 runs several).

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**"saved projects could not be read and were skipped".** A saved project has missing or invalid fields; **Output → Data Lineage Viz** lists the rejected field paths without values. Recreate the project through the wizard.

## Graph

**Blank or stuck graph.** Check the Webview Developer Tools console, then reload the window.

**"Render limit reached".** Narrow the filters or raise `dataLineageViz.renderLimit` (default 750, maximum 1500). Loaded objects stay searchable and available to `@lineage`. `dataLineageViz.maxNodes` limits import separately (default 2,000, maximum 5,000); a larger selection is refused.

## `@lineage` chat participant

**No response.** Load a graph and make sure a VS Code Language Model Chat provider (for example [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)) is installed and available to Chat.

**Redirected, or "Analysis cannot start".** The scope exceeds a budget. Narrow it or approve the offered deep analysis. Limits: `dataLineageViz.ai.discoveryNodeCap`, `ai.discoveryTokenBudget` (also capped at one eighth of the model's input window), `ai.maxRounds` (one round per procedure, view or function) and `ai.maxTraceColumns` (default 10). Changes apply from the next request.

**Deep analysis stops early.** Provider failures or repeated replies without progress end the run with an error naming the object it stopped at; no result is shown. Ask again or exclude that object.

**Repeated graph-preview or result retries.** Malformed tool calls are rejected so the model can repair them. If retries persist, stop the turn and report the rejection codes and issue paths from **Output → Data Lineage Viz** at debug level.

**Long silence during deep analysis.** Usually the provider is still generating; the hop counter advances as hops complete. Use chat **Stop** for a hung generation.

## Profiling

On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`; `APPROX_COUNT_DISTINCT` requires SQL Server 2019 or later. Profiling is live-DB only; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Run **Data Lineage: Copy Debug Info** and include the relevant **Output → Data Lineage Viz** section. Redact project, schema, object and filter identifiers. Do not attach customer dacpacs.
