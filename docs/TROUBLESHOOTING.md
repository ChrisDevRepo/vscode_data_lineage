# Troubleshooting

Fixes for common problems. Start with **View → Output → Data Lineage Viz**; set the log level to **Debug** for detail.

## Import and connection

**`.dacpac` won't load.** The file must be a valid `.dacpac` (a ZIP archive with `model.xml`) and not locked by another program.

**Database connection fails.** The notification shows the driver message and offers fixes such as **Update Password**, **Choose Database** or **Edit Connection**. The login needs `VIEW DEFINITION`; table statistics also need `SELECT` on the table. See [`DMV_QUERIES.md`](DMV_QUERIES.md).

**Import times out.** Raise `dataLineageViz.dmvQueryTimeout` or select fewer schemas. This limit is per query; a Phase 2 import sends several queries.

**Firewall or sign-in failure.** The extension does not change firewall rules. Use **Edit Connection** for the server, database or authentication settings; **Update Database Password** applies to SQL logins, not Entra ID sign-in.

**Custom YAML rejected.** Compare your file with the built-in one; see [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**Dependencies missing.** Dynamic SQL, triggers and the other unsupported constructs in [Limitations](../README.md#limitations) are not added to the deterministic object graph by changing graph filters. Cross-database references can appear as virtual nodes, but remote internals are not imported; unqualified names may stay unresolved.

**"… saved projects could not be read."** The Output log lists the invalid fields. Recreate the project in the wizard.

## Graph

**Blank or stuck graph.** Reload the window. For details, run **Developer: Open Webview Developer Tools** and check the console.

**"Render limit reached".** Narrow the filters or raise `dataLineageViz.renderLimit`. Loaded objects stay searchable and available to `@lineage`.

## `@lineage`

**No response.** Load a graph and make sure a chat model provider such as [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is available in VS Code Chat, and that `dataLineageViz.ai.enabled` is on.

**"Analysis cannot start".** The scope is too large. Narrow it, or raise `dataLineageViz.ai.maxRounds` or `dataLineageViz.ai.maxTraceColumns`.

**Change scope ends the response.** VS Code locks chat input while a request runs. Type the change in the prefilled `@lineage` input, for example `remove DimCalendar`; the plan comes back revised.

**Deep analysis stops early.** Provider failures or repeated replies without progress can stop a run. The error names the object it stopped at; an incomplete run publishes no completed result or graph preview. Ask again or narrow the scope.

**Repeated result or preview retries.** Invalid tool calls are rejected so the model can correct them. If it repeatedly fails to correct them, use **Stop** and report the rejection codes and issue paths from the Debug log. A model that passes structural checks can still misinterpret SQL.

**Related objects are outside the approved scope.** Approval keeps the schema and depth boundaries shown in the plan. A completed result can offer **Next questions and related objects** for deferred work; a finding does not automatically widen the scope.

**Long pauses.** The selected provider may still be generating. The hop count advances when work completes; use the chat **Stop** button to cancel.

## Table statistics

Profiling requires a live database project and is unavailable for DACPAC sources. On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues) with the output of **Data Lineage: Copy Debug Info** and the relevant Output log. Redact object names and never attach customer `.dacpac` files.
