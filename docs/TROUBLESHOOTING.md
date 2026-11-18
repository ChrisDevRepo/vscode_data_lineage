# Troubleshooting

Start with **View → Output → Data Lineage Viz**; set its log level to **Debug** for detail. Defaults change between versions, so check **Settings → Data Lineage** for current values.

## Import and connection

**`.dacpac` won't load.** The file must be a valid `.dacpac` (a ZIP archive with `model.xml` holding a `DataSchemaModel/Model` element) and not locked by another program.

**Database connection fails.** The error names the connection and the driver message, with credential-shaped text removed, and the notification buttons fit the error. Add connections with **Data Lineage: Add Database Connection**; no other extension is needed. The extension does not change firewall rules.

| Error | Typical cause | Buttons |
|---|---|---|
| 18456 `Login failed for user` | Wrong password or user, a database the login cannot open (SQL Server reports both the same way), or an Entra account without access | Update Password · Choose Database · Edit Connection (Entra: Sign in with another account) |
| 4060 / 916 `Cannot open database` | Database missing, or the login has no user in it | Choose Database · Edit Connection |
| 40613 / 40197 / 40501 / 40532 | Azure database unavailable, busy or resuming | Retry |
| `ETIMEOUT`, `ESOCKET`, `ENOTFOUND`, `ECONNREFUSED` | Wrong server or port, server stopped, network blocked | Edit Connection · Retry |
| Certificate not trusted | Self-signed server certificate | Trust Server Certificate (asks first) · Edit Connection |
| Sign-in cancelled | Microsoft sign-in window closed | Sign In · Sign in with another account |
| 229 / 297 / 300 | Login cannot read metadata | Copy GRANT Statement |
| anything else | | Show Log · Edit Connection |

The connection retries transient errors (4060, 10928, 10929, 40197, 40501, 40613) up to three times with five-second waits, so a mistyped database name can add 15 seconds before the error shows. A `tcp:` server prefix is accepted. **Update Database Password** applies to SQL logins; **Remove Database Connection** deletes the stored password with the connection.

A project saved with the retired SQL Server (mssql) extension shows one notice when it opens; **Reconnect** opens **Add Database Connection** prefilled with its server and database, and the project keeps its schemas.

**Permissions.** `VIEW DEFINITION` on the database for lineage; `SELECT` on the tables for table statistics. See [`DMV_QUERIES.md`](DMV_QUERIES.md). `@lineage` reads only the loaded model and never opens a connection.

**Import times out.** Raise `dataLineageViz.dmvQueryTimeout` or select fewer schemas. The limit is per query; a Phase 2 import sends several.

**Custom YAML rejected.** Compare your file with the built-in one; see [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**Dependencies missing.** Dynamic SQL, triggers and the other unsupported constructs in [Limitations](../README.md#limitations) are not added by changing graph filters. Fully qualified three- or four-part names can appear as virtual external nodes, but remote internals are not imported; unqualified names may stay unresolved.

**"saved projects could not be read and were skipped".** A saved project has missing or invalid fields. The Output log lists the rejected field paths without their values. Recreate the project in the wizard.

## Graph

**Blank or stuck graph.** Reload the window. For details, run **Developer: Open Webview Developer Tools** and check the console.

**"Render limit reached".** Narrow the filters or raise `dataLineageViz.renderLimit` (default 750, maximum 1500). Loaded objects stay searchable and available to `@lineage`. `dataLineageViz.maxNodes` limits import separately (default 2,000, maximum 5,000): a larger selection is refused.

**Docking.** The graph is a normal editor tab: drag it to any editor group, split it, or choose **Move Editor into New Window**. Inside the graph, the dock menu in the AI report header moves that panel left, bottom or right.

## `@lineage`

**No response.** Load a graph and make sure a chat model provider such as [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is available in VS Code Chat, and that `dataLineageViz.ai.enabled` is on.

**"Analysis cannot start", or the request is redirected for exceeding its budget.** The scope is too large. Narrow it, or raise `dataLineageViz.ai.maxRounds` (one round per procedure, view or function), `dataLineageViz.ai.maxTraceColumns` (a column trace with more starting columns is refused the same way), or for discovery answers `dataLineageViz.ai.discoveryNodeCap` and `dataLineageViz.ai.discoveryTokenBudget`. AI settings apply from the next request.

**Change scope ends the response.** By design: VS Code locks chat input while a request runs, so the turn finishes and the input is prefilled with `@lineage`. Type the change, for example `remove DimCalendar`; the proposal comes back revised. **Cancel** or a slash command abandons it.

**Deep analysis stops early.** Provider failures or repeated replies without progress can stop a run. The error names the object it stopped at, and an incomplete run publishes no result or graph preview. Ask again or narrow the scope. A long pause usually means the provider is still generating; the hop counter advances as hops complete, and the chat **Stop** button cancels.

**Repeated result or preview retries.** Invalid tool calls are rejected so the model can correct them. If it keeps failing, press **Stop** and report the rejection codes and issue paths from the Debug log. A model that passes the structural checks can still misread SQL.

**Related objects are outside the approved scope.** By design: approval fixes the schema and depth boundary shown in the plan. A completed result offers **Next questions and related objects** for deferred leads.

## Table statistics

Statistics need a live database project and are unavailable for DACPAC sources. On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`; `APPROX_COUNT_DISTINCT` needs SQL Server 2019 or later. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues) with the output of **Data Lineage: Copy Debug Info** and the relevant Output log. Review and redact project, schema and object names first, and never attach customer `.dacpac` files. Security problems: [`SECURITY.md`](../SECURITY.md).
