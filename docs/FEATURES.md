# Features

Capabilities of Data Lineage Viz, with the VS Code settings that control them. For installation and quick start, see the [README](../README.md).

---

## Commands and entry points

Open the Command Palette and filter for **Data Lineage**. Commands cover data
loading and refresh, object search, settings, customization-file scaffolding,
AI graph results, and diagnostics. The activity-bar view exposes the common
loading and settings actions.

---

## Database connections

A live database is read through connections saved by Data Lineage. They use SQL login or Microsoft Entra ID; Windows authentication is not supported. Entra sign-in uses VS Code's Microsoft account picker. Passwords, certificate trust and the other connection details are in [`SECURITY.md`](../SECURITY.md#connections).

Manage connections through **Data Lineage: Add / Edit / Remove Database Connection** and **Update Database Password** in the Command Palette. Enter the database name directly; a database-scoped login may not be able to list databases.

Import runs read-only metadata queries, documented in [`DMV_QUERIES.md`](DMV_QUERIES.md). For connection errors and projects saved with the retired SQL Server (mssql) extension connection, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#import-and-connection).

---

## Keyboard shortcuts

All shortcuts are local to the graph webview. The extension registers no VS Code
global keybindings.

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

Bare-key shortcuts are ignored while typing in an input and with a Ctrl, Cmd or
Alt modifier. <kbd>Esc</kbd> closes the active input, dropdown or help panel
first, then exits one graph mode per press (AI preview, bookmark, analysis,
trace).

---

## Schema View

When a loaded graph has more objects than `dataLineageViz.overview.threshold` (capped at `renderLimit`), the extension starts in **Schema View**: one cluster node per schema, with object counts and type distribution. Otherwise it starts in Object View. After that, the toolbar **Schema View** toggle switches between the two views, except while a trace, analysis, bookmark or AI preview is active or when the model has no more objects than the threshold, where it is disabled; filters and exclusions do not re-check the threshold.

- Double-clicking a schema cluster expands that schema as object nodes. By default (`expandOnly`) the clicked schema becomes the only expanded one; set `dataLineageViz.overview.schemaDoubleClickBehavior` to `expand` to add it alongside schemas already expanded.
- Selecting a schema cluster shows **Expand** (keeps other expanded schemas open) and **Expand Only** (collapses the others).
- Quick Jump and Detail Search group results as **Visible**, **In Schema Cluster**, and **Not in Current Filter**. Selecting an object in a schema cluster expands that schema.
- **Refresh View** resets the schema, type, external-reference, and focus schema filters, collapses expanded schemas, and re-applies the initial Object View / Schema View decision. Exclusion rules and the Hide Isolated toggle persist.
- Settings: `dataLineageViz.overview.enabled`, `dataLineageViz.overview.threshold`, `dataLineageViz.overview.schemaDoubleClickBehavior`.

### Rendering limits

`dataLineageViz.maxNodes` limits the objects (including virtual external-reference nodes) loaded. A selection above it is refused: nothing is loaded, the prior view stays, and an error names the count, the limit and the setting.

`dataLineageViz.renderLimit` limits the nodes drawn at once. When a selection would draw more, the graph shows a *Render limit reached* notice instead. A trace, path, analysis or AI preview counts only its own nodes; in Schema View each collapsed schema counts as one. Search, DDL and the AI tools use the whole loaded model.

---

## Filters & bookmarks

### Filters

- **Schema filter** — show only selected schemas (grid icon in the toolbar).
- **Type filter** — show / hide tables, views, procedures, functions, external tables.
- **Hide isolated** — hide nodes with no dependencies in the current view.
- **Focus schema** — star a schema to show it together with schemas connected to it by at least one dependency.

### Bookmarks

Save the current filter state as a named bookmark. Bookmarks keep schema, object-type, isolation, external-reference, focus, and exclusion choices; trace, analysis, and AI views can also be saved. Restore them from the toolbar dropdown. Bookmarks are saved per project.

A bookmark saved from an AI view also keeps that run's findings. With that bookmark applied, the assistant can recall them instead of repeating the work. Findings on objects whose DDL changed since are flagged as stale. Older bookmarks may have no saved run. Deleting a bookmark or its project deletes its run record.

---

## Exclusion rules

Hide nodes from the graph using pattern-based rules. Rules apply without reloading the data.

To hide objects on every load, list the same patterns in `dataLineageViz.excludePatterns`. That setting is applied when a source is opened and takes effect after the data source is reloaded.

### Three ways to add a rule

1. Open the exclusion dropdown (ban icon in toolbar) and type a pattern.
2. Right-click any object node and select **Exclude from view**.
3. Select a node and press <kbd>Delete</kbd>.

### Pattern syntax

Patterns are case-insensitive regular expressions matched against both `schema.name` and the object's full name. `%` means "anything".

| Pattern | Matches |
|---------|---------|
| `%tmp%` | Any name containing "tmp" |
| `dbo.%` | `dbo`, any character, then anything; not anchored, so `mydbo.x` also matches. Use `^dbo\.` for the schema only |
| `%_stg$` | Any name ending in "_stg" |
| `^dbo\.tmp_` | Regex: starts with `dbo.tmp_` |

Escape `.` for a literal dot and use `^` / `$` to anchor a name. Exclusion rules are saved per bookmark.

---

## Trace & path finding

### Trace levels

Right-click a node and select **Trace Levels** to explore upstream (inputs) or downstream (outputs) dependencies. The graph filters to the discovered subgraph.

- A configuration bar sets the Upstream and Downstream levels (0–99, or **All**) and shows the object count the choice would produce, marked when it is over `dataLineageViz.renderLimit`. **Apply** runs the trace.
- Default depth is configurable: `dataLineageViz.trace.defaultUpstreamLevels`, `dataLineageViz.trace.defaultDownstreamLevels`.
- Press <kbd>Esc</kbd> to exit trace mode.

### Edit a trace

After running **Trace Levels**, refine the result on the graph without re-running it:

- **Add a neighbour** — the **+** control on a node adds one of its direct upstream/downstream neighbours that the trace did not include.
- **Prune** — the **−** control on a node removes one of its neighbours; right-click **Remove from trace** removes the node itself. Objects that are reachable only through the removed node leave with it. The trace origin cannot be removed.
- The trace navigator footer lists the edit counts and a **Reset** button that restores the starting scope. <kbd>Esc</kbd> exits the trace.

Editing applies to Trace Levels results, not to a computed shortest path.

### Trace navigator

While a trace or path is shown, the navigator panel (top left) lists it as a tree of **Upstream** and **Downstream** hop levels, plus a **Connected** group for objects neither direction reaches. Its close button collapses it to a small button that reopens it. It is not shown while Detail Search or an analysis is open.

- Click a row to light up the routes from the starting point to that node.
- Check rows (or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+click) to show only the routes to the checked nodes. **Show all** restores the trace.
- **+** on a section loads one more level (Trace Levels results only); **Expand all** / **Collapse all** open or close every level.
- <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>F</kbd> in the panel finds objects.

### Find path

Right-click a node and select **Find Path**, then type the name of a second node in the bar and pick it. The graph shows the shortest dependency path between them, trying the first node to the second and then the reverse. The bar shows "No connection found" when neither direction has a path.

---

## Detail search

Case-insensitive search inside SQL bodies (procedures, views) and column names (tables, external tables). Toolbar search icon. This is distinct from **Quick Jump** (<kbd>/</kbd>), which matches object names only, and from Command Palette **Data Lineage: Search Objects**, which opens a VS Code Quick Pick over loaded object names.

---

## Node details

Right-click a node and select **Show Details** to open an info bar for it.

- **In / Out** — count of connected input / output nodes (hover for the full list).
- **Unresolved** — references the parser found that match no object in the loaded catalog.
- **Excluded** — objects it references that your exclusion patterns removed.

**Show Table Details** (tables and external tables) and **Show DDL** (other objects) open a detail panel beside the graph. It shows column metadata (name, data type, nullability, primary key) and, for tables from a `.dacpac`, foreign keys. Views and functions that have both columns and a definition get **DDL** and **Columns** tabs.

---

## Detect graph patterns

The analysis dropdown finds disconnected groups, hubs, unconnected objects,
long dependency paths, cycles, and external references. Select a result group
to focus the graph on that subset. Thresholds are set under **Data Lineage**
settings ([Layout, trace and analysis](#layout-trace-and-analysis)).

---

## Export

Export the current graph to a `.drawio` file with coloured nodes, directed edges, and a schema legend. The file opens directly in [diagrams.net](https://app.diagrams.net/).

---

## Table profiling

> Database import only. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) for operational details and limitations.

On-demand column statistics for one table, over a separate database connection. Profiling runs only when you request it. It issues read-only row-count and aggregate `SELECT` queries and needs `SELECT` permission on the profiled tables.

- **Quick** — row count, null count and distinct count per column, plus completeness and uniqueness percentages.
- **Standard** — adds min/max, average and standard deviation for numbers, min/max for dates, string length and empty-string counts, and zero counts.

Standard mode can be disabled with `dataLineageViz.tableStatistics.standardModeEnabled`.

Tables above `tableStatistics.sampleThreshold` rows are sampled instead of fully scanned; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md#sampling). External tables are skipped by default, because they query remote data sources. Each query has a timeout, and columns above `tableStatistics.maxColumns` are skipped.

---

## AI

The assistant is being rebuilt as its own panel. The model setup and the lineage tools are in place:

- **Models.** `dataLineageViz.ai.models` lists OpenAI-compatible endpoints (Chat Completions or Responses). `dataLineageViz.ai.defaultModel` names the entry to use. An invalid entry is named in a warning and not offered.
- **API keys.** **Data Lineage: Set API key** stores the key of one entry in VS Code's secret storage. A key is never in settings, logs or the webview.
- **Tools.** The read-only lineage tools over the loaded model are served to local MCP clients (such as Copilot, Claude Code, Cursor or Codex CLI) when `dataLineageViz.mcp.enabled` is on. Nothing connects to the database.
- **Output templates.** **Data Lineage: Create AI Output Templates** scaffolds [`aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml), which controls the summary, badges and notes. See [`AI_PROMPTS.md`](AI_PROMPTS.md).

What a model reads (the SQL and metadata the tools return) is sent to the endpoint of the entry used, including for a local DACPAC. To turn the AI tools off, set `dataLineageViz.ai.enabled` to `false` and reload the window.

---

## Advanced settings

Run **Data Lineage: Settings** or search "dataLineageViz" in VS Code Settings.

- Reload the data source after changing `maxNodes`, `excludePatterns`, `externalRefs.enabled`, `parseRulesFile` or `dmvQueriesFile`.
- `ai.enabled` needs a window reload; the other `ai.*` limits are read on every request.

Customization files are documented separately:

- [`PARSE_RULES.md`](PARSE_RULES.md) for SQL extraction rules;
- [`DMV_QUERIES.md`](DMV_QUERIES.md) for live-import queries;
- [`AI_PROMPTS.md`](AI_PROMPTS.md) for AI output templates; and
- [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) for profiling behavior.

To debug AI answers, run **Data Lineage: Enable AI Trace Logging for This Session** (needs an open workspace folder). The trace is saved under the folder's `tmp/lm-trace/` directory and the file path is shown in a notification. It can contain schema, table, column, SQL, prompt and response text, so review it before sharing and do not commit it. Logging stops when the extension host restarts.

### Settings reference

All keys start with `dataLineageViz.`.

#### Import and parsing

| Setting | Default | Detail |
|---|---|---|
| `maxNodes` | 2000 (10–5000) | Objects, including virtual external-reference nodes, loaded. A selection over the limit is refused. See [Rendering limits](#rendering-limits). |
| `renderLimit` | 750 (100–1500) | Nodes drawn at once. Above it, the graph shows a *Render limit reached* notice. |
| `excludePatterns` | `[]` | Case-insensitive regular expressions, matched against `schema.name` and the full name; `%` is a wildcard. Applied when a source is opened. For filtering without a reload use the toolbar exclusion rules ([Exclusion rules](#exclusion-rules)). |
| `externalRefs.enabled` | on | Draws `OPENROWSET` file paths and cross-database three-part names as virtual external nodes. Off creates none. External tables are unaffected. |
| `overview.enabled` | on | Allows Schema View. Off keeps every load in Object View and hides the Schema View toggle. |
| `overview.threshold` | 150 (10–1000) | Object count above which a new load starts in Schema View. Values above `renderLimit` count as `renderLimit`. |
| `overview.schemaDoubleClickBehavior` | `expandOnly` | `expand` adds the double-clicked schema to the expanded schemas; `expandOnly` makes it the only expanded one. |
| `parseRulesFile` | empty | Custom parse rules YAML; empty uses the built-in rules. Scaffold with **Data Lineage: Create Parse Rules**; see [`PARSE_RULES.md`](PARSE_RULES.md). Applies after reload. |

#### Database connection

| Setting | Default | Detail |
|---|---|---|
| `database.connections` | `[]` | Saved connections. Passwords are kept in VS Code secret storage. Manage entries with the connection commands. |
| `dmvQueryTimeout` | 120 s (10–600) | Time allowed per metadata query; raise for large databases. |
| `dmvQueriesFile` | empty | Custom DMV queries YAML; empty uses the built-in queries. Scaffold with **Data Lineage: Create DMV Queries**; see [`DMV_QUERIES.md`](DMV_QUERIES.md). Read at each import. |

#### Table statistics

Database import only; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

| Setting | Default | Detail |
|---|---|---|
| `tableStatistics.enabled` | on | Shows column statistics and row counts in the detail panel. Profiling still runs only on request. |
| `tableStatistics.standardModeEnabled` | on | Offers Standard mode. Off leaves Quick mode, which runs lighter queries. |
| `tableStatistics.excludeExternalTables` | on | Skips external tables, which query remote sources (S3, Blob, other databases). |
| `tableStatistics.queryTimeout` | 60 s (10–600) | Time allowed per profiling query. |
| `tableStatistics.sampleThreshold` | 100000 (0–999999999) | Row count above which a table is sampled instead of fully scanned; `0` samples every nonempty table. |
| `tableStatistics.sampleSize` | 10000 (100–1000000) | Approximate number of rows read when a large table is sampled. |
| `tableStatistics.useApproxDistinct` | on | Uses `APPROX_COUNT_DISTINCT` instead of `COUNT(DISTINCT)`: faster, about 2% error. Needs SQL Server 2019 or later; turn off on older versions. |
| `tableStatistics.maxColumns` | 50 (1–500) | Columns profiled per table; the rest are skipped. |

#### Layout, trace and analysis

| Setting | Default | Detail |
|---|---|---|
| `layout.direction` | `LR` | `LR` left to right, `TB` top to bottom. |
| `layout.edgeStyle` | `default` | `default` bezier curves, `smoothstep` rounded steps, `step` sharp steps, `straight` straight lines. |
| `layout.edgeAnimation` | on | Animates edges while a trace runs. |
| `layout.highlightAnimation` | off | Animates edges when a node is clicked. |
| `layout.minimapEnabled` | on | Shows the minimap. |
| `layout.rankSeparation` | 120 px (20–300) | Gap between dependency layers. |
| `layout.nodeSeparation` | 30 px (10–200) | Gap between nodes within a layer. |
| `trace.defaultUpstreamLevels` | 3 (0–99) | Levels of inputs a trace starts with; `0` leaves out the upstream direction. |
| `trace.defaultDownstreamLevels` | 3 (0–99) | Levels of outputs a trace starts with; `0` leaves out the downstream direction. |
| `analysis.hubMinDegree` | 8 (1–50) | Connections an object needs to be listed as a hub. |
| `analysis.islandMaxSize` | 500 (2–1000) | Largest connected group reported as an island; lower it to list only small isolated groups. |
| `analysis.longestPathMinNodes` | 5 (2–50) | Objects a chain needs to appear in longest-path analysis. |

#### AI

| Setting | Default | Detail |
|---|---|---|
| `ai.enabled` | on | Registers the AI tools. Reload the window after changing it. |
| `ai.maxRounds` | 50 (5–100) | Rounds per deep analysis, one for each procedure, view or function it reads. An analysis that needs more is not started. |
| `ai.maxTraceColumns` | 10 (min 1) | Starting columns one column trace may follow. A trace that selects more is not started. |
| `ai.discoveryNodeCap` | 10 (1–30) | Scope nodes a discovery answer may pull in one request before it is offered as a deep analysis for approval. |
| `ai.discoveryTokenBudget` | 10000 (1000–32000) | Estimated DDL tokens for one discovery request, capped at one eighth of the selected model's input window. Exceeding it or the node cap offers a deep analysis for approval. |
| `ai.outputTemplateFile` | empty | Custom output templates YAML; empty uses the built-in templates. Scaffold with **Data Lineage: Create AI Output Templates**; keys in [`AI_PROMPTS.md`](AI_PROMPTS.md). |
| `ai.models` | empty list | OpenAI-compatible endpoints (Chat Completions or Responses), one entry each: `id`, `name`, `url`, `model`, `apiType`, `maxInputTokens`, `maxOutputTokens`, optional `supportsReasoningEffort`, `reasoningEffort`, `forcedToolChoice`, `requestBody` (extra parameters, sent unchanged) and `requestHeaders`. An invalid entry is named and not offered. Keys are never settings: run **Data Lineage: Set API key** per entry. |
| `ai.defaultModel` | empty | The `id` of the `ai.models` entry used by default. |
| `mcp.enabled` | off | Serves the lineage tools to local AI clients over MCP on 127.0.0.1; needs `ai.enabled`. Run **Data Lineage: Copy MCP Config** for clients outside VS Code: the config contains the access token, so the client writes it into its own config file. **Data Lineage: Rotate MCP Token** replaces it. |
| `mcp.port` | 47633 (1024–65535) | Port of the local MCP server. The first VS Code window takes it; other windows report that it is in use. |
