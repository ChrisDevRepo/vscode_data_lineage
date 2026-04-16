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

## Graph Analysis

Six analysis modes are available from the toolbar dropdown:

| Mode | What it finds |
|------|--------------|
| **Islands** | Disconnected subgraphs — groups with no edges to the rest of the graph |
| **Hubs** | Nodes with the highest connection count (change-risk hotspots) |
| **Orphan Nodes** | Objects with zero connections — dead-code candidates |
| **Longest Path** | Deepest dependency chains from source to sink (maximum blast radius) |
| **Cycles** | Circular dependencies that block incremental deployment |
| **External Refs** | Virtual nodes for file sources (OPENROWSET) and cross-database references |

Click any group in the analysis sidebar to zoom into that subset. Thresholds are configurable:

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

The `@lineage` AI assistant in GitHub Copilot Chat can go further by analyzing the available metadata (DDL, column definitions, constraints). It can attempt:

- **Column-level dependency tracing** — mapping how specific columns flow between objects
- **SQL logic explanation** — breaking down view and procedure bodies
- **Documentation** — summarizing data flows and schema purposes
- **Bookmarked views** — creating filtered graph views you can save and explore interactively

> **Note:** AI-enhanced analysis depends on the completeness of the loaded metadata. Column-level tracing reads DDL to infer mappings — results may be incomplete if DDL is unavailable or if the logic involves dynamic SQL. Always verify AI output against your actual database. For deepInvestigations, the assistant utilizes the `ColumnTraceState` engine in a persistent "SM Mode" to track renames across many dependency stages.

When the AI creates a view in the app (e.g., *"show me the lineage in the app"*), it generates a filtered graph with annotated nodes. This view is saved as a bookmark — you can reopen it any time, interact with the graph, trace further, or export it.

### Example queries

**Trace & explore lineage**

```
@lineage trace from Sales.SalesOrderDetail upstream to the source tables
@lineage show me all dependencies of HumanResources.Employee in the app
@lineage what downstream objects depend on Sales.SalesTerritory?
@lineage find the shortest path from Purchasing.Vendor to Sales.SalesOrderHeader
```

**Column-level lineage (AI-enhanced)**

```
@lineage how is sales calculated — show me the lineage up to source in the app
@lineage what columns from SalesOrderHeader end up in Sales.vSalesPerson?
```

When DDL is loaded, the AI assistant can attempt column-level dependency tracing — returning column mappings, join paths, and formula breakdowns. Results depend on the completeness of available metadata. The AI can create an annotated graph view you can save as a bookmark for further interactive exploration.

For broader investigations — business rules, documentation, or pattern discovery across many objects — the assistant uses an exploration mode with persistent two-tier memory: detailed findings stored per node plus one-line summaries visible in every subsequent step. This keeps the assistant focused on your original question even across large scopes.

**SQL understanding**

```
@lineage explain the SQL of Sales.vSalesPerson — any performance or logic issues?
@lineage what joins does HumanResources.vEmployee use?
```

**Documentation**

```
@lineage document the data flow from Purchasing tables to the reporting views
@lineage summarize what the Production schema does
```

**Analysis**

```
@lineage which objects are hubs with the most connections?
@lineage find orphan tables that nothing depends on
@lineage are there any circular dependencies?
```

**Discovery**

```
@lineage what schemas are loaded?
@lineage find tables with Employee in the name
```

### How it works

- Built-in tools: search objects, trace dependencies, explore business rules, get DDL, run analysis, and more
- Works with any model in your Copilot chat dropdown
- Auto-scales context limits based on the model's context window
- Tools are only active when a lineage graph is loaded

### Tips

- **AI column-level analysis.** With Copilot Chat, the `@lineage` AI assistant can attempt to trace column mappings, join paths, and formulas from your loaded metadata. Results depend on DDL completeness — always verify against your database.
- **Session isolation.** Starting a new chat window correctly resets the assistant's state. To start a fresh investigation without interference from previous questions, press `Ctrl+L` or open a new chat window.
- **Overriding filters.** The assistant is aware of your active filters. If you need to analyze an object outside your current schema filter, simply ask — the AI can explicitly override your filters to find what you need.
- **Ask the AI to create a view.** Say *"show me the full lineage for dbo.udfLeadingZeros in the app"* — it builds a filtered graph view with annotated nodes, saved as a bookmark.
- **The assistant is context-aware.** It knows what filters are active, which schemas are visible, and what your current graph shows. Ask *"what am I looking at?"* or *"what's filtered out?"*.
- **Be specific with object names.** Use `Sales.SalesOrderDetail` rather than *"the sales order table"*.
- **Customize output.** Command Palette → *Create AI Output Templates* to tailor the AI response format. See [AI prompt templates guide](AI_PROMPTS.md).
- **Narrow BFS scope on large graphs.** Ask for 1–2 levels first, then expand if you need more depth.
- **Try a bigger model for large databases.** Models with 128K+ context auto-scale to show more results and larger DDL.

### How @lineage analyzes your database

When you ask `@lineage` a question, it goes through four steps:

1. **Search** — finds the relevant objects in your loaded model
2. **Scope** — determines how many objects are involved (the "scope")
3. **Analyze** — reads the SQL of each object and traces column flows
4. **Annotate** — creates labeled graph views with section descriptions

For step 3, the assistant automatically chooses between two analysis modes based on scope size:

**Quick analysis** — for small scopes (≤10 objects and under token budget). The AI receives all SQL at once, reasons about everything in a single pass, and submits all decisions in one batch. This is fast and works well for straightforward questions like *"what reads from the Employee table?"* or *"trace BusinessEntityID upstream."*

**Deep exploration** — for larger scopes (>10 objects or exceeding token budget). The AI examines one object at a time, building persistent memory as it goes. Each step records what was found — column renames, formulas, join conditions — so that information from early steps remains available 15 or 20 steps later.

**Why does this matter?** In complex ETL pipelines, a column often changes names multiple times. For example, `ItemCount` in Oracle becomes `Quantity`, then `RawQty`, then `OrderQty`, then finally `Qty`. Without persistent memory, the AI loses track of earlier renames and produces incomplete traces. Deep exploration keeps this context across the entire pipeline.

**Settings** — the defaults work well for most databases:

| Setting | Default | Effect |
|---------|---------|--------|
| `ai.inlineTokenBudget` | `10000` | Token threshold — how much SQL data fits in quick mode |
| `ai.inlineNodeCap` | `10` | Node threshold — how many objects fit in quick mode |

Both thresholds must be within limits for quick mode. If either is exceeded, deep exploration is used.

- **Increase `inlineNodeCap`** if your stored procedures are small and you prefer faster responses
- **Decrease it** if you want more thorough analysis on every trace

### Requirements

- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension
- VS Code 1.95+

### Disable

Set `ai.enabled` to `false` in VS Code Settings to remove the `@lineage` participant and all AI tools.

---

## Settings Reference

All settings use the `dataLineageViz.*` prefix. Search `dataLineageViz` in VS Code Settings (`Ctrl+,`) to browse all options.

| Group | Key settings |
|-------|-------------|
| **Import** | `maxNodes`, `renderLimit`, `excludePatterns`, `externalRefs.enabled`, `overview.enabled`, `overview.threshold`, `parseRulesFile` |
| **Database Connection** | `dmvQueryTimeout`, `dmvQueriesFile` |
| **Table Statistics** | `tableStatistics.enabled`, `standardModeEnabled`, `queryTimeout`, `sampleThreshold`, `sampleSize`, `maxColumns`, `useApproxDistinct`, `excludeExternalTables` |
| **Layout** | `layout.direction`, `layout.edgeStyle`, `layout.minimapEnabled`, `layout.edgeAnimation`, `layout.highlightAnimation`, `layout.rankSeparation`, `layout.nodeSeparation` |
| **Trace** | `trace.defaultUpstreamLevels`, `trace.defaultDownstreamLevels` |
| **Analysis** | `analysis.hubMinDegree`, `analysis.islandMaxSize`, `analysis.longestPathMinNodes` |
| **AI Assistant** | `ai.enabled`, `ai.maxRounds`, `ai.inlineTokenBudget`, `ai.inlineNodeCap`, `ai.outputTemplateFile` |

### Customization guides

| Guide | What you can customize |
|-------|----------------------|
| [Custom Parse Rules](PARSE_RULES.md) | Regex rules for stored procedure dependency extraction |
| [Custom DMV Queries](DMV_QUERIES.md) | SQL queries used during database import |
| [Profiling Patterns](PROFILING_PATTERNS.md) | Table statistics SQL reference |

---

## FAQ

**Do I need a .dacpac file?**
No — connect directly to a database. If you prefer a `.dacpac`, extract one from Visual Studio, SSMS, Azure Data Studio, or the Fabric portal. See [Microsoft's documentation](https://learn.microsoft.com/sql/relational-databases/data-tier-applications/data-tier-applications).

**Why are some dependencies missing?**
Dynamic SQL cannot be analyzed statically. Only compile-time dependencies are detected.
