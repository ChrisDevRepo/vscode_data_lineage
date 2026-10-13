# Features

What Data Lineage Viz can do and the settings that control it. For installation and quick start, see the [README](../README.md).

## Commands

Type **Data Lineage** in the Command Palette to see every command. The activity-bar view has the common ones.

## Database connections

Use SQL login or Microsoft Entra ID (MFA supported); Windows authentication is not supported. Passwords stay in VS Code secret storage. Manage connections with **Data Lineage: Add / Edit / Remove Database Connection** and **Update Database Password**. Type the database name yourself, since a database-scoped login may not list databases. Queries: [`DMV_QUERIES.md`](DMV_QUERIES.md). Errors: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#import-and-connection).

## Keyboard shortcuts

Shortcuts work only inside the graph view and are ignored while you type.

| Key | Action |
|-----|--------|
| <kbd>/</kbd> | Focus Quick Jump |
| <kbd>f</kbd> | Fit the graph to the viewport |
| <kbd>?</kbd> | Open Help |
| <kbd>s</kbd> | Toggle Schema View |
| <kbd>h</kbd> | Hide schema clusters in Expanded Schema View |
| <kbd>Delete</kbd> | Exclude the selected node from the view (plain graph only) |
| <kbd>Esc</kbd> | Close active input, then exit the current mode |
| <kbd>[</kbd> / <kbd>]</kbd> | Previous / next AI report section, while the report pane has focus |

<kbd>Esc</kbd> first closes an open input, menu or Help, then leaves one mode per press. Menus work with arrow keys, <kbd>Enter</kbd> and <kbd>Esc</kbd>.

## Schema View

A load with more objects than `dataLineageViz.overview.threshold` opens in **Schema View**: one box per schema. Otherwise it opens in Object View. The toolbar **Schema View** toggle (<kbd>s</kbd>) switches between them when the load is above the threshold and no trace, analysis or preview is active.

- Double-click a schema to expand it. By default it becomes the only expanded schema; set `dataLineageViz.overview.schemaDoubleClickBehavior` to `expand` to keep others open.
- Picking a search result inside a schema box expands that schema.
- **Refresh View** resets schema, type and focus filters and re-checks the threshold.

### Rendering limits

- `dataLineageViz.maxNodes` caps the objects loaded. A larger selection is refused.
- `dataLineageViz.renderLimit` caps the nodes drawn at once. Above it, the graph shows *Render limit reached*. A trace, path, analysis or AI preview counts only its own nodes; in Schema View each collapsed schema counts as one. Search, DDL and `@lineage` still use the whole loaded model.

## Filters and bookmarks

- **Schema filter**: show only chosen schemas.
- **Type filter**: show or hide tables, views, procedures, functions and external tables.
- **Hide isolated**: hide objects with no dependencies in the current view.
- **Focus schema**: star a schema to show it with the schemas it connects to.

A **bookmark** saves the current filters and exclusions, or a trace, analysis, path or AI view, under a name, per project. Node positions are not saved.

A bookmark saved from an AI view also keeps that run's findings, so `@lineage` can recall them instead of redoing the work. Findings on objects whose DDL has changed since are flagged as stale and rechecked.

## Exclusion rules

Hide objects with patterns; changes apply at once. Add a rule from the exclusion menu (ban icon), with right-click **Exclude from view**, or by selecting a node and pressing <kbd>Delete</kbd>. Rules are saved per bookmark. To hide objects on every load, put the patterns in `dataLineageViz.excludePatterns` and reload the data source.

Patterns are case-insensitive regular expressions matched against the object name (`schema.name`); `%` means "anything". Escape `.` for a literal dot and use `^` / `$` to anchor.

| Pattern | Matches |
|---------|---------|
| `%tmp%` | Any name containing "tmp" |
| `^dbo\.` | All objects in the dbo schema |
| `%_stg$` | Any name ending in "_stg" |
| `^dbo\.tmp_` | Names starting with `dbo.tmp_` |

## Trace and path finding

### Trace levels

Right-click a node and choose **Trace Levels** to show its inputs (upstream) and outputs (downstream). Change depth with the level controls; defaults are `dataLineageViz.trace.defaultUpstreamLevels` and `dataLineageViz.trace.defaultDownstreamLevels`. Press <kbd>Esc</kbd> to leave.

On a node, **+** adds a direct neighbor and **−** removes it with any branch that hangs only on it.

### Trace navigator

The navigator button (top left, beside the legend) opens the trace as a tree of **Upstream** and **Downstream** levels. Click a row to light up its routes from the start; check rows to show only their routes, and **Show all** to undo. **+** on a section loads one more level. <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> in the panel finds objects.

### Find path

Right-click a node, choose **Find Path**, then click a second node to highlight the shortest path between them.

## Search

- **Quick Jump** (<kbd>/</kbd>) finds objects by name.
- **Detail Search** (toolbar search icon) searches SQL bodies and column definitions.
- **Data Lineage: Search Objects** in the Command Palette lists loaded objects by name.

## Node details

Right-click a node and choose **Show Details**. The bar shows **In / Out** counts (hover for the list), **Unresolved** references (such as dynamic SQL or other servers) and **Excluded** objects. Tables, views and table-valued functions also list their columns and constraints; views and functions have a **Columns / DDL** switch.

## Detect graph patterns

The analysis menu finds disconnected groups, hubs, unconnected objects, long chains, cycles and external references. Pick a result to focus on it. Thresholds: [Layout, trace and analysis](#layout-trace-and-analysis).

## Export

Export the graph to a `.drawio` file for [diagrams.net](https://app.diagrams.net/).

## Table profiling

Live database only. Profiling runs only when you click it, on a separate connection.

- **Quick**: row count, nulls, distinct values, completeness and uniqueness.
- **Standard**: adds min/max, average and standard deviation for numbers, min/max for dates, string length, empty strings and zero counts.

Large tables are sampled where supported; Fabric always scans in full ([sampling limits](PROFILING_PATTERNS.md#sampling)). External tables are skipped by default. Settings: [Table statistics](#table-statistics).

## `@lineage` AI

Type `@lineage` in VS Code Chat to ask about the loaded graph in plain language. It uses exactly the model you picked for the chat (GitHub Copilot or any compatible provider, including BYOK). Your question and the DDL and columns of the objects in scope are passed to that model through VS Code; VS Code, Copilot and the provider handle them under their own terms.

### How it answers

- **Chat answer** (default): it looks up objects, DDL, neighbors and patterns, then answers in chat. `/search` always uses this mode. If the question needs more than `dataLineageViz.ai.discoveryNodeCap` objects or `dataLineageViz.ai.discoveryTokenBudget` tokens, it offers a deep analysis instead.
- **Graph preview**: the **Show graph preview** follow-up opens an **AI Preview** in the graph view. It is temporary; click **Save as Bookmark** to keep it. **Data Lineage: Show AI Trace in Graph** reopens it.
- **Deep analysis**: `/trace`, the **Start deeper hop-by-hop analysis** follow-up, or an over-budget question. You first see the plan; choose **Approve & Proceed**, **Change scope** or **Cancel**. It then walks the scope one object at a time.

A deep analysis must fit `dataLineageViz.ai.maxRounds` and, for column traces, `dataLineageViz.ai.maxTraceColumns`. If not, chat names the setting so you can narrow the scope or raise the limit.

The assistant sees the trace, analysis or bookmark on screen; type `#lineageView` to attach it explicitly.

When a run finds column mappings, the preview offers an **Objects / Detail** switch to show them.

### Depth

Depth 0 turns a direction off, and a number you give is a hard limit. With none, the assistant picks a start and may go further within the approved scope. The graph's trace-level settings do not affect AI depth.

### Requirements and turning it off

You need VS Code 1.101 or later and a VS Code Language Model Chat provider, such as [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot). To turn `@lineage` off, set `dataLineageViz.ai.enabled` to `false` and reload the window.

## Advanced settings

Run **Data Lineage: Settings** or search "dataLineageViz" in VS Code Settings.

- Reload the data source after changing `maxNodes`, `excludePatterns`, `externalRefs.enabled`, `parseRulesFile` or `dmvQueriesFile`.
- `ai.enabled` needs a window reload.

To debug AI answers, run **Data Lineage: Enable AI Trace Logging for This Session** (needs an open workspace folder). The log can hold SQL and prompts; review it before sharing. See [Diagnostics](DEVELOPER_GUIDE.md#diagnostics).

### Settings reference

All keys start with `dataLineageViz.`.

#### Import and parsing

| Setting | Default | Detail |
|---|---|---|
| `maxNodes` | 2000 (10–5000) | Objects loaded, including external references. |
| `renderLimit` | 750 (100–1500) | Nodes drawn at once; above it the graph shows a notice instead. |
| `excludePatterns` | `[]` | Patterns hidden on every load; same syntax as [Exclusion rules](#exclusion-rules). |
| `externalRefs.enabled` | on | Shows `OPENROWSET` paths and cross-database names as external nodes. |
| `overview.enabled` | on | Allows Schema View. Off always opens Object View and disables the toggle. |
| `overview.threshold` | 150 (10–1000) | Object count above which a load opens in Schema View. Values above `renderLimit` count as `renderLimit`. |
| `overview.schemaDoubleClickBehavior` | `expandOnly` | `expand` adds the schema; `expandOnly` makes it the only one expanded. |
| `parseRulesFile` | empty | Custom parse rules YAML. Create with **Data Lineage: Create Parse Rules**; see [`PARSE_RULES.md`](PARSE_RULES.md). |

#### Database connection

| Setting | Default | Detail |
|---|---|---|
| `database.connections` | `[]` | Saved connections; manage them with the connection commands. |
| `dmvQueryTimeout` | 120 s (10–600) | Time per metadata query; raise for large databases. |
| `dmvQueriesFile` | empty | Custom import queries YAML. Create with **Data Lineage: Create DMV Queries**; see [`DMV_QUERIES.md`](DMV_QUERIES.md). |

#### Table statistics

Live database only; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

| Setting | Default | Detail |
|---|---|---|
| `tableStatistics.enabled` | on | Shows column statistics and row counts. |
| `tableStatistics.standardModeEnabled` | on | Offers Standard mode. Off leaves only Quick mode. |
| `tableStatistics.excludeExternalTables` | on | Skips external tables, which can be slow and costly. |
| `tableStatistics.queryTimeout` | 60 s (10–600) | Time per profiling query. |
| `tableStatistics.sampleThreshold` | 100000 (0–999999999) | Rows above which a table is sampled; `0` samples every nonempty table. |
| `tableStatistics.sampleSize` | 10000 (100–1000000) | Rows sampled. |
| `tableStatistics.useApproxDistinct` | on | Uses `APPROX_COUNT_DISTINCT` (fast, about 2% error). Needs SQL Server 2019 or later. |
| `tableStatistics.maxColumns` | 50 (1–500) | Columns profiled per table. |

#### Layout, trace and analysis

| Setting | Default | Detail |
|---|---|---|
| `layout.direction` | `LR` | `LR` left to right, `TB` top to bottom. |
| `layout.edgeStyle` | `default` | `default` curves, `smoothstep` rounded steps, `step` sharp steps, `straight` lines. |
| `layout.edgeAnimation` | on | Animates edges during a trace. |
| `layout.highlightAnimation` | off | Animates edges when you click a node. |
| `layout.minimapEnabled` | on | Shows the minimap. |
| `layout.rankSeparation` | 120 px (20–300) | Gap between dependency layers. |
| `layout.nodeSeparation` | 30 px (10–200) | Gap between nodes in a layer. |
| `trace.defaultUpstreamLevels` | 3 (0–99) | Input levels a trace starts with. |
| `trace.defaultDownstreamLevels` | 3 (0–99) | Output levels a trace starts with. |
| `analysis.hubMinDegree` | 8 (1–50) | Connections needed to count as a hub. |
| `analysis.islandMaxSize` | 500 (2–1000) | Largest group reported as an island; lower it to list only small groups. |
| `analysis.longestPathMinNodes` | 5 (2–50) | Objects a chain needs to show in longest-path analysis. |

#### `@lineage`

| Setting | Default | Detail |
|---|---|---|
| `ai.enabled` | on | Turns `@lineage` on or off. Reload the window after changing it. |
| `ai.maxRounds` | 50 (5–100) | Rounds per deep analysis: one per procedure, view or function read. |
| `ai.maxTraceColumns` | 10 (min 1) | Starting columns one column trace may follow. |
| `ai.discoveryNodeCap` | 10 (1–30) | Objects a chat answer may use before deep analysis is offered. |
| `ai.discoveryTokenBudget` | 10000 (1000–32000) | DDL tokens a chat answer may use (at most one eighth of the model's input window). |
| `ai.outputTemplateFile` | empty | Custom output templates YAML. Create with **Data Lineage: Create AI Output Templates**; see [`AI_PROMPTS.md`](AI_PROMPTS.md). |
