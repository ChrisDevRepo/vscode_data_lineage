# Troubleshooting

Fixes for common problems. Start with **View → Output → Data Lineage Viz**; set the log level to **Debug** for detail.

## Import and connection

**`.dacpac` won't load.** The file must be a valid `.dacpac` (a ZIP archive with `model.xml`) and not locked by another program.

**Database connection fails.** The notification shows the driver message and offers fixes such as **Update Password**, **Choose Database** or **Edit Connection**. The login needs `VIEW DEFINITION`; table statistics also need `SELECT` on the table. See [`DMV_QUERIES.md`](DMV_QUERIES.md).

**Import times out.** Raise `dataLineageViz.dmvQueryTimeout` or select fewer schemas.

**Custom YAML rejected.** Compare your file with the built-in one; see [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**Dependencies missing.** See [Limitations](../README.md#limitations).

**"… saved projects could not be read."** The Output log lists the invalid fields. Recreate the project in the wizard.

## Graph

**Blank or stuck graph.** Reload the window. For details, run **Developer: Open Webview Developer Tools** and check the console.

**"Render limit reached".** Narrow the filters or raise `dataLineageViz.renderLimit`. Loaded objects stay searchable and available to `@lineage`.

## `@lineage`

**No response.** Load a graph and make sure a chat model provider such as [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is available in VS Code Chat, and that `dataLineageViz.ai.enabled` is on.

**"Analysis cannot start".** The scope is too large. Narrow it, or raise `dataLineageViz.ai.maxRounds` or `dataLineageViz.ai.maxTraceColumns`.

**Change scope ends the response.** VS Code locks chat input while a request runs. Type the change in the prefilled `@lineage` input, for example `remove DimCalendar`; the plan comes back revised.

**Deep analysis stops early.** The error names the object it stopped at. Ask again or exclude that object.

## Table statistics

On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Bug reports

Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues) with the output of **Data Lineage: Copy Debug Info** and the relevant Output log. Redact object names and never attach customer `.dacpac` files. Report vulnerabilities as described in [`SECURITY.md`](../SECURITY.md).
