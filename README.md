# Data Lineage Viz

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code](https://img.shields.io/badge/vscode-1.95+-blue.svg)
![Status](https://img.shields.io/badge/status-preview-orange.svg)

> **Preview** — This extension is functional but under active development.

See how tables, views, stored procedures, and functions connect — right inside VS Code. Import from `.dacpac` files or connect directly to SQL Server, Azure SQL, Fabric Data Warehouse, or Synapse Dedicated SQL Pool.

![Data Lineage Viz — search, trace, and preview DDL](images/viz-search-screenshot.png)

## Quick Start

**From a .dacpac file:**
1. Run **Data Lineage: Open Wizard** (`Ctrl+Shift+P`)
2. Click **Create New Project**, select a `.dacpac` file, pick schemas, and click **Visualize**

**From a database:**
1. Install the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql)
2. Run **Data Lineage: Open Wizard**, click **Create New Project**, then **Connect to Database**
3. Pick a connection, select schemas, and click **Visualize**

Saved projects appear on the start screen — click any card to reopen instantly.

No database? Click **Try with demo data** to explore the AdventureWorks sample.

## Features

### GitHub Copilot Integration

Use `@lineage` in GitHub Copilot Chat to ask questions about your loaded lineage graph. The assistant answers using dedicated lineage tools — never from general knowledge.

```
@lineage what schemas are loaded?
@lineage find tables with Employee in the name
@lineage what does HumanResources.Employee depend on?
@lineage trace 3 levels upstream from Sales.SalesOrderDetail
@lineage which objects are hubs with more than 10 connections?
```

Requires [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) and VS Code 1.95+. Tools are only active when a lineage graph is loaded.

### Data Sources

- Import from SSDT and SDK-style `.dacpac` files
- Connect to SQL Server, Azure SQL, Fabric DW, or Synapse databases
- External table support
- Virtual external references: OPENROWSET file paths, cross-database 3-part names, and CETAS targets
- Project sessions: saved connections and schema selections reopen with a single click
- Saved views: bookmark named filter states (schemas, types, search) per project

### Visualization

- **Schema overview** — On large graphs (configurable threshold), shows a schema-level summary with object counts and type icons. Double-click any schema bubble to drill into its objects and connected neighbors. Toggle with the status bar item. Disable via `dataLineageViz.overview.enabled`.
- Search and navigate objects with autocomplete
- Trace upstream and downstream dependencies with sibling filtering
- Find the shortest path between any two nodes
- Schema-based color coding with interactive minimap

### Graph Analysis

- Detect islands, hubs, orphans, and circular dependencies
- Find the longest dependency chains in your project
- Filter by schema, object type, or regex patterns

### SQL Preview & Export

- Click any node to view its DDL with full syntax highlighting
- Search SQL bodies of stored procedures and views
- Export the lineage graph to Draw.io for documentation

## Limitations

- **Object-level only** — no column-level lineage
- **Static analysis** — dynamic SQL (`EXEC(@sql)`) not detected
- **Fully-qualified names only** — only `[schema].[object]` references are detected; unqualified names (aliases, CTEs, built-ins) are excluded

## How It Works

1. **Extract** — Reads `model.xml` from a .dacpac archive, or imports metadata via DMV queries from a database
2. **Parse** — Extracts dependencies from XML metadata + configurable regex patterns
3. **Graph** — Builds a directed graph with dagre layout
4. **Render** — Interactive visualization with React Flow

## Configuration

Search `dataLineageViz` in VS Code Settings (`Ctrl+,`). Settings are grouped into **Import**, **Database Connection**, **Table Statistics**, **Layout**, **Trace**, and **Analysis**. Most settings apply instantly; import settings (`parseRulesFile`, `excludePatterns`) require reloading the data source.

### Key Settings

| Setting | Default | Description |
| --- | --- | --- |
| `maxNodes` | `750` | Maximum nodes to display (10–1000) |
| `excludePatterns` | `[]` | Regex patterns to exclude objects by name |
| `layout.direction` | `"LR"` | Graph flow direction: `LR` left-to-right or `TB` top-to-bottom |
| `tableStatistics.enabled` | `true` | Column statistics and row counts (DB import only) |
| `overview.enabled` | `true` | Enable schema overview mode for large graphs |
| `overview.threshold` | `150` | Node count above which schema overview activates automatically |

### Commands

| Command | Description |
| --- | --- |
| Data Lineage: Open Wizard | Open the visualization panel |
| Data Lineage: Open Demo | Load the AdventureWorks demo |
| Data Lineage: Settings | Open extension settings |
| Data Lineage: Create Parse Rules | Scaffold a custom parse rules YAML in your workspace |
| Data Lineage: Create DMV Queries | Scaffold a custom DMV queries YAML in your workspace |

### Customization

Advanced users can override the built-in SQL parsing rules and database import queries:

| Guide | What you can customize |
| --- | --- |
| [Custom Parse Rules](docs/PARSE_RULES.md) | Regex rules for SP dependency extraction |
| [Custom DMV Queries](docs/DMV_QUERIES.md) | SQL queries for database import |
| [Profiling Patterns](docs/PROFILING_PATTERNS.md) | Table statistics SQL reference |

## FAQ

**Do I need a .dacpac file?**
No — you can also import directly from a database using the MSSQL extension. If you prefer a .dacpac, it can be extracted from Visual Studio, VS Code, SSMS, Azure Data Studio, or the Fabric portal. See [Microsoft's documentation](https://learn.microsoft.com/sql/relational-databases/data-tier-applications/data-tier-applications) for details.

**Why are some dependencies missing?**
Dynamic SQL (`EXEC(@sql)`, `sp_executesql`) cannot be analyzed statically. Only compile-time dependencies are detected.

## Contributing

Bug reports are welcome. This is a personal project — for custom features, fork and extend it under the MIT license. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

MIT License · [Christian Wagner](https://www.linkedin.com/in/christian-wagner-11aa8614b) · [GitHub](https://github.com/ChrisDevRepo/vscode_data_lineage) · Developed with [Claude Code](https://claude.ai/code)
