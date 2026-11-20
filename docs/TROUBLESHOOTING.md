# Troubleshooting

**Output → Data Lineage Viz** is the first place to look. Defaults change between versions; check **Settings → Data Lineage** for current values.

## Import and connection

- **`.dacpac` will not load.** The file must be a valid ZIP archive that contains `model.xml`. If the error mentions a file lock, close the program that holds the file.
- **Database connection fails.** Add or fix the connection with **Data Lineage: Add Database Connection**. The error notification offers buttons that fit the cause, for example **Update Password**, **Choose Database**, **Trust Server Certificate** (self-signed certificate), **Retry** (Azure database busy or resuming) or **Copy GRANT Statement** (login cannot read metadata). A failed login can mean a wrong password, a wrong user or a database the login cannot open. Details are in the Output channel. Credentials are never shown. See [`SECURITY.md`](../SECURITY.md#connections).
- **Permissions.** Lineage needs `VIEW DEFINITION` on the database. Table statistics need `SELECT` on the tables. See [`DMV_QUERIES.md`](DMV_QUERIES.md).
- **Project saved with the retired SQL Server (mssql) extension connection.** A warning appears and **Add Database Connection** opens with the saved server and database. The project keeps its schemas.
- **Cross-database references are missing.** Three- and four-part names can appear as external nodes, but the other database is not imported. Unqualified names may not resolve.
- **DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout applies to each query, and an import runs several.
- **Custom YAML is rejected.** Its structure must match the built-in file. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).
- **A notice that saved projects could not be read and were skipped.** A saved project has missing or invalid fields. Recreate it in the wizard.

## Graph

- **Blank or stuck graph.** Reload the window. If it stays blank, run **Developer: Open Webview Developer Tools** and include the console error in a bug report.
- **"Render limit reached".** Narrow the filters, or raise `dataLineageViz.renderLimit` (default 750, maximum 1500). Loaded objects stay searchable. A selection above `dataLineageViz.maxNodes` (default 2,000, maximum 5,000) is refused at import.

## `@lineage` chat participant

- **No response.** Load a graph first. Then check that a VS Code chat model provider, such as [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot), is installed and available to Chat.
- **"Analysis cannot start" or the scope is over budget.** Narrow the scope, or raise `dataLineageViz.ai.maxRounds`, `dataLineageViz.ai.maxTraceColumns`, `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget`. A new value applies from the next request.
- **The response ends when I click Change scope.** This is by design. Type the change into the prefilled chat input, for example `remove DimCalendar`, and send it.
- **Deep analysis stops early.** A provider failure or repeated replies without progress can end a run. The error names the object it stopped at. Ask again, or exclude that object.
- **Long silence during deep analysis.** The model is usually still generating; the hop counter advances as hops finish. Use the chat **Stop** button for a hung request.

## Table statistics

- Statistics need a live database, not a `.dacpac`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).
- On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`.

## Bug reports

Run **Data Lineage: Copy Debug Info** and add the relevant lines from the Output channel. Remove server, schema and object names you do not want to share. Do not attach customer `.dacpac` files. Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues).
