# Data Lineage Viz

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code](https://img.shields.io/badge/vscode-1.95+-blue.svg)
![Status](https://img.shields.io/badge/status-preview-orange.svg)

Visualize SQL dependencies right inside VS Code. Ask `@lineage` in Copilot Chat to explore your lineage graph with natural language — or browse interactively with search, trace, and schema overview.

Import from `.dacpac` files or connect directly to SQL Server, Azure SQL, Fabric Data Warehouse, or Synapse Dedicated SQL Pool.

![Data Lineage Viz — search, trace, and preview DDL](images/viz-search-screenshot.png)

## Get Started

1. Run **Data Lineage: Open Wizard** (`Ctrl+Shift+P`)
2. Pick a `.dacpac` file — or **Connect to Database** via the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql)
3. Select schemas and click **Visualize**

No data? Click **Try with demo data** to explore the AdventureWorks sample.

## AI-Powered Lineage

Use `@lineage` in GitHub Copilot Chat to explore your database dependencies. The assistant traces lineage from your actual data model.

```
@lineage trace from Sales.SalesOrderDetail upstream to the source tables
@lineage how is sales calculated — show me the lineage up to source in the app
@lineage which objects are hubs with the most connections?
```

Trace object dependencies and create bookmarked graph views. The AI assistant can go further — analyzing column mappings and SQL logic from the available metadata.

![AI lineage analysis — annotated graph with column mappings and join paths](images/viz-ai-screenshot.png)

`@lineage` adapts to the size of the question:

- **Small scopes run inline.** The AI sees all relevant DDL at once and answers directly. If a relevant dependency falls outside your filter schemas, it pauses and asks you to approve extending the scope for this session.
- **Large scopes run hop-by-hop.** Before the first hop the assistant shows you the planned scope (nodes, schemas, depth, budget) and asks for confirmation. Once approved, the contract is locked.

Requires [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot). Tools activate automatically when a graph is loaded.

## Features

- **@lineage AI** — ask Copilot Chat to trace lineage, analyze column mappings, explain SQL logic, and create bookmarked graph views from your data model
- **Search & trace** — find objects with autocomplete, trace upstream/downstream dependencies, find shortest paths between nodes
- **Graph analysis** — detect islands, hubs, orphans, circular dependencies, and longest chains
- **Schema overview** — large graphs auto-summarize at schema level; double-click to drill in
- **SQL preview** — click any node to view DDL with syntax highlighting; search across procedure and view bodies
- **Multiple sources** — SSDT and SDK-style `.dacpac`, live database connections, external tables, virtual external refs (OPENROWSET, cross-DB, CETAS)
- **Projects & views** — save connections, schema selections, and named filter states for one-click reopen
- **Export** — generate Draw.io diagrams for documentation

For configuration, settings reference, and advanced customization (parse rules, DMV queries), see the [full documentation](docs/FEATURES.md).

## Limitations

**Scope — intra-database DDL only.** The following are out of scope:

- **External ingestion pipelines** — ADF, SSIS, Spark, Fabric Dataflow, or any ETL/ELT process that writes *into* the database from an external source is not visible. The extension sees the target tables as leaf nodes, not the pipelines that populate them.
- **Cross-database or cross-server data flow** — dependencies that cross a database or server boundary are surfaced only when the SQL body contains a fully-qualified four-part or three-part name; the remote side is shown as an external reference node, not as a fully traced sub-graph.
- **Runtime data manipulation** — DML executed outside stored procedures (e.g. application-layer INSERTs, bulk loads, CDC consumers) leaves no DDL footprint and is therefore not detected.
- **Dynamic SQL** — statements constructed at runtime (`EXEC(@sql)`, `sp_executesql`) cannot be analyzed statically and are excluded.
- **Unqualified references** — object references without a schema prefix are excluded.

If your lineage question spans ingestion pipelines or cross-system data flow, this tool covers only the intra-database leg of that journey.

## FAQ

**Do I need a .dacpac file?**
No — connect directly to a database. If you prefer a `.dacpac`, extract one from Visual Studio, SSMS, Azure Data Studio, or the Fabric portal. See [Microsoft's documentation](https://learn.microsoft.com/sql/relational-databases/data-tier-applications/data-tier-applications).

**Why are some dependencies missing?**
Dynamic SQL cannot be analyzed statically. Only compile-time dependencies are detected.

## Contributing

Bug reports welcome. For custom features, fork and extend under the MIT license. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

MIT License · [Christian Wagner](https://www.linkedin.com/in/christian-wagner-11aa8614b) · [GitHub](https://github.com/ChrisDevRepo/vscode_data_lineage) · Developed with [Claude Code](https://claude.ai/code)
