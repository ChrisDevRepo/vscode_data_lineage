# Features

Capabilities of Data Lineage Viz, with the VS Code settings that control them. For installation and quick start, see the [README](../README.md).

---

## Commands and entry points

The main user-facing commands are contributed in `package.json` and available through the Command Palette:

| Command | Purpose |
|---------|---------|
| **Data Lineage: Open Wizard** | Open the import wizard for `.dacpac` or live-database sources. |
| **Data Lineage: Open Demo** | Load the bundled AdventureWorks demo. |
| **Data Lineage: Search Objects** | Search loaded tables, views, procedures, and functions from a VS Code Quick Pick. |
| **Data Lineage: Settings** | Open the Data Lineage settings filter. |
| **Data Lineage: Create Parse Rules** | Scaffold a local `parseRules.yaml`. |
| **Data Lineage: Create DMV Queries** | Scaffold a local `dmvQueries.yaml`. |
| **Data Lineage: Create AI Output Templates** | Scaffold a local `aiOutputTemplates.yaml`. |
| **Data Lineage: Copy Debug Info** | Copy extension diagnostics for bug reports. |

The Data Lineage activity-bar view exposes quick actions for opening the wizard, opening the demo, and opening settings.

---

## Keyboard shortcuts

Shortcuts are scoped to the graph webview. Bare-key shortcuts are ignored while typing in inputs, textareas, or editable text, and the extension does not register VS Code global keybindings.

| Shortcut | Action |
|----------|--------|
| <kbd>/</kbd> | Focus Quick Jump |
| <kbd>F</kbd> | Fit graph to view |
| <kbd>?</kbd> | Open Help |
| <kbd>Delete</kbd> | Exclude highlighted node |
| <kbd>Esc</kbd> | Exit active trace, path, analysis, bookmark, or AI preview |
| <kbd>S</kbd> | Toggle Schema View |
| <kbd>H</kbd> | Hide/Show schema clusters |

Contextual keyboard behavior:

| Shortcut | Context |
|----------|---------|
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move through Quick Jump and path suggestions |
| <kbd>Enter</kbd> | Select a suggestion or apply the current input action |
| <kbd>Esc</kbd> | Close the active input or dropdown before broader mode exit |
| <kbd>Enter</kbd> / <kbd>Space</kbd> | Activate focused graph, sidebar, and list controls |
| <kbd>Enter</kbd> / <kbd>Space</kbd> | Expand a focused schema cluster |

The in-app Help modal renders the canonical shortcut list from `src/ui/keyboardShortcuts.ts`; update that registry whenever a webview shortcut changes.

---

## Schema View

When a loaded graph exceeds a configurable node threshold, the extension starts in **Schema View** - replacing individual object nodes with schema cluster nodes that show object counts and type distribution. At or below the threshold it starts in Object View. After that initial load decision, the toolbar **Schema View** toggle button switches between the two views; filters and exclusions do not re-check the threshold or auto-switch the view. `dataLineageViz.renderLimit` remains the only post-load safety gate for rejecting a selected visual surface that would mount too many React Flow nodes.

- Double-clicking a schema cluster expands that schema as object nodes in place.
- Selecting a schema cluster shows an on-node toolbar to **Expand** it or **Expand Only**. **Expand** keeps other expanded schemas open; **Expand Only** expands this schema and collapses the others.
- Quick Jump and Detail Search separate results into **Visible**, **In Schema Cluster**, and **Not in Current Filter**. Selecting an object in a schema cluster expands that schema without changing the active schema filter.
- Multiple schemas can be expanded at a time while the projected rendered node count stays within `dataLineageViz.renderLimit`.
- The **Clear All Filters** button also collapses all expanded schemas and returns to Schema View.
- In Expanded Schema View, schema clusters render as a filled colored tile (vs the lighter object cards) and as ringed blocks on the minimap, so the two node kinds read apart at a glance.
- Configure: `dataLineageViz.overview.enabled`, `dataLineageViz.overview.threshold`, `dataLineageViz.renderLimit`.

### Rendering limits

The extension separates **data loading** (`maxNodes`) from **graph rendering** (`renderLimit`). `@lineage` AI tools and BFS query the full loaded model while the GUI stays responsive.

| Setting | Default | Controls |
|---------|---------|----------|
| `dataLineageViz.maxNodes` | 2000 | Objects loaded from dacpac / database |
| `dataLineageViz.renderLimit` | 750 | React Flow nodes the GUI will lay out and render |
| `dataLineageViz.overview.threshold` | 150 | Above this count, new loads default to Schema View. At or below, they default to classic Object View |

When the selected surface would render more than `renderLimit` React Flow nodes, the graph shows a "limit reached" message instead of rendering that surface. Schema View and Expanded Schema View count collapsed schemas as one rendered node each, and trace/path/analysis scopes render ahead of the base full-graph limit. The full lineage model, DDL, and AI chat remain functional — only the visual surface is gated.

---

## Filters & bookmarks

### Filters

- **Schema filter** — show only selected schemas (grid icon in the toolbar).
- **Type filter** — show / hide tables, views, procedures, functions, external tables.
- **Hide isolated** — hide nodes with no dependencies in the current view.
- **Focus schema** — star a schema to highlight it and its directly connected objects.

### Bookmarks

Save the current filter state (selected schemas, types, exclusion rules) as a named bookmark. Restore from the toolbar dropdown to return to that exact view. Bookmarks are saved per project.

---

## Exclusion rules

Hide nodes from the graph using pattern-based rules. Rules apply in real time — no data reload needed.

### Three ways to add a rule

1. Open the exclusion dropdown (ban icon in toolbar) and type a pattern.
2. Right-click any node and select **Exclude from view**.
3. Select a node and press <kbd>Delete</kbd>.

### Pattern syntax

Patterns are matched against `schema.name` (case-insensitive).

| Pattern | Matches |
|---------|---------|
| `%tmp%` | Any name containing "tmp" |
| `dbo.%` | All objects in the dbo schema |
| `%_stg` | Any name ending in "_stg" |
| `^dbo\.tmp_` | Regex: starts with `dbo.tmp_` |

`%` works like SQL `LIKE`. Patterns without `%` or regex metacharacters are treated as exact matches. Exclusion rules are saved per bookmark.

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
- **Safety gating** — the trace origin is an anchor and cannot be pruned, and a prune is rejected when it would disconnect any remaining node from the origin, so the trace always stays connected. Only safe actions are offered.
- Edits layer on top of the original trace and never change your filters; re-run **Trace Levels** or press <kbd>Esc</kbd> to discard them.

Editing applies to Trace Levels results — a computed shortest path is fixed.

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

For tables, views, external tables, and TVFs, the panel shows column metadata: name, data type, nullability, primary key, foreign keys. Views and TVFs include a **Columns / DDL** toggle.

---

## Detect graph patterns

Six analysis modes from the toolbar dropdown:

| Mode | What it finds |
|------|---------------|
| **Islands** | Disconnected subgraphs — groups with no edges to the rest of the graph. |
| **Hubs** | Nodes with the highest connection count (change-risk hotspots). |
| **Orphan nodes** | Objects with zero connections — dead-code candidates. |
| **Longest path** | Deepest dependency chains source-to-sink (maximum blast radius). |
| **Cycles** | Circular dependencies that block incremental deployment. |
| **External refs** | Virtual nodes for file sources (OPENROWSET) and cross-database references. |

All structural algorithms (cycles, hubs, path-finding) are implemented on top of [graphology](https://graphology.github.io/) so that the structural results match a reference graph implementation. Click any group in the pattern sidebar to zoom into that subset.

Thresholds:

- `dataLineageViz.analysis.hubMinDegree` — minimum connections to qualify as a hub.
- `dataLineageViz.analysis.islandMaxSize` — maximum component size to qualify as an island.
- `dataLineageViz.analysis.longestPathMinNodes` — minimum chain length to report.

---

## Export

Export the current graph to a `.drawio` file with coloured nodes, directed edges, and a schema legend. The file opens directly in [diagrams.net](https://app.diagrams.net/).

---

## Table profiling

> Database import only. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) for the full SQL reference.

On-demand column statistics via a separate database connection. Profiling runs only on explicit user click — no automatic queries.

### Modes

- **Quick** — row count, null count, distinct count per column.
- **Standard** — adds AVG, STDEV, min/max values, zero / empty counts.

Standard mode can be disabled via `dataLineageViz.tableStatistics.standardModeEnabled`.

### Safety for large databases

- Tables above a configurable row threshold are **sampled** instead of fully scanned.
- **External tables** are skipped by default (they query remote data sources like S3, Blob, or other databases).
- Each query has a configurable timeout.
- Profiling lifecycle events and a 300-character SQL preview are logged to the Output channel (`View → Output → Data Lineage Viz`) at DEBUG level.

Full setting reference and SQL examples in [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

---

## `@lineage` AI (GitHub Copilot Chat)

Type `@lineage` in GitHub Copilot Chat to explore your loaded lineage graph in natural language. The assistant answers from your actual data — never from general knowledge.

### Core features vs AI-enhanced capabilities

The extension provides **object-level lineage** as its core feature — tracing dependencies between tables, views, procedures, and functions. This works deterministically from the loaded data model.

The `@lineage` assistant goes further by analysing the available metadata (DDL, column definitions, constraints) using a **Map & Router** state-machine architecture. It runs in two states:

#### 1. Discovery (chat answers, no graph)

The default state. The AI uses catalog tools (`get_context`, `search_objects`, `get_scope_bundle`, `get_object_detail`, `search_ddl`, `detect_graph_patterns`) to look up loaded scope, DDL, columns, and neighbours, then answers in chat.

- Best for direct questions like *"what does spProcA do?"* or *"what reads from the Employee table?"*.
- Single-object asks use `get_object_detail`; graph-scope asks use one bounded BFS call via `get_scope_bundle`.
- When `get_scope_bundle(include_ddl:true)` exceeds `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget`, it returns `over_discovery_budget` with a hint to initiate `start_exploration` (SM approval flow).
- Discovery cannot render a graph in the GUI; for graph rendering, multi-object analysis, or column tracing the assistant escalates.

#### 2. Sliding-Memory (graph render + deep analysis)

Triggered by an explicit user request for a graph, column tracing, or an engine-forced over-budget discovery request. Begins after the user approves the `confirm_sm_start` consent gate.

- **Map & Router**: the extension owns a topological map of the trace; the AI acts as a router that analyses one object at a time.
- **Sliding short-term memory**: after each hop the AI's one-line summary is appended to `working_memory.short_term_memory` and echoed on the next 3 hops. Local continuity without global context bloat.
- **Selection-inference routing**: every hop is driven by an AI-generated sub-question. The engine validates the requested route against the catalog *before* the visit — no hallucinated paths.

### Why it matters

In complex ETL pipelines a column often changes name several times. Deep exploration tracks this with a two-tier memory model:

- **Short-term memory (in-context)** — sliding window of the most recent node summaries, shipped every hop.
- **Detail archive (long-term)** — full technical analysis per node, stored internally, delivered only in the final synthesis phase.

### Mission types

When you ask `@lineage` a question, the assistant labels the mission as `business`, `technical`, or `both`. The label drives which capture template fires per hop and which subsection appears in the final document. See [`AI_PROMPTS.md`](AI_PROMPTS.md) for how this maps to YAML keys.

### Depth handling

For traces, the assistant picks one of three depth-enforcement modes based on your phrasing:

| Mode | When | Behaviour |
|------|------|-----------|
| `strict` | Explicit depth ("depth 2", "direct neighbours only") | Engine pauses at the cap and asks for consent before going deeper. |
| `soft` | Vague proximity ("nearby", "the direct producers") | Auto-extends one level past the declared budget; consent required beyond that. |
| `silent` | No depth signal | Auto-extends two levels to follow legitimate branches; consent required beyond that. |

`silent` is the default when no depth phrasing is detected.

### Tips

- **Column-level questions are best-effort.** The AI traces column mappings, joins, and formulas from the loaded metadata. Always verify against the database for compliance-critical claims.
- **Ask the AI to build a graph.** Try *"show me the full lineage for `dbo.udfLeadingZeros` in the app"* — it builds a filtered, annotated graph and saves it as a bookmark.
- **The assistant is context-aware.** It knows what filters are active and which schemas are visible. Ask *"what's filtered out?"*.
- **Customise output.** Command Palette → **Create AI Output Templates** scaffolds [`aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml). See [`AI_PROMPTS.md`](AI_PROMPTS.md) for what each key controls.

### Requirements

- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension.
- VS Code 1.101 or later.

### Disable

Set `dataLineageViz.ai.enabled` to `false` to remove the `@lineage` participant and all AI tools.

---

## Advanced settings

Search "dataLineageViz" in VS Code Settings (`Ctrl+,`).

### Import & SQL parsing

| Setting | Default | Purpose |
|---------|---------|---------|
| `dataLineageViz.excludePatterns` | `[]` | Permanent regex / wildcard patterns to skip objects at load time. |
| `dataLineageViz.externalRefs.enabled` | `true` | Detect virtual nodes for OPENROWSET and cross-DB 3-part names. |
| `dataLineageViz.parseRulesFile` | `""` | Path to a custom YAML file for the SQL parser. See [`PARSE_RULES.md`](PARSE_RULES.md). |
| `dataLineageViz.dmvQueriesFile` | `""` | Path to custom DMV queries. See [`DMV_QUERIES.md`](DMV_QUERIES.md). |
| `dataLineageViz.dmvQueryTimeout` | `120` | Seconds to wait for metadata catalog queries. |

### UI & layout

| Setting | Default | Purpose |
|---------|---------|---------|
| `dataLineageViz.layout.direction` | `LR` | Graph flow: `LR` (left-to-right) or `TB` (top-to-bottom). |
| `dataLineageViz.layout.edgeStyle` | `default` | Line style: `default` (smooth bezier), `smoothstep`, `step`, `straight`. |
| `dataLineageViz.layout.minimapEnabled` | `true` | Show the navigation minimap. |
| `dataLineageViz.layout.rankSeparation` | `120` | Horizontal spacing between dependency layers (px). |
| `dataLineageViz.layout.nodeSeparation` | `30` | Vertical spacing between nodes in the same layer (px). |
| `dataLineageViz.layout.edgeAnimation` | `true` | Animate edges when running a trace. |
| `dataLineageViz.layout.highlightAnimation` | `false` | Animate edges when clicking a node. |

### `@lineage` AI

| Setting | Default | Purpose |
|---------|---------|---------|
| `dataLineageViz.ai.enabled` | `true` | Enable / disable the `@lineage` participant and tools. |
| `dataLineageViz.ai.maxRounds` | `50` | Safety cap on tool turns per investigation (5–100). |
| `dataLineageViz.ai.discoveryNodeCap` | `10` | Max scope nodes the AI may pull during a single discovery-phase catalog request before escalation is forced (1–30). |
| `dataLineageViz.ai.discoveryTokenBudget` | `10000` | Max estimated DDL token budget for a single discovery-phase catalog request (1000–32000). |
| `dataLineageViz.ai.contextPayloadBudget` | `10000` | Token budget for `lineage_get_context` deciding inline-full vs summary-only catalog delivery (1000–100000). |
| `dataLineageViz.ai.outputTemplateFile` | `""` | Path to custom YAML output templates. See [`AI_PROMPTS.md`](AI_PROMPTS.md). |
| `dataLineageViz.ai.showToolInvocations` | `false` | Show each tool call as an expandable chat part with input JSON (developer debugging). |

### Table profiling

| Setting | Default | Purpose |
|---------|---------|---------|
| `dataLineageViz.tableStatistics.enabled` | `true` | Enable on-demand column statistics (quick / standard modes). |
| `dataLineageViz.tableStatistics.standardModeEnabled` | `true` | Include AVG, STDEV, min/max, zero/empty counts alongside row/null/distinct. |
| `dataLineageViz.tableStatistics.excludeExternalTables` | `true` | Skip external tables (OPENROWSET, remote sources) to avoid cross-system queries. |
| `dataLineageViz.tableStatistics.queryTimeout` | `60` | Seconds to wait for a per-table profiling query. |
| `dataLineageViz.tableStatistics.sampleThreshold` | `100000` | Row count above which the table is sampled instead of fully scanned. |
| `dataLineageViz.tableStatistics.sampleSize` | `10000` | Number of rows in the TABLESAMPLE when sampling is triggered. |
| `dataLineageViz.tableStatistics.useApproxDistinct` | `true` | Use `APPROX_COUNT_DISTINCT` for faster (±2%) distinct counts. |
| `dataLineageViz.tableStatistics.maxColumns` | `50` | Maximum columns profiled per table; wider tables are truncated. |
