# Features

Capabilities of Data Lineage Viz, with the VS Code settings that control them. For installation and quick start, see the [README](../README.md).

---

## Commands and entry points

Open the Command Palette and filter for **Data Lineage**. Commands cover data
loading and refresh, object search, settings, customization-file scaffolding,
AI graph results, and diagnostics. The current command names and descriptions
are maintained in `package.json`; the activity-bar view exposes the common
loading and settings actions.

---

## Database connections

Choose the connection provider with `dataLineageViz.database.connectionProvider`: `mssqlExtension` (default) uses the SQL Server extension, and `builtIn` uses connections saved by Data Lineage. Built-in connections support SQL login or Microsoft Entra ID; passwords stay in VS Code secret storage. Entra sign-in uses VS Code's Microsoft account picker and supports MFA; the selected account and tenant are saved with the connection. Built-in Windows authentication is not supported.

Manage connections through **Data Lineage: Add / Edit / Remove Database Connection** and **Update Database Password** in the Command Palette. Enter the database name directly; a database-scoped login may not be able to list databases.

Projects reconnect through the selected provider. A project saved with the other provider displays an explanation before opening the selected provider's connection picker. If the MSSQL extension is unavailable, the import screen offers switching to the built-in provider.

Import queries are documented in [`DMV_QUERIES.md`](DMV_QUERIES.md). For connection errors, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#import-and-connection).

---

## Keyboard shortcuts

All shortcuts are local to the graph webview — the extension registers no VS Code
global keybindings, so none of these can conflict with your editor bindings.

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

Bare-key shortcuts are ignored while typing in inputs, textareas, or editable text,
and never fire with a Ctrl, Cmd, or Alt modifier. <kbd>Esc</kbd> cascades: it closes
the active input, dropdown, or help panel first, then exits one graph mode per press
(AI preview → bookmark → analysis → trace). Press <kbd>?</kbd> in the webview for the
same list in the app.

Menus and popups follow the standard keyboard pattern:

- **Right-click menus** on a node or schema cluster, and the **Graph Analysis** menu, take
  focus when they open. <kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Home</kbd>/<kbd>End</kbd> move
  between items, <kbd>Enter</kbd> runs one, <kbd>Esc</kbd> closes.
- **Toolbar popups** (Schema, Type and External refs filters, Bookmarks, Exclusion rules) move
  focus into the popup and return it to their button on <kbd>Esc</kbd>. A whole filter row is
  clickable, not only its checkbox.
- **Help** is a modal dialog: focus stays inside while it is open and the first <kbd>Esc</kbd>
  closes it.
- An inline delete or leave confirmation moves focus to **Cancel**, so <kbd>Enter</kbd> never
  confirms a destructive action by accident.

---

## Schema View

When a loaded graph exceeds a configurable node threshold, the extension starts in **Schema View** - replacing individual object nodes with schema cluster nodes that show object counts and type distribution. At or below the threshold it starts in Object View. After that initial load decision, the toolbar **Schema View** toggle button switches between the two views; filters and exclusions do not re-check the threshold or auto-switch the view. `dataLineageViz.renderLimit` remains the only post-load safety gate for rejecting a selected visual surface that would mount too many React Flow nodes.

- Double-clicking a schema cluster expands that schema as object nodes. By default (`expandOnly`) the clicked schema becomes the only expanded one; set `dataLineageViz.overview.schemaDoubleClickBehavior` to `expand` to add it alongside schemas already expanded.
- Selecting a schema cluster shows an on-node toolbar to **Expand** it or **Expand Only**. **Expand** keeps other expanded schemas open; **Expand Only** expands this schema and collapses the others.
- Quick Jump and Detail Search separate results into **Visible**, **In Schema Cluster**, and **Not in Current Filter**. Selecting an object in a schema cluster expands that schema without changing the active schema filter.
- Multiple schemas can be expanded at a time while the projected rendered node count stays within `dataLineageViz.renderLimit`.
- **Refresh View** resets the schema, type, and focus schema filters (exclusion rules and the Hide Isolated toggle persist), collapses expanded schemas, and re-applies the initial Object View / Schema View decision.
- In Expanded Schema View, schema clusters render as a filled colored tile (vs the lighter object cards) and as ringed blocks on the minimap, so the two node kinds read apart at a glance.
- Configure: `dataLineageViz.overview.enabled`,
  `dataLineageViz.overview.threshold`,
  `dataLineageViz.overview.schemaDoubleClickBehavior`, and
  `dataLineageViz.renderLimit`.

### Rendering limits

The extension separates the **webview working graph** (`maxNodes`) from **React Flow rendering** (`renderLimit`). `@lineage` queries the complete loaded model even when rendering is capped. A selection over `maxNodes` is refused and not loaded at all — neither the graph nor `@lineage` sees it.

| Setting | Controls |
|---------|----------|
| `dataLineageViz.maxNodes` | Objects (including virtual external-reference nodes) admitted to the webview working graph |
| `dataLineageViz.renderLimit` | React Flow nodes the GUI will lay out and render |
| `dataLineageViz.overview.threshold` | Whether a new load starts in Schema View or Object View; a threshold above `renderLimit` is treated as `renderLimit` |

A selection whose object count exceeds `maxNodes` is refused outright — nothing is loaded or rendered, the prior view stays, and an error names the count, the limit, and the setting. It is never silently truncated. When a selection within `maxNodes` would still render more than `renderLimit` React Flow nodes, the graph shows a *Render limit reached* notice instead of drawing it. The notice says to reduce filter scope or adjust VS Code settings, and it has no button. A trace, path, analysis, or AI preview is counted by its own size and shows the same notice. Schema View and Expanded Schema View count each collapsed schema as one node. The full lineage model, DDL, and AI chat remain functional — only the visual surface is gated.

Lines scale with the graph: up to about 100 rendered edges they keep full color and width; above that they fade and thin gradually, reaching their floor at 2,000 edges, so a dense graph reads as density rather than solid ink. The fade is stronger in dark themes, where the same line color stands out more, and off in high-contrast themes. Highlighted and route lines keep full emphasis.

---

## Filters & bookmarks

### Filters

- **Schema filter** — show only selected schemas (grid icon in the toolbar).
- **Type filter** — show / hide tables, views, procedures, functions, external tables.
- **Hide isolated** — hide nodes with no dependencies in the current view.
- **Focus schema** — star a schema to show it together with schemas connected to it by at least one dependency.

### Bookmarks

Save the current filter state as a named bookmark. Bookmarks retain schema, object-type, isolation, external-reference, focus, and exclusion choices; trace, analysis, path, and AI views can also be saved as bounded bookmarks. Restore them from the toolbar dropdown. Bookmarks are saved per project.

#### AI bookmarks keep the run's memory

Saving a bookmark from an AI-authored view also stores the exploration behind it: the question the
run started from, the start object, every per-object finding and the decision that produced it, the
objects the run pruned, the questions it left open, and a content hash of each in-scope object's DDL
at save time.

With that bookmark applied, `@lineage` can recall the run instead of repeating it — what the run
found about a named object, which objects it pruned and why, and which questions it left open. Each
recalled finding describes the object as it was at run time, so an object whose DDL has changed
since is reported as stale and the assistant confirms it against the current definition before
answering.

The record lives with the bookmark: deleting the bookmark or its project deletes it, updating the
bookmark keeps it (only a save from a newer AI view replaces it), and a bookmark saved by an
earlier build simply has no run to recall. Each exploration approved in a chat keeps its own run, so
a bookmark recalls the exploration it was saved from even after the same chat goes on to approve
another; a damaged run record is treated the same as none and the recall falls back to repeating the
work instead of answering from bad data.

---

## Exclusion rules

Hide nodes from the graph using pattern-based rules. Rules apply in real time — no data reload needed.

To hide objects on every load, list the same patterns in `dataLineageViz.excludePatterns`. That setting is applied when a source is opened and takes effect after the data source is reloaded.

### Three ways to add a rule

1. Open the exclusion dropdown (ban icon in toolbar) and type a pattern.
2. Right-click any node and select **Exclude from view**.
3. Select a node and press <kbd>Delete</kbd>.

### Pattern syntax

Patterns are case-insensitive JavaScript regular expressions matched against both `schema.name` and the object's full name. `%` is translated to `.*` before the expression is compiled.

| Pattern | Matches |
|---------|---------|
| `%tmp%` | Any name containing "tmp" |
| `dbo.%` | All objects in the dbo schema |
| `%_stg$` | Any name ending in "_stg" |
| `^dbo\.tmp_` | Regex: starts with `dbo.tmp_` |

Because the input remains a regular expression, escape characters such as `.` when you need a literal match and use `^` / `$` to anchor an exact name. Exclusion rules are saved per bookmark.

---

## Trace & path finding

### Trace levels

Right-click a node and select **Trace Levels** to explore upstream (inputs) or downstream (outputs) dependencies. The graph filters to the discovered subgraph.

- Adjust trace depth with the level controls.
- Default depth is configurable: `dataLineageViz.trace.defaultUpstreamLevels`, `dataLineageViz.trace.defaultDownstreamLevels`.
- Press <kbd>Esc</kbd> to exit trace mode.

### Edit a trace

After running **Trace Levels**, refine the result directly on the graph without re-running it:

- **Add a neighbour** — the **+** control on a node pulls in one of its direct upstream/downstream neighbours that the trace did not already include.
- **Prune a node** — the **−** control drops a node from the current trace scope.
- **Safety gating** — the trace origin is an anchor and cannot be pruned. A pruned node leaves together with the branch that hangs only on it, so the trace always stays connected.
- Edits layer on top of the original trace and never change your filters; re-run **Trace Levels** or press <kbd>Esc</kbd> to discard them.

Editing applies to Trace Levels results — a computed shortest path is fixed.

### Trace navigator

A trace opens with the whole graph visible and nothing dimmed; the navigator starts folded to a button at the top left, beside the legend. Opened, it lists the trace as a tree in a compact top-left card that is only as tall as its rows, and the graph is refitted beside it:

- **Starting point** — the panel title (L0); click it to clear the selection and fit the whole trace. Its tooltip lists the row gestures.
- **Upstream / Downstream** — fixed sections of hop levels (L1, L2, …); each object's type symbol carries its schema color, as on the canvas and in the legend. Deeper levels start collapsed on large traces; **Expand all** / **Collapse all** in the title bar open or close every level. The **+** on a section loads one more level on that side; its tooltip shows how many nodes it adds.
- **Click a node** — lights only the route between the starting point and that node — every path connecting them, so both branches of a diamond — animates just those edges and fits the view to the route.
- **Check nodes** — each checkbox, or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+click on a row, adds that node's route: the graph shows only the routes to the checked nodes, on any level and either side, with every route edge animated and the view fitted to all of them. Rows hidden from the graph stay listed, dimmed, and can be checked to add their route. **Show all** restores the trace.
- **Hide** — the panel's close button folds it back to the button beside the legend; click it to reopen. The choice holds for later traces in the session.
- **Trim** — right-click a node and choose **Remove from trace** to remove it and the branch that hangs only on it. **Reset** beside the edit summary restores the starting scope.
- **Find** — the magnifier in the title bar, or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>F</kbd> inside the panel, opens it; it jumps between matches and opens collapsed levels, and <kbd>Esc</kbd> closes it. Objects reached from neither side are listed under **Connected**.

### Find path

Right-click a node, select **Find Path**, then click a second node. The extension highlights the deterministic shortest dependency path between them.

---

## Detail search

Full-text search inside SQL bodies (procedures, views, functions) and column definitions. Toolbar search icon. This is distinct from **Quick Jump** (<kbd>/</kbd>), which matches object names only, and from Command Palette **Data Lineage: Search Objects**, which opens a VS Code Quick Pick over loaded object names.

---

## Node details

Right-click a node and select **Show Details** to open the detail bar at the bottom.

- **In / Out** — count of connected input / output nodes (hover for the full list).
- **Unresolved** — references not found in the data source (dynamic SQL, cross-server references).
- **Excluded** — nodes hidden by your exclusion patterns.

For tables, views, external tables, and TVFs, the panel shows available column metadata: name, data type, nullability, primary key, and source-provided constraints. Views and TVFs include a **Columns / DDL** toggle. Live-database constraint rows are not currently attached to the detail model; see [`DMV_QUERIES.md`](DMV_QUERIES.md).

---

## Detect graph patterns

The analysis dropdown finds disconnected groups, hubs, unconnected objects,
long dependency paths, cycles, and external references. Select a result group
to focus the graph on that subset.

The structural algorithms use
[graphology](https://graphology.github.io/). Their thresholds are configurable
under **Data Lineage** settings.

---

## Export

Export the current graph to a `.drawio` file with coloured nodes, directed edges, and a schema legend. The file opens directly in [diagrams.net](https://app.diagrams.net/).

---

## Table profiling

> Database import only. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) for operational details and limitations.

On-demand column statistics via a separate database connection. Profiling runs only on explicit user click — no automatic queries.

### Modes

- **Quick** — row count, null count and distinct count per column, plus the completeness and uniqueness percentages derived from them.
- **Standard** — adds min/max, AVG and STDEV for numeric columns, min/max for dates, string length and empty-string counts, and a zero count on nullable numeric columns.

Standard mode can be disabled via `dataLineageViz.tableStatistics.standardModeEnabled`.

### Safety for large databases

- Tables above a configurable row threshold are **sampled** instead of fully scanned.
- **External tables** are skipped by default (they query remote data sources like S3, Blob, or other databases).
- Each query has a configurable timeout.
- Profiling lifecycle events are logged to the Output channel (`View → Output → Data Lineage Viz`) at INFO level; the bounded SQL preview is logged at DEBUG level.

Full setting reference and SQL examples in [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

---

## `@lineage` AI

Type `@lineage` in VS Code Chat to explore your loaded lineage graph in natural
language. VS Code supplies the model selected for the request; GitHub Copilot
is one supported language-model provider. The assistant is instructed and
mechanically constrained to the loaded model.

### Core features vs AI-enhanced capabilities

The extension provides **object-level lineage** as its core feature — tracing dependencies between tables, views, procedures, and functions. This works deterministically from the loaded data model.

The `@lineage` assistant goes further by analysing available DDL, column
definitions, and constraints. The extension owns scope, approval gates, route
validation, retries, and termination; the selected model does not own process
state.

VS Code supplies exactly the model the user selected for that chat request,
including a native or BYOK model exposed by the host. The extension does not
select, replace, or fall back to another model.

The user-visible flow has the following paths:

#### Discovery (chat answers, no graph)

The default state. The AI uses snapshot catalog tools to inspect loaded scope, DDL, columns, neighbours, and graph patterns, then answers in chat.

- Best for direct questions like *"what does spProcA do?"* or *"what reads from the Employee table?"*.
- `/search` pins this path deterministically, skipping the entry-detection model call. `/trace` pins the deep-analysis path below.
- Discovery scope is bounded by `dataLineageViz.ai.discoveryNodeCap` and `dataLineageViz.ai.discoveryTokenBudget` (further capped at one eighth of the selected model's input window); over-budget requests are redirected to the approval-gated deep-analysis path.
- Before approval, deep analysis must fit `dataLineageViz.ai.maxRounds` and, for column traces, `dataLineageViz.ai.maxTraceColumns`. If it exceeds either limit, chat names the setting and asks you to narrow the scope or raise the limit. See the [settings reference](#settings-reference) for how rounds and columns are counted.
- An explicit graph/render request is answered by discovery like any other question; the picture itself is the separate bounded preview below, reached by follow-up, not deep analysis.

#### Bounded graph preview

Triggered by the **Show graph preview** follow-up. The assistant resolves a
finite scope and opens an **AI Preview** in
the side panel. The preview is transient; use **Save as Bookmark** to retain it.
**Data Lineage: Show AI Trace in Graph** (Command Palette) re-opens the session's
current AI-authored view in the graph panel.

#### Detail view in an AI preview

When a run records column findings, the preview offers an **Objects / Detail** switch.
Detail shows traced columns and their connections, with procedures and scalar
functions as transformation hubs. Objects without traced columns stay visible as
plain boxes, joined by dashed object-level edges. Hover a column to highlight its thread; hover
a transform chip to read its explanation. AI badges and notes carry over from
Objects view, and layout uses the same direction and spacing settings.

These mappings are best-effort AI findings. Verify them against the database for
compliance-critical claims.

#### Deep analysis

Triggered by `/trace`, a named-column trace, the **Start deeper hop-by-hop
analysis** follow-up, or a discovery request that exceeds the configured
budget. It begins only after the user approves the consent gate.

- The proposal summarizes depth, scope, tracing mode, columns, and exclusions. **Show full plan** lists the complete plan and every in-scope object.
- Choose **Approve & Proceed**, **Change scope**, or **Cancel**, or reply in plain language. **Change scope** returns you to chat to revise the proposal.
- The extension walks the approved scope one object at a time and validates routes against the loaded catalog. Chat shows a hop counter and a short finding as each hop completes.

### Mission types

When you ask `@lineage` a question, the assistant labels the mission as `business`, `technical`, or `both`. The label drives which capture template fires per hop and which subsection appears in the final document. See [`AI_PROMPTS.md`](AI_PROMPTS.md) for how this maps to YAML keys.

### Depth handling

The approval gate shows upstream and downstream depths separately; zero disables
that direction. An explicit level count is a hard boundary. If you leave depth
unstated, the assistant chooses a starting depth and may explore further within
the approved schema and exclusion boundaries. “All” starts with the full reachable
scope. GUI `trace.default*Levels` settings do not control AI depth.

Review these boundaries before approving and use **Change scope** to revise them.
Objects beyond a stated depth or schema boundary can appear as follow-up leads.
A follow-up naming one object brings in that object, rather than its entire schema.

### Tips

- Ask for a graph preview, for example *"show me the lineage for `dbo.udfLeadingZeros` in the app"*. The preview is transient; save it to keep a bookmark.
- With a trace, graph analysis or bookmark applied, the assistant sees the screen; type `#lineageView` to attach it explicitly.
- The graph is a normal editor tab: drag, split or **Move Editor into New Window**. Chat docks via **View: Move Chat**; the AI report header has a dock menu (left, bottom, right).
- **Data Lineage: Create AI Output Templates** scaffolds [`aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml); see [`AI_PROMPTS.md`](AI_PROMPTS.md).

### Requirements

- A VS Code version allowed by `engines.vscode` in `package.json`.
- A VS Code Language Model Chat provider, such as
  [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
  or a compatible BYOK provider.

### Disable

Set `dataLineageViz.ai.enabled` to `false` to disable the `@lineage` participant and all AI tools:
nothing registers and nothing can execute, and the manifest's `when` clauses hide the participant
and the tools from the chat and tool pickers. Reload the window after changing the setting so the
registration follows it. The [MCP server](#mcp-server) has its own switch, `dataLineageViz.mcp.enabled`, and is off by
default.

---

## MCP server

A local [Model Context Protocol](https://modelcontextprotocol.io) server lets external AI apps on the same machine query the loaded project's lineage metadata. It is separate from `@lineage`. Off by default; `dataLineageViz.mcp.enabled` is a kill switch (while off, no MCP code loads).

1. Run **Data Lineage: Toggle MCP Server** (or set `dataLineageViz.mcp.enabled`) and reload the window when asked. The server listens on `http://127.0.0.1:39217/mcp` (`mcp.port`) while the extension is active. Turning it off stops the server at once and revokes its token.
2. Open a project in the Data Lineage panel; the tools answer about the loaded model.
3. Run **Data Lineage: Copy MCP Client Configuration** and paste the result into the app's MCP settings: `mcpServers` JSON with URL and `Authorization` header (HTTP), or a command that runs the bundled stdio proxy with VS Code's own runtime (stdio; no token in the configuration).

**Tools:** object search, object detail with DDL, scope (BFS) with optional DDL, DDL search, graph patterns, context and screen state, and **present_result**. A scope call returns a `scope_id`; `present_result` with it draws the scope and returns a `view_id`; a later `present_result` with the `view_id` edits the view with `prune_node_ids` and `add_node_ids`. There is no approval card or hop-by-hop analysis; those stay in `@lineage`. Scope sizes follow `ai.discoveryNodeCap` and `ai.discoveryTokenBudget`. **present_result** is refused while a `@lineage` turn runs.

A rejected call is a tool execution error whose text says what to send instead; `structuredContent` carries `{code, reason, hint, issuePaths}`. The `#lineage_*` tools other VS Code agents call report rejections the same way.

**Security:** `127.0.0.1` only; every request needs the bearer token (wrong token: `401` challenge); non-localhost `Host` or `Origin` is refused. Each endpoint start generates a session-owned token kept in memory. The stdio proxy reads it from a user-only discovery file in the session's private storage directory. Turning the server off or closing the session stops the endpoint; closing the session removes its private directory. Copy client configuration again after a window reload or endpoint restart. The tools read loaded metadata only and never execute SQL.

**Single session:** this window owns its endpoint and client configuration. An occupied port reports a startup error; there is no automatic takeover. **Remote windows** (SSH, WSL, Dev Container): the server runs on the remote host, only HTTP configurations are offered.

---

## Advanced settings

Run **Data Lineage: Settings** or search "dataLineageViz" in VS Code Settings. The Settings UI and
`contributes.configuration` section of `package.json` are the source of truth
for current defaults, ranges, and descriptions; the Settings text stays short and links here for detail.
Controls are grouped around import/parsing, database connection, table statistics, graph layout,
trace/analysis, and `@lineage`.

Settings that apply only after the data source is reloaded: `maxNodes`, `excludePatterns`,
`externalRefs.enabled`, `parseRulesFile` and `dmvQueriesFile`. `ai.enabled` applies after a window reload;
the other `ai.*` limits are read on every request.

Customization contracts are documented separately:

- [`PARSE_RULES.md`](PARSE_RULES.md) for SQL extraction rules;
- [`DMV_QUERIES.md`](DMV_QUERIES.md) for live-import queries;
- [`AI_PROMPTS.md`](AI_PROMPTS.md) for AI output templates; and
- [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) for profiling behavior.

For temporary AI diagnostics, run **Data Lineage: Enable AI Trace Logging for
This Session** from the Command Palette. Logging stops when the extension host
restarts. An open workspace folder is required; the trace is saved under its
`tmp/lm-trace/` directory and the exact file path is shown in a notification.
The file includes sanitized provider-error records for failed model requests, so
the command does not open or change VS Code's output-channel log-level picker.
The diagnostics can contain schema, table, column, SQL, prompt, response, and
tool-payload text; never commit them and review them before sharing.

### Settings reference

Defaults and ranges below match `package.json`; the Settings UI shows the short form of each description.

#### Import and parsing

| Setting | Default | Detail |
|---|---|---|
| `maxNodes` | 2000 (10–5000) | Objects, including virtual external-reference nodes, admitted to the working graph. A selection over the limit is refused with an error that names the count, the limit and the setting; nothing is loaded. Select fewer schemas or raise the limit; a larger working graph takes longer to load. See [Rendering limits](#rendering-limits). |
| `renderLimit` | 750 (100–1500) | Nodes drawn at once. Above it, the graph shows a *Render limit reached* notice instead of drawing, which keeps the webview responsive on very large graphs. See [Rendering limits](#rendering-limits). |
| `excludePatterns` | `[]` | Case-insensitive regular expressions, matched against `schema.name` and the full name; `%` is a wildcard. Applied when a source is opened. For filtering without a reload use the toolbar exclusion rules ([Exclusion rules](#exclusion-rules)). |
| `externalRefs.enabled` | on | Detects references that are not catalog objects — `OPENROWSET` file paths and cross-database three-part names — and draws them as virtual external nodes. Off creates none. External Tables are catalog objects and are unaffected. |
| `overview.enabled` | on | Allows Schema View. Off keeps every load in Object View and hides the Schema View toggle. See [Schema View](#schema-view). |
| `overview.threshold` | 150 (10–1000) | Object count above which a new load starts in Schema View; at or below it the graph starts in Object View. Values above `renderLimit` count as `renderLimit`. Checked on load and on **Refresh View**, then the toolbar toggle decides. |
| `overview.schemaDoubleClickBehavior` | `expandOnly` | `expand` adds the double-clicked schema to the expanded schemas; `expandOnly` makes it the only expanded one. |
| `parseRulesFile` | empty | Custom parse rules YAML; empty uses the built-in rules. Scaffold with **Data Lineage: Create Parse Rules**; contract in [`PARSE_RULES.md`](PARSE_RULES.md). Applies after reload. |

#### Database connection

| Setting | Default | Detail |
|---|---|---|
| `database.connections` | `[]` | Database connections; application-scoped. See [Database connections](#database-connections). Each entry: server, port, database, `sqlLogin` or `entraId`, user, tenant, encryption. Passwords are kept in VS Code secret storage under `dataLineageViz.database.password.<id>`. Manage entries with **Add / Edit / Remove Database Connection**; replace a password with **Update Database Password**. Hand-editing the JSON is not needed. |
| `dmvQueryTimeout` | 120 s (10–600) | Time allowed per metadata query; raise for large databases. |
| `dmvQueriesFile` | empty | Custom DMV queries YAML; empty uses the built-in queries. Scaffold with **Data Lineage: Create DMV Queries**; contract in [`DMV_QUERIES.md`](DMV_QUERIES.md). The file is read at each import; no reload needed. |

#### Table statistics

Database import only; behavior and limits in [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

| Setting | Default | Detail |
|---|---|---|
| `tableStatistics.enabled` | on | Shows column statistics and row counts in the table design viewer. |
| `tableStatistics.standardModeEnabled` | on | Offers Standard mode (adds MIN/MAX, string length range, AVG, STDEV, zero and empty counts). Off leaves Quick mode, which runs lighter queries. |
| `tableStatistics.excludeExternalTables` | on | Skips external tables, which query remote sources (S3, Blob, other databases) and can be slow and costly. |
| `tableStatistics.queryTimeout` | 60 s (10–600) | Time allowed per profiling query. |
| `tableStatistics.sampleThreshold` | 100000 (0–999999999) | Row count above which a table is sampled instead of fully scanned; `0` always samples. |
| `tableStatistics.sampleSize` | 10000 (100–1000000) | Rows sampled on large tables. |
| `tableStatistics.useApproxDistinct` | on | Uses `APPROX_COUNT_DISTINCT` instead of exact `COUNT(DISTINCT)`: much faster, about 2% error. Requires SQL Server 2019 or later; turn off on older versions. |
| `tableStatistics.maxColumns` | 50 (1–500) | Columns profiled per table; the rest are skipped, which keeps queries on wide tables bounded. |

#### Layout, trace and analysis

| Setting | Default | Detail |
|---|---|---|
| `layout.direction` | `LR` | `LR` left to right, `TB` top to bottom. |
| `layout.edgeStyle` | `default` | `default` bezier curves, `smoothstep` rounded steps, `step` sharp steps, `straight` straight lines. |
| `layout.edgeAnimation` | on | Animates edges while a trace runs. |
| `layout.highlightAnimation` | off | Animates edges when a node is clicked. |
| `layout.minimapEnabled` | on | Shows the minimap. |
| `layout.rankSeparation` | 120 px (20–300) | Gap between dependency layers; horizontal in `LR`, vertical in `TB`. |
| `layout.nodeSeparation` | 30 px (10–200) | Gap between nodes within a layer. |
| `trace.defaultUpstreamLevels` | 3 (0–99) | Levels of inputs a trace starts with. |
| `trace.defaultDownstreamLevels` | 3 (0–99) | Levels of outputs a trace starts with. |
| `analysis.hubMinDegree` | 8 (1–50) | Connections an object needs to be listed as a hub. |
| `analysis.islandMaxSize` | 500 (2–1000) | Largest connected group reported as an island; lower it (for example 5) to list only small isolated groups. |
| `analysis.longestPathMinNodes` | 5 (2–50) | Objects a chain needs to appear in longest-path analysis. |

#### `@lineage`

| Setting | Default | Detail |
|---|---|---|
| `ai.enabled` | on | Registers the `@lineage` participant and the AI tools; see [Disable](#disable). Reload the window after changing it. |
| `ai.maxRounds` | 50 (5–100) | Rounds per deep analysis, one for each procedure, view or function it reads; a table counts only where the analysis reads it itself. An analysis that needs more is not started and the chat says so. |
| `ai.maxTraceColumns` | 10 (min 1) | Starting columns one column trace may follow; columns picked up along the way are not counted. A trace that selects more is not started and the chat names the limit. |
| `ai.discoveryNodeCap` | 10 (1–30) | Scope nodes a discovery answer may pull in one request before it is offered as a deep analysis for approval. |
| `ai.discoveryTokenBudget` | 10000 (1000–32000) | Estimated DDL tokens for one discovery request, further capped at one eighth of the selected model's input window. Exceeding it or the node cap offers a deep analysis for approval. |
| `ai.outputTemplateFile` | empty | Custom output templates YAML controlling summary, description, badges, highlights and notes; empty uses the built-in templates. Scaffold with **Data Lineage: Create AI Output Templates**; keys in [`AI_PROMPTS.md`](AI_PROMPTS.md). |

The `ai.*` limits are read on every request.

#### MCP server

| Setting | Default | Detail |
|---|---|---|
| `mcp.enabled` | off | Kill switch for the MCP server on `127.0.0.1`; see [MCP server](#mcp-server). While off, no MCP code loads; turning it on applies after a window reload. Machine scope: a workspace cannot turn it on. |
| `mcp.port` | 39217 (1024–65535) | Local port of the MCP server. |
