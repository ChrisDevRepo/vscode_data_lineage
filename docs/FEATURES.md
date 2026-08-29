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
| <kbd>Delete</kbd> | Exclude the selected node from the view |
| <kbd>Esc</kbd> | Close active input, then exit the current mode |
| <kbd>Enter</kbd> | Select a suggestion or apply the focused action |

Bare-key shortcuts are ignored while typing in inputs, textareas, or editable text,
and never fire with a Ctrl, Cmd, or Alt modifier. <kbd>Esc</kbd> cascades: it closes
the active input, dropdown, or help panel first, then exits one graph mode per press
(AI preview → bookmark → analysis → trace). Press <kbd>?</kbd> in the webview for the
same list in the app.

---

## Schema View

When a loaded graph exceeds a configurable node threshold, the extension starts in **Schema View** - replacing individual object nodes with schema cluster nodes that show object counts and type distribution. At or below the threshold it starts in Object View. After that initial load decision, the toolbar **Schema View** toggle button switches between the two views; filters and exclusions do not re-check the threshold or auto-switch the view. `dataLineageViz.renderLimit` remains the only post-load safety gate for rejecting a selected visual surface that would mount too many React Flow nodes.

- Double-clicking a schema cluster expands that schema as object nodes in place.
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

The extension separates the **webview working graph** (`maxNodes`) from **React Flow rendering** (`renderLimit`). `@lineage` queries the complete host snapshot while the GUI stays responsive.

| Setting | Controls |
|---------|----------|
| `dataLineageViz.maxNodes` | Objects admitted to the webview working graph and its virtual-node budget |
| `dataLineageViz.renderLimit` | React Flow nodes the GUI will lay out and render |
| `dataLineageViz.overview.threshold` | Whether a new load starts in Schema View or Object View |

When the selected surface would render more than `renderLimit` React Flow nodes, the graph shows a "limit reached" message instead of rendering that surface. Schema View and Expanded Schema View count collapsed schemas as one rendered node each, and trace/path/analysis scopes render ahead of the base full-graph limit. The full lineage model, DDL, and AI chat remain functional — only the visual surface is gated.

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

The record lives with the bookmark: deleting the bookmark deletes it, and a bookmark saved by an
earlier build simply has no run to recall.

---

## Exclusion rules

Hide nodes from the graph using pattern-based rules. Rules apply in real time — no data reload needed.

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
| `%_stg` | Any name ending in "_stg" |
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

The default state. The AI uses read-only catalog tools to inspect loaded scope, DDL, columns, neighbours, and graph patterns, then answers in chat.

- Best for direct questions like *"what does spProcA do?"* or *"what reads from the Employee table?"*.
- `/search` pins this path deterministically, skipping the entry-detection model call. `/trace` pins the deep-analysis path below.
- Discovery scope is bounded by `dataLineageViz.ai.discoveryNodeCap` and `dataLineageViz.ai.discoveryTokenBudget`; over-budget requests are redirected to the approval-gated deep-analysis path.
- During approved deep analysis, total scope growth is bounded by `dataLineageViz.ai.explorationNodeCap` and `dataLineageViz.ai.explorationTokenBudget`; an over-budget hop submission is held and rejected with a hint to prune, defer, or synthesize.
- An explicit graph/render request routes to approval-gated deep analysis so the rendered result includes the hop-by-hop explanation.

#### Bounded graph preview

Triggered by the **Show graph preview** follow-up. The assistant resolves a
finite scope and opens an **AI Preview** in
the side panel. The preview is transient; use **Save as Bookmark** to retain it.

#### Columns view in an AI preview

When the run recorded column findings, the preview banner offers an **Objects / Columns** switch.
Objects is the default. Columns redraws the same scope with one row per traced column, threads
running column to column, procedures and scalar functions drawn as ports rather than columns, and a
glyph on a line where the value changed between its two endpoints. Hovering a row lights that whole
thread and dims the rest; the rows collapse to a summary line when you zoom out.

A procedure or function that transformed a value sits in the chain between the columns it reads and
the columns it writes, with a port for each name the value carries — two ports when it renames one.
The thread therefore runs source → transform → target rather than past the transform. Structure
labels stay on the endpoints: a target column fed by two sources still reads `fan-in (2)`, whichever
object combined them. Switching to Columns fits the new layout to the window, and switching back
returns to the object view where you left it.

This is a rendering of the AI-generated column analysis — the same best-effort finding described
under **Tips** below, shown on the graph instead of only in the write-up. Verify it against the
database for compliance-critical claims.

#### Deep analysis

Triggered by an explicit graph/render request, `/trace`, a named-column trace,
the **Start deeper hop-by-hop analysis** follow-up, or an engine-forced
over-budget discovery request. It
begins only after the user approves the `confirm_sm_start` consent gate.

- The proposal card offers **Approve & Proceed**, **Change scope**, and **Cancel**. **Change scope** hands the chat input back with `@lineage` prefilled; type the change in plain language and send it to get a revised proposal.
- The extension walks the approved graph scope one object at a time and validates every requested route against the loaded catalog before visiting it.
- Recent summaries provide short-term continuity while full hop details are retained for final synthesis.

### Why it matters

In complex ETL pipelines a column often changes name several times. Deep
analysis preserves recent context while retaining per-object findings for the
final synthesis.

### Mission types

When you ask `@lineage` a question, the assistant labels the mission as `business`, `technical`, or `both`. The label drives which capture template fires per hop and which subsection appears in the final document. See [`AI_PROMPTS.md`](AI_PROMPTS.md) for how this maps to YAML keys.

### Depth handling

The proposed scope shown at the approval gate preserves the user's depth
intent:

- an explicit hop count bounds the trace to exactly that many levels;
- “all” seeds the full reachable frontier;
- bidirectional questions can use different upstream and downstream depths,
  including zero to disable one side;
- omitted depth uses a fixed default of three levels per side, not the
  `trace.default*Levels` settings, which apply to the GUI trace.

**A level count you state is a hard border; a depth the assistant chose is a
starting point.** When your question names a number of levels, the trace stops
there — the assistant may not extend past it, and each side of a bidirectional
ask is bounded independently. When you do not name one, the assistant seeds a
reasonable default and may follow the lineage further if the question needs it.
The approval gate labels which of the two applies before you approve.

Objects just past a stated border are not discarded: they are reported after
synthesis as follow-up leads, alongside mission-relevant routes outside the
schema border, and can be revisited through the related-objects follow-up.
Direction, exclusions, and the approved schema border remain mechanically
enforced throughout.

### Tips

- **Column-level questions are best-effort.** The AI traces column mappings, joins, and formulas from the loaded metadata. Always verify against the database for compliance-critical claims.
- **Ask for a graph preview.** Try *"show me the lineage for `dbo.udfLeadingZeros` in the app"*. The preview is transient; save it explicitly if you want a bookmark.
- **The assistant is context-aware.** It knows what filters are active and which schemas are visible. Ask *"what's filtered out?"*.
- **It also sees the screen.** With a trace, a graph analysis, or a bookmark applied, ask *"explain this"*, *"what am I looking at?"*, or — for an AI bookmark — *"what did you find about X?"*, *"which objects did you drop and why?"*, *"has anything changed since?"*. Type `#lineageView` in the chat input to attach the screen explicitly; the lineage tools appear in the `#` picker once a model is loaded.
- **Customise output.** Command Palette → **Create AI Output Templates** scaffolds [`aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml). See [`AI_PROMPTS.md`](AI_PROMPTS.md) for what each key controls.

### Requirements

- A VS Code version allowed by `engines.vscode` in `package.json`.
- A VS Code Language Model Chat provider, such as
  [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
  or a compatible BYOK provider.

### Disable

Set `dataLineageViz.ai.enabled` to `false` to disable the `@lineage` participant and all AI tools:
nothing registers and nothing can execute. VS Code may still show the contributed names in its
chat and tool pickers — they are declared in the extension manifest, which the host reads
regardless of the setting — but selecting one performs no AI action.

---

## Advanced settings

Search "dataLineageViz" in VS Code Settings. The Settings UI and
`contributes.configuration` section of `package.json` are the source of truth
for current defaults, ranges, and descriptions. Controls are grouped around
import/parsing, graph layout, trace/analysis, `@lineage`, and profiling.

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
