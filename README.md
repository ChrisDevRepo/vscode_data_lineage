# Data Lineage Viz

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code](https://img.shields.io/badge/vscode-1.95+-blue.svg)
![Status](https://img.shields.io/badge/status-preview-orange.svg)

Visualize SQL dependencies right inside VS Code. Ask `@lineage` in Copilot Chat to explore your graph with natural language — or browse interactively with search, trace, and schema overview.

Import from `.dacpac` files or connect directly to SQL Server, Azure SQL, Fabric Data Warehouse, or Synapse Dedicated SQL Pool.

![Data Lineage Viz — search, trace, and preview DDL](images/viz-search-screenshot.png)

## Get Started

1. Run **Data Lineage: Open Wizard** (`Ctrl+Shift+P`)
2. Pick a `.dacpac` file — or **Connect to Database** via the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql)
3. Select schemas and click **Visualize**

No data? Click **Try with demo data** to explore the AdventureWorks sample.

## AI-Powered Exploration

Use `@lineage` in GitHub Copilot Chat to query your loaded graph. The assistant uses dedicated lineage tools — never general knowledge.

```
@lineage what does HumanResources.Employee depend on?
@lineage trace 3 levels upstream from Sales.SalesOrderDetail
@lineage which objects are hubs with more than 10 connections?
```

Requires [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot). Tools activate automatically when a graph is loaded.

## Features

- **Search & trace** — find objects with autocomplete, trace upstream/downstream dependencies, find shortest paths between nodes
- **Graph analysis** — detect islands, hubs, orphans, circular dependencies, and longest chains
- **Schema overview** — large graphs auto-summarize at schema level; double-click to drill in
- **SQL preview** — click any node to view DDL with syntax highlighting; search across procedure and view bodies
- **Multiple sources** — SSDT and SDK-style `.dacpac`, live database connections, external tables, virtual external refs (OPENROWSET, cross-DB, CETAS)
- **Projects & views** — save connections, schema selections, and named filter states for one-click reopen
- **Export** — generate Draw.io diagrams for documentation

## How It Works

1. **Extract** — reads `model.xml` from a `.dacpac`, or imports metadata via DMV queries
2. **Parse** — combines XML/DMV dependencies with configurable regex patterns
3. **Graph** — builds a directed graph with automatic layout
4. **Render** — interactive visualization with pan, zoom, and filtering

## Configuration

Search `dataLineageViz` in VS Code Settings (`Ctrl+,`).

| Setting | Default | Description |
| --- | --- | --- |
| `maxNodes` | `750` | Objects to load (up to 10,000). AI queries the full model; GUI is separately capped |
| `renderLimit` | `750` | Max nodes the GUI renders before showing a summary |
| `excludePatterns` | `[]` | Regex patterns to exclude objects by name |
| `layout.direction` | `"LR"` | Graph direction: left-to-right or top-to-bottom |

Advanced users can override [parse rules](docs/PARSE_RULES.md), [DMV queries](docs/DMV_QUERIES.md), and review [profiling patterns](docs/PROFILING_PATTERNS.md). Scaffold templates via Command Palette: **Create Parse Rules** / **Create DMV Queries**.

## Limitations

- Object-level only — no column-level lineage
- Static analysis — dynamic SQL (`EXEC(@sql)`) not detected
- Fully-qualified names only — unqualified references are excluded

## FAQ

**Do I need a .dacpac file?**
No — connect directly to a database. If you prefer a `.dacpac`, extract one from Visual Studio, SSMS, Azure Data Studio, or the Fabric portal. See [Microsoft's documentation](https://learn.microsoft.com/sql/relational-databases/data-tier-applications/data-tier-applications).

**Why are some dependencies missing?**
Dynamic SQL cannot be analyzed statically. Only compile-time dependencies are detected.

## Contributing

Bug reports welcome. For custom features, fork and extend under the MIT license. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

MIT License · [Christian Wagner](https://www.linkedin.com/in/christian-wagner-11aa8614b) · [GitHub](https://github.com/ChrisDevRepo/vscode_data_lineage) · Developed with [Claude Code](https://claude.ai/code)
