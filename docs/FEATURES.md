# Features

Comprehensive guide to all features in Data Lineage Viz. For installation and quick start, see the [README](../README.md).

---

## Schema Overview

When a graph exceeds a configurable node threshold, the extension auto-activates **schema overview mode** — replacing individual nodes with schema-level bubbles showing object counts and type distribution.

- Double-click any schema bubble to drill into its objects and connected neighbors
- Toggle manually via the toolbar or the `Toggle Schema Overview Mode` command
- Configure: `overview.enabled`, `overview.threshold` in VS Code Settings

### Rendering Limits

The extension separates **data loading** (`maxNodes`) from **graph rendering** (`renderLimit`). This allows `@lineage` AI tools and BFS to query the full loaded model while the GUI stays responsive.

| Setting | Default | Controls |
|---------|---------|----------|
| `maxNodes` | 750 (up to 10000) | Objects loaded from dacpac / database |
| `renderLimit` | 750 (up to 5000) | Nodes the GUI will layout and render |
| `overview.threshold` | 150 | Auto-activates schema overview |

When `renderLimit` is exceeded, the graph shows a "limit reached" message instead of rendering. The full lineage model, DDL, and AI chat remain fully functional — only the visual graph is gated.

---

## Filters & Bookmarks

### Filters

- **Schema Filter** — show only selected schemas (grid icon in the toolbar)
- **Type Filter** — show/hide tables, views, procedures, functions, external tables
- **Hide Isolated** — hide nodes with no dependencies in the current view
- **Focus Schema** — star a schema to highlight it and its directly connected objects

### Bookmarks

Save the current filter state (selected schemas, types, exclusion rules) as a named **bookmark**. Restore any bookmark from the toolbar dropdown to return to that exact view.

Bookmarks are saved per project — switch between different views of the same data source without reconfiguring filters.

---

## Exclusion Rules

Hide nodes from the graph using pattern-based rules. Rules apply in real-time — no data reload needed.

### Three ways to add a rule

1. Open the exclusion dropdown (ban icon in toolbar) and type a pattern
2. Right-click any node and select **Exclude from view**
3. Select a node and press <kbd>Del</kbd>

### Pattern syntax

Patterns are matched against `schema.name` (case-insensitive).

| Pattern | Matches |
|---------|---------|
| `%tmp%` | Any name containing "tmp" |
| `dbo.%` | All objects in the dbo schema |
| `%_stg` | Any name ending in "_stg" |
| `^dbo\.tmp_` | Regex: starts with dbo.tmp_ |

`%` works like SQL `LIKE` (matches any sequence of characters). Patterns without `%` or regex metacharacters are treated as exact matches. Exclusion rules are **saved per bookmark**.

---

## Trace & Path Finding

### Trace

Right-click any node and select **Trace Levels** to explore upstream (inputs) and downstream (outputs) dependencies. The graph filters to show only the traced subgraph.

- Adjust trace depth with the level controls
- Default depth is configurable: `trace.defaultUpstreamLevels`, `trace.defaultDownstreamLevels`
- Press <kbd>Esc</kbd> to exit trace mode

### Find Path

Right-click a node and select **Find Path**, then click a second node. The extension highlights the shortest dependency path between them.

---

## Detail Search

Full-text search inside SQL bodies (stored procedures, views, functions) and column definitions. Access via the search icon in the toolbar.

This is distinct from **Quick Search** (<kbd>/</kbd>), which matches object names only. Detail Search scans the actual SQL code and column metadata.

---

## Node Details

Right-click any node and select **Show Details** to open the detail bar at the bottom of the graph.

- **In / Out** — count of connected input and output nodes (hover for full list)
- **Unresolved** — SQL references not found in the data source (e.g. dynamic SQL, cross-server refs)
- **Excluded** — nodes hidden by your exclusion patterns

For **tables, views, external tables, and table-valued functions**, the detail panel shows column metadata: name, data type, nullability, primary key, and foreign key constraints. Views and TVFs show a **Columns / DDL toggle** to switch between the column table and SQL source code.

---

## Detect Graph Patterns

Six analysis modes are available from the toolbar dropdown:

| Mode | What it finds |
|------|--------------|
| **Islands** | Disconnected subgraphs — groups with no edges to the rest of the graph |
| **Hubs** | Nodes with the highest connection count (change-risk hotspots) |
| **Orphan Nodes** | Objects with zero connections — dead-code candidates |
| **Longest Path** | Deepest dependency chains from source to sink (maximum blast radius) |
| **Cycles** | Circular dependencies that block incremental deployment |
| **External Refs** | Virtual nodes for file sources (OPENROWSET) and cross-database references |

### Algorithmic Accuracy

To ensure reliability, all structural graph algorithms (Cycles, Hubs, Pathfinding) are verified against a high-fidelity reference model. This helps maintain logical accuracy even on massive, enterprise-scale databases.

Click any group in the pattern sidebar to zoom into that subset. Thresholds are configurable:

- `analysis.hubMinDegree` — minimum connections to qualify as a hub
- `analysis.islandMaxSize` — maximum component size to qualify as an island
- `analysis.longestPathMinNodes` — minimum chain length to report

---

## Export

Export the current graph to a `.drawio` file with colored nodes, directed edges, and a schema legend. The file opens directly in [diagrams.net](https://app.diagrams.net/) (Draw.io).

---

## Table Profiling

> Database import only. See [Profiling Patterns](PROFILING_PATTERNS.md) for the full SQL reference.

On-demand column statistics via a **separate database connection**. Profiling runs only when you click a button in the table detail panel — no automatic queries.

### Modes

- **Quick** — row count, null count, distinct count per column
- **Standard** — adds AVG, STDEV, min/max values, zero/empty counts

Standard mode can be disabled via `tableStatistics.standardModeEnabled`.

### Safety for large databases

- Tables above a configurable row threshold are **sampled** instead of fully scanned
- **External tables** are skipped by default (they query remote data sources like S3, Blob, or other databases)
- Each query has a configurable **timeout**
- All generated SQL is logged to the Output channel (`View → Output → Data Lineage Viz`)

### Key settings

| Setting | Purpose |
|---------|---------|
| `tableStatistics.enabled` | Enable/disable the profiling UI |
| `tableStatistics.standardModeEnabled` | Allow Standard mode (heavier queries) |
| `tableStatistics.excludeExternalTables` | Skip external tables |
| `tableStatistics.queryTimeout` | Timeout per profiling query |
| `tableStatistics.sampleThreshold` | Row count above which sampling activates |
| `tableStatistics.sampleSize` | Number of rows to sample |

### Permissions

- `SELECT` on profiled tables
- `VIEW SERVER STATE` at server level (for row counts via `sys.dm_db_partition_stats`)

---

## @lineage AI (GitHub Copilot Chat)

Type `@lineage` in GitHub Copilot Chat to explore your loaded lineage graph with natural language. The assistant answers from your actual data — never from general knowledge.

### Core features vs AI-enhanced capabilities

The extension provides **object-level lineage** as its core feature — tracing dependencies between tables, views, stored procedures, and functions. This works deterministically from your data model.

The `@lineage` AI assistant in GitHub Copilot Chat can go further by analyzing the available metadata (DDL, column definitions, constraints). It implements a state-of-the-art **Grounded Router** architecture for autonomous exploration.

### How @lineage analyzes your database

When you ask `@lineage` a question, it chooses between two analysis modes based on scope size:

#### 1. Quick analysis (Inline Mode)
For small scopes (≤10 objects and under token budget). 
- **One-Shot**: The AI receives all SQL at once and reasons about everything in a single pass.
- **Holistic**: Best for straightforward questions like *"what reads from the Employee table?"*.
- **Integrated**: Uses the same Map and Verification logic as deep exploration, but without the round-trip overhead of sliding memory.

#### 2. Deep exploration (SM Mode)
For larger scopes (>10 objects or exceeding token budget). 
- **Map & Router Architecture**: The extension manages a **Topological Map** of the trace, while the AI acts as a **Router** that analyzes one object at a time.
- **Incremental context via one-liner summaries**: After each hop, the AI's one-line summary is appended to `working_memory.short_term_memory` and echoed on the next 3 subsequent hops. This "Sliding Memory" ensures local continuity while preventing global context bloat.
- **Selection-Inference Routing**: Every hop is driven by a specific, AI-generated sub-question. The engine provides neighbor metadata (columns) and validates AI routing requests *before* the visit to prevent hallucinations ("Fail Early").

### Why this matters?
In complex ETL pipelines, a column often changes names multiple times. Deep exploration keeps this context across the entire pipeline using the **Hourglass Context Model** and a **two-tier memory model**:
- **Short-Term Memory (In-Context)**: A sliding window of the most recent node summaries, shipped every hop as `working_memory.short_term_memory`.
- **Detail Archive (Long-Term)**: The AI's full technical analysis per node, stored internally and only delivered in the final synthesis phase when the entire investigation is assembled into a report.

### Tips

- **AI column-level analysis.** With Copilot Chat, the `@lineage` AI assistant can attempt to trace column mappings, join paths, and formulas from your loaded metadata. Always verify against your database.
- **Session isolation.** Starting a new chat window correctly resets the assistant's state. To start a fresh investigation, press `Ctrl+L`.
- **Incremental Updates.** You can ask the AI to add or remove specific nodes from an existing graph view without restarting the entire analysis.
- **Ask the AI to create a view.** Say *"show me the full lineage for dbo.udfLeadingZeros in the app"* — it builds a filtered graph view with annotated nodes, saved as a bookmark.
- **The assistant is context-aware.** It knows what filters are active and which schemas are visible. Ask *"what's filtered out?"*.
- **Customize output.** Command Palette → *Create AI Output Templates* to tailor the AI response format.

### Requirements

- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension
- VS Code 1.95+

### Disable

Set `ai.enabled` to `false` in VS Code Settings to remove the `@lineage` participant and all AI tools.
