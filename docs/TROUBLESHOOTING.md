# Troubleshooting

**Output › Data Lineage Viz** is the first place to look. Defaults change between versions; check **Settings → Data Lineage** for current values.

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

## AI model endpoints

- **A model entry is not offered.** The warning names the entry in `dataLineageViz.ai.models` and what is wrong with it: an `https` URL (or `http` on `127.0.0.1`, `localhost` or `[::1]`), an `apiType` of `chat-completions` or `responses`, and token limits are required. Keys never belong in an entry.
- **"No API key is stored".** Run **Data Lineage: Update AI Model Key** and pick the entry.
- **An endpoint rejects a forced tool call.** Set `forcedToolChoice` to `false` on that entry; the extension then sends `auto`.

## Table statistics

- Statistics need a live database, not a `.dacpac`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).
- On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`.

## Bug reports

Run **Data Lineage: Copy Debug Info** and add the relevant lines from the Output channel. Remove server, schema and object names you do not want to share. Do not attach customer `.dacpac` files. Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues).
