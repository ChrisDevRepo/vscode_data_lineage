# Troubleshooting

This document identifies common error states and their technical mitigations.

## 1. Import & Connection
- **`.dacpac` Load Failure**: Ensure the file is not locked by SSDT, Azure Data Studio, or SSMS. Only SSDT- and SDK-style archives are supported.
- **Database Connection Failure**: Verify the [mssql extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql) is installed. The connecting account requires `VIEW DEFINITION` and `VIEW SERVER STATE` permissions on the target database.
- **Missing Cross-Database Refs**: Only schema-qualified names (e.g. `[DB].[Schema].[Object]`) are detected. Unqualified references are intentionally excluded to prevent false positive "external" nodes.
- **DMV Timeout**: Raise the `dataLineageViz.dmvQueryTimeout` setting if catalog ingestion fails on large databases.

## 2. Graph & Visualization
- **Blank or Frozen Graph**: Use the **Developer: Reload Window** command. Check the **Output** channel (select **Data Lineage Viz**) for error logs.
- **Node Limit Reached**: Large graphs auto-activate **Schema Overview Mode**. You can adjust the `renderLimit` and `maxNodes` settings in VS Code to increase capacity (React Flow performance may degrade above 2,000 nodes).
- **Incorrect Theme Colors**: Reload the window after a theme switch to ensure all CSS variables are correctly resolved at mount.

## 3. AI Assistant (`@lineage`)
- **No Response**: Ensure you are signed into GitHub Copilot. A lineage graph must be loaded before asking `@lineage` questions.
- **"Scope Exceeds Budget"**: The requested exploration is too large for the current `ai.maxRounds` setting (default 50). Narrow your question or increase the limit.
- **"Unanswered (out of scope)"**: The engine locks the approved schema/depth border at the start of a session. Deferred questions can be explored in a follow-up turn using the *Show deferred questions* button.
- **Incomplete Exploration**: If the round cap is hit before the agenda is drained, partial results are discarded to prevent misleading lineage reports.

## 4. Table Profiling
- **Profiling Unavailable**: Profiling is supported for live database connections only (not `.dacpac`).
- **External Table Errors**: Profiling for external tables is disabled by default (`excludeExternalTables: true`) as they query remote data sources (e.g. S3, Blob).
- **Sampling Logic**: On Fabric DW, the profiler falls back to `TOP N` as `TABLESAMPLE` is unsupported.

## 5. Bug Reports
Run the **Data Lineage: Copy Debug Info** command and include the output in your issue report along with relevant logs from the **Output → Data Lineage Viz** channel.
