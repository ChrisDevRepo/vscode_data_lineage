# Data Lineage Viz

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-1.95+-blue.svg)](https://marketplace.visualstudio.com/items?itemName=datahelper-chwagner.data-lineage-viz)

SQL dependency visualization for VS Code. Explore data models via `@lineage` in Copilot Chat or interactively via the built-in graph engine. Supports `.dacpac` files and live connections to SQL Server, Azure SQL, Fabric DW, and Synapse.

![Data Lineage Viz — search, trace, and preview DDL](images/viz-search-screenshot.png)

## Getting Started

1. `Ctrl+Shift+P` → **Data Lineage: Open Wizard**.
2. Select a `.dacpac` or **Connect to Database** via the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql).
3. Select schemas and **Visualize**.

*Click **Try with demo data** to explore the AdventureWorks sample.*

## AI Lineage (`@lineage`)

Natural language lineage exploration in GitHub Copilot Chat.

```text
@lineage trace from Sales.SalesOrderDetail upstream to the source tables
@lineage how is sales calculated — show me the lineage in the app
@lineage which objects are hubs with the most connections?
```

- **Execution**: Automated selection between **Inline** (small scope) and **Map & Router** (deep traversal) modes.
- **Artifacts**: AI-curated graph views with technical and business annotations.

*Requires [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot).*

## Features

- **Interactive Trace**: Upstream and downstream dependency exploration.
- **Graph Analysis**: Hub, orphan, island, and circular dependency detection.
- **Schema Overview**: Automatic schema-level grouping for large models (150+ nodes).
- **SQL Preview**: Syntax-highlighted DDL with cross-object search.
- **Table Profiling**: Column statistics (nulls, distinct, min/max) for live databases.
- **Export**: Draw.io diagram generation.

## Troubleshooting

- **Dacpac fails**: Ensure file is unlocked by other applications.
- **Connection fails**: Verify `VIEW DEFINITION` and `VIEW SERVER STATE` permissions.
- **Missing edges**: Dynamic SQL (`EXEC(@sql)`) is not supported.
- **Blank graph**: Use *Developer: Reload Window* or check *Output → Data Lineage Viz*.

## Documentation Reference

- [**Architecture**](docs/ARCHITECTURE.md) — Map & Router engine, bipartite analysis, and memory tiering.
- [**Developer Guide**](docs/DEVELOPER_GUIDE.md) — Ingestion pipelines, IPC bridge, and prompt architecture.
- [**Interface Specs**](docs/README.md) — Detailed contracts for Parse Rules, DMV Queries, and Profiling.
- [**Contributing**](CONTRIBUTING.md) — Engineering standards and testing protocol.

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
