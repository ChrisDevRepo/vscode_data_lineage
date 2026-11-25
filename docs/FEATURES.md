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

Case-insensitive search inside SQL bodies (views, procedures, functions) and column names (tables, external tables). Toolbar search icon. This is distinct from **Quick Jump** (<kbd>/</kbd>), which matches object names only, and from Command Palette **Data Lineage: Search Objects**, which opens a VS Code Quick Pick over loaded object names.

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

## AI chat panel

The graph view has its own chat pane, docked on the right edge. It answers lineage questions on the loaded model with the model you configure. With `dataLineageViz.ai.enabled` off, the graph shows no chat at all. Toolbar controls that do not fit beside the pane move into the **…** menu, and the graph scrolls instead of being cut off.

- **Open and use.** Click **Chat** on the right edge of the graph; drag the pane's left edge (or focus it and use the arrow keys) to resize it, **Esc** collapses it, and a running answer keeps streaming while it is collapsed. **New chat** starts a fresh conversation and stops a running answer. Closing the graph panel ends the chat the same way, so a pending approval card does not outlive its panel.
- **Commands.** Type `/` in the composer to list them. `/search` answers from the lookup tools only; `/trace` (optionally with `[schema].[table].[column]`) plans a hop-by-hop exploration; `/clear` (alias `/new`) starts a new chat, like **New chat**, with no model call.
- **Models.** `dataLineageViz.ai.models` lists OpenAI-compatible endpoints (Chat Completions or Responses) and VS Code language models (`apiType` `vscode-lm`, below). `dataLineageViz.ai.defaultModel` names the entry used first. The composer's picker offers the valid entries, and an effort picker for entries that set `supportsReasoningEffort`. An invalid entry, or a `vscode-lm` entry that matches no model, is named in a warning and not offered.
- **VS Code language models.** A model another extension provides through VS Code (the Copilot subscription, Copilot's own bring-your-own-key models, or a provider extension) works as a model entry: `{"id": "…", "name": "…", "apiType": "vscode-lm", "selector": {"vendor": "copilot", "family": "…"}, "requestBody": {"temperature": 0.1, "top_p": 1}}`. VS Code picks the first model that fits every `selector` field (`vendor`, `family`, `id`); the entry has no URL, key or `maxInputTokens` (the model reports its window). `requestBody` is sent unchanged as the model's options and `maxOutputTokens` as `max_tokens`; whether the model's provider honors them is its choice. Limits of the platform: the system prompt goes as the first user message (no system role), and structured answers use the same forced tool call as on the API path, with no JSON-schema or strict mode. The first request shows the provider's consent dialog, and its quota or billing applies. **Upgrade default:** the picker also lists the models VS Code provides and, with `ai.defaultModel` empty, starts on the last one you picked, else on a Copilot model, else on the first entry; these live models send no options, as `@lineage` did in 1.2.x. A set `ai.defaultModel` wins the start model, and the live models stay in the picker. With no entry and no model, the chat shows the no-model message and **Add model**.
- **Manage models.** With no model configured the chat shows **Add model**; with models, the picker's **Manage models…** row opens the same menu. **Data Lineage: Add AI Model** walks you through a provider preset (OpenAI, OpenRouter, Ollama, LM Studio or any OpenAI-compatible endpoint), the base URL, model name, API key and a display name, then sends one short request to test the connection before it saves the entry; a failed test saves nothing and offers **Edit**, or **Save and open settings.json** to keep the entry as it is and fix it there. The entry is written with the preset's API type (Chat Completions otherwise), default token limits and, for every Chat Completions entry, the sampling `requestBody` `{"temperature":0.1,"top_p":1}` (the OpenAI Responses preset gets none); the saved message offers **Open settings.json** to change them or add `requestBody` and other settings, which an edit keeps as stored. The source **VS Code language model** instead lists the models VS Code provides (name, vendor, family, input window), asks for a display name and saves a `vscode-lm` entry with `requestBody` `{"temperature":0.1,"top_p":1}`; it asks for no key and sends no test request. **Edit AI Model**, **Remove AI Model** (also deletes the key) and **Update AI Model Key** work like the Database Connection commands. The commands write the `ai.models` setting in your user settings; you can still edit it by hand.
- **API keys.** The key is stored in VS Code's secret storage under the entry id, by **Add AI Model**, **Edit AI Model** (leave the key empty to keep it; changing the base URL asks for it again) or **Update AI Model Key**. A key is never in settings, logs or the webview.
- **Approval.** Before a hop-by-hop exploration reads any object, an approval card shows the plan, with **Show full plan (N objects)** for the full list: **Approve**, **Refine** (describe the change, then **Send change**) or **Cancel**. When the exploration replaces the analysis shown now, the card says so.
- **Token guard.** A question whose discovery would pull more than `ai.discoveryNodeCap` objects or `ai.discoveryTokenBudget` tokens of DDL is not answered directly; it is offered as a hop-by-hop exploration for your approval.
- **Follow-up buttons.** **Start deeper hop-by-hop analysis** (when an exploration is offered), **Next questions and related objects** (after a completed answer) and **Show full description** (when the answer has a longer description).
- **Output templates.** **Data Lineage: Create AI Output Templates** scaffolds [`aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml), which controls the summary, badges and notes. See [`AI_PROMPTS.md`](AI_PROMPTS.md).

What a model reads (the SQL and metadata the tools return) is sent to the endpoint of the entry used, including for a local DACPAC. To turn the chat panel off, set `dataLineageViz.ai.enabled` to `false` and reload the window.

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
| `ai.enabled` | on | Turns the chat panel and its tools on or off. Reload the window after changing it. |
| `ai.maxRounds` | 50 (5–100) | Rounds per deep analysis, one for each procedure, view or function it reads. An analysis that needs more is not started. |
| `ai.maxTraceColumns` | 10 (min 1) | Starting columns one column trace may follow. A trace that selects more is not started. |
| `ai.discoveryNodeCap` | 10 (1–30) | Scope nodes a discovery answer may pull in one request before it is offered as a deep analysis for approval. |
| `ai.discoveryTokenBudget` | 10000 (1000–32000) | Estimated DDL tokens for one discovery request, capped at one eighth of the selected model's input window. Exceeding it or the node cap offers a deep analysis for approval. |
| `ai.outputTemplateFile` | empty | Custom output templates YAML; empty uses the built-in templates. Scaffold with **Data Lineage: Create AI Output Templates**; keys in [`AI_PROMPTS.md`](AI_PROMPTS.md). |
| `ai.models` | empty list | OpenAI-compatible endpoints (Chat Completions or Responses) or VS Code language models, one entry each. A `vscode-lm` entry has `id`, `name`, `apiType` `vscode-lm`, `selector` (`vendor`, `family`, `id`, each optional), optional `maxOutputTokens` (sent as `max_tokens`) and `requestBody` (sent unchanged as the model's options); no `url`, key or `maxInputTokens`. An API entry has: `id`, `name`, `url`, `model`, `apiType`, `maxInputTokens`, `maxOutputTokens` (sent as the output cap; a `max_tokens` or `max_completion_tokens` in `requestBody` overrides it on Chat Completions), optional `supportsReasoningEffort`, `reasoningEffort`, `forcedToolChoice`, `requestBody` (extra parameters, sent unchanged) and `requestHeaders`. An invalid entry is named and not offered. Keys are never settings: they are stored by **Add AI Model** or **Update AI Model Key**. |
| `ai.defaultModel` | empty | The `id` of the `ai.models` entry used by default. The chat always lists the language models VS Code provides too; empty: it starts on your last pick, else on a Copilot model. |
