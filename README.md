# Data Lineage Viz

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code](https://img.shields.io/badge/vscode-1.85+-blue.svg)
![Status](https://img.shields.io/badge/status-preview-orange.svg)

> **Preview** — This extension is functional but under active development. Expect rough edges.

Visualize object-level dependencies in SQL Server Database Projects (.dacpac). See how tables, views, stored procedures, and functions connect through an interactive graph.

![Data Lineage Viz — search, trace, and preview DDL](images/viz-search-screenshot.png)

## Quick Start

1. Open a workspace with a `.dacpac` file
2. Run **Data Lineage: Open** (`Ctrl+Shift+P`)
3. Select schemas and click **Visualize**

No `.dacpac` file? Click **Load Demo** in the wizard to explore the AdventureWorks sample database.

## Features

**Visualization**
- Search and navigate objects with autocomplete
- Trace upstream and downstream dependencies
- Find the shortest path between any two nodes
- Schema-based color coding with interactive minimap

**Graph Analysis**
- Detect islands, hubs, orphans, and circular dependencies
- Find the longest dependency chains in your project
- Filter by schema, object type, or regex patterns

**SQL Preview & Export**
- Click any node to view its DDL with full syntax highlighting
- Full-text search across all SQL bodies with match highlighting
- Export the lineage graph to Draw.io for documentation

## Limitations

- **Object-level only** — no column-level lineage
- **Static analysis** — dynamic SQL (`EXEC(@sql)`) not detected

## How It Works

1. **Extract** — Reads `model.xml` from the .dacpac archive
2. **Parse** — Extracts `BodyDependencies` + configurable regex patterns
3. **Graph** — Builds a directed graph with dagre layout
4. **Render** — Interactive visualization with React Flow

## Configuration

Search `dataLineageViz` in Settings (`Ctrl+,`):

**General**

| Setting | Default | Description |
|---------|---------|-------------|
| `maxNodes` | `500` | Maximum nodes to display (10-1000) |
| `logLevel` | `"info"` | Log verbosity: `info` or `debug` |

**Parser**

| Setting | Default | Description |
|---------|---------|-------------|
| `parseRulesFile` | `""` | Path to custom YAML parsing rules |
| `excludePatterns` | `[]` | Regex patterns to exclude objects |

**Graph Layout**

| Setting | Default | Description |
|---------|---------|-------------|
| `layout.direction` | `"LR"` | Layout direction: `LR` or `TB` |
| `layout.rankSeparation` | `120` | Spacing between ranks/layers (20-300) |
| `layout.nodeSeparation` | `30` | Spacing between nodes in same rank (10-200) |
| `edgeStyle` | `"default"` | Edge style: `default`, `smoothstep`, `step`, `straight` |
| `layout.edgeAnimation` | `true` | Animate edges during trace mode |
| `layout.highlightAnimation` | `false` | Animate edges on node click (non-trace) |
| `layout.minimapEnabled` | `true` | Show interactive minimap for large graphs |

**Trace**

| Setting | Default | Description |
|---------|---------|-------------|
| `trace.defaultUpstreamLevels` | `3` | Default upstream trace depth (0-99) |
| `trace.defaultDownstreamLevels` | `3` | Default downstream trace depth (0-99) |

**Analysis**

| Setting | Default | Description |
|---------|---------|-------------|
| `analysis.hubMinDegree` | `8` | Min connections for Hub analysis (1-50) |
| `analysis.islandMaxSize` | `2` | Max island size to display (2-500) |
| `analysis.longestPathMinNodes` | `5` | Min nodes for Longest Path analysis (2-50) |

## Commands

| Command | Description |
|---------|-------------|
| **Data Lineage: Open** | Open the visualization panel |
| **Data Lineage: Create Parse Rules** | Scaffold custom parsing configuration |

## FAQ

**Where do I get a .dacpac file?**
A .dacpac (Data-tier Application Package) can be extracted or built from various tools including Visual Studio, VS Code, SSMS, Azure Data Studio, or the Fabric portal. See [Microsoft's documentation](https://learn.microsoft.com/sql/relational-databases/data-tier-applications/data-tier-applications) for details.

**Why are some dependencies missing?**
Dynamic SQL (`EXEC(@sql)`, `sp_executesql`) cannot be analyzed statically. Only compile-time dependencies are detected.

## Contributing

Bug reports are welcome. Feature requests are not being accepted — this project is maintained for personal use. You're welcome to fork and extend it under the MIT license. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

MIT License · [Christian Wagner](https://www.linkedin.com/in/christian-wagner-11aa8614b) · [GitHub](https://github.com/ChrisDevRepo/vscode_data_lineage) · Developed with [Claude Code](https://claude.ai/code)
