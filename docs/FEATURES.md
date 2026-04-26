# Feature Manifest

This document provides a technical summary of the core capabilities in Data Lineage Viz. For installation and visuals, see the [README](../README.md).

## 1. Schema Overview & Rendering
The extension automatically manages graph complexity based on the following thresholds:

| Setting | Default | Responsibility |
| :--- | :--- | :--- |
| `dataLineageViz.maxNodes` | 750 | Max objects loaded into the in-memory model. |
| `dataLineageViz.renderLimit` | 750 | Max nodes the GUI will layout and render. |
| `dataLineageViz.overview.threshold` | 150 | Threshold for auto-activating schema-level bubbles. |

- **Schema Overview**: Summarizes individual objects into schema bubbles showing object distribution. Double-click to drill into a specific schema's objects and neighbors.
- **Minimap**: Real-time navigation minimap for large graph orientation.
- **Layout Engine**: Supports `LR` (Left-to-Right) and `TB` (Top-to-Bottom) flow with configurable `rankSeparation`.

## 2. Interactive Trace & Path Finding
- **Level Tracing**: Right-click any node to explore upstream (inputs) or downstream (outputs) to a configurable depth. The graph filters to the discovered subgraph.
- **Shortest Path**: Highlight the deterministic shortest dependency path between any two selected objects.
- **Focus Mode**: Star a schema to highlight it and its direct connections while dimming unrelated objects.

## 3. Filters & Bookmarks
- **Type Filter**: Toggle visibility for Tables, Views, Procedures, Functions, and External Tables.
- **Exclusion Rules**: Real-time, pattern-based node hiding.
    - **LIKE Syntax**: Use `%` for wildcards (e.g. `dbo.%`).
    - **Regex Syntax**: Use `^` anchors for precise matching (e.g. `^stg_.*`).
- **Bookmarks**: Save the current filter state (schemas, types, exclusions) as a named profile per project.

## 4. Algorithmic Pattern Detection
The extension executes graph-wide structural analysis to identify specific patterns:
- **Islands**: Disconnected subgraphs with no edges to the rest of the model.
- **Hubs**: Objects with high connection counts (risk hotspots). Threshold: `analysis.hubMinDegree`.
- **Orphans**: Unreferenced objects (dead-code candidates).
- **Cycles**: Circular dependencies blocking incremental deployments.
- **Longest Path**: Maximum blast-radius dependency chains.

## 5. SQL & Data Insights
- **Detail Search**: Full-text regex search across SQL bodies (procedures, views, functions) and column metadata.
- **Table Profiling**: On-demand calculation of column statistics (null counts, distinct values, min/max) via separate database connection.
- **DACPAC Support**: Streams XML metadata from SSDT and SDK-style packages.
- **DMV Ingestion**: Two-phase metadata load for live SQL Server, Azure SQL, Fabric DW, and Synapse connections.

## 6. AI Lineage (@lineage)
Natural language exploration using an autonomous state machine in Copilot Chat.
- **Inline Mode**: Holistic analysis for small scopes (≤ 10 nodes). AI receives all SQL at once.
- **Sliding Memory Mode**: Hop-by-hop traversal for deep lineages using tiered memory (Short-Term Memory + Detail Archive).
- **Selection-Inference Routing**: Every hop is driven by an AI-generated sub-question validated against the catalog before execution.

## 7. Export
- **Draw.io**: Generate XML diagrams compatible with diagrams.net, preserving node colors and edge directions.
