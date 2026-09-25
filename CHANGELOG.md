# Changelog

## [1.2.1] - 2026-09-23

### Added
- **Trace navigator** (trace view only): a compact floating left panel on the Analysis panel's shell, as tall as its rows. A trace opens with the whole graph visible and nothing dimmed, the navigator folded to a button beside the legend; opening or hiding it refits the graph. The L0 starting point is the panel title and fits the whole trace; the fixed Upstream and Downstream sections each load one more level (the node count is in the tooltip); hop levels collapse, with Expand all / Collapse all in the title bar, and each object's type symbol carries its schema color. Clicking a row lights and animates only the route from the starting point — every connecting path, not just the shortest — and fits the view to it. Each checkbox, or Cmd/Ctrl+click on a row, adds a route: the graph shows only the checked routes from any level and either side, animates every route edge and fits the view to all of them; hidden rows stay dimmed in the list and Show all restores the trace. Hiding the panel leaves a reopen button beside the legend. Delete or Backspace (the macOS delete key) trims the selected node and the branch that hangs only on it, and Reset beside the edit summary restores the starting scope. Find (title-bar magnifier or Cmd/Ctrl+F) jumps between matches and opens collapsed levels, and objects reached from neither side are listed under Connected.

### Fixed
- A selection above `dataLineageViz.maxNodes` stops the load with an error naming the setting; the graph is never silently cut to the first 2,000 objects, and external references are no longer dropped above that size.
- Leaving a trace, analysis, bookmark, AI view or path finder restores the exact previous view: filters, Object/Schema View, expanded schemas, focus and camera. Refresh and settings changes keep expanded schemas.
- Over the render limit, the toolbar and banners stay on screen: the base view falls back to Schema View, and an oversized trace is checked before layout and offers "Reduce depth to N" or "Exit trace".
- Loading a second DACPAC into an open panel shows the new model, not the previous one.
- Fit view contains every node on large graphs (minimum zoom lowered).
- The camera no longer jumps after a user pan; a rebuild during a node drag waits for the drop; Refresh and Rebuild are disabled while one runs.
- Deleting a node in a trace removes its now-unreachable subtree, the same cut the assistant uses.
- Numeric settings are clamped to their declared minimum and maximum.
- Switching from Schema View to Object View no longer freezes on large graphs: the object layout is computed in a background worker while Schema View is shown.
- The Bookmarks and Exclusion rules toolbar buttons have accessible names for screen readers, and the toolbar's node count label meets WCAG AA contrast in light and dark themes.
- **Data Lineage: Search Objects** now focuses the picked object in the graph; before, choosing a result did nothing.
- The **Reload** action on a "changed — reload your data source" settings notice now reloads the open project or demo, so the changed setting applies; before, it only brought the panel to the front.
- Icon-only buttons (close buttons on the mode banner, trace configuration, Path Finder and Help, the Quick Jump start-trace button, the Saved Projects back and delete buttons), the schema focus stars, the filter checkboxes and the trace depth inputs have accessible names for screen readers.
- The trace configuration and Path Finder bars use the editor widget background, so their object count and start-object name meet WCAG AA contrast.
- Opening a project right after a display setting changed no longer leaves the previous project's graph on screen.
- Schema View node headers pick black or white text by WCAG contrast against the schema color; the Graph Analysis type buttons have accessible names; the node context-menu header, Detail Search match highlights and the Help panel's docs link meet WCAG AA contrast.
- Saved Projects rows open through a native button separate from the delete button (no nested interactive controls), and their schema and bookmark lines meet WCAG AA contrast.
- Esc in a filled Quick Jump box clears the box only; the next Esc exits the active trace or mode.
- The graph webview no longer reports a Content Security Policy violation from schema validation.
- The Help panel's tab buttons announce which tab is selected.
- Picking a file that is not a valid .dacpac in the wizard shows the file name and the reason in the wizard, instead of a generic failure notification.
- A graph refused for exceeding `dataLineageViz.maxNodes` inside the panel, or an invalid exclude pattern, shows its own message once as a warning instead of an "unexpected error" notification; a settings change now builds the open graph once instead of twice.
- When the render limit falls back to Schema View, the Schema View button shows as active and schema nodes respond to click, search and the legend as in Schema View, instead of behaving as broken object nodes.
- Reload on a settings notice reloads the demo when it was opened from the Open Demo command or Quick Actions, instead of asking to reopen a .dacpac file; a project opened after the demo is never replaced by the demo on Reload.
- With Schema View turned off (`dataLineageViz.overview.enabled`), a graph over the render limit shows the limit message instead of switching to the disabled Schema View.
- The version label in the Help panel meets WCAG AA contrast.
- Closing the trace banner, the trace configuration bar or the Path Finder bar no longer triggers a blocked-script security warning in the webview.
- Toolbar popups (schema, type and external-reference filters, Bookmarks) move keyboard focus into the popup when opened and back to their button on Escape, announce themselves as dialogs, and a click on a filter row's text toggles its checkbox. The Graph Analysis menu opens with the arrow keys, moves between items with Up/Down and announces its open state.
- The node and schema right-click menus take keyboard focus when they open, move between enabled items with Up/Down/Home/End, are announced as menus, and every item highlights the same way on hover.
- The Help panel moves keyboard focus into itself when opened, keeps Tab inside the panel and returns focus on close; the exclusion rules popup focuses its pattern field, announces itself as a dialog and returns focus to its button on Escape.
- The schema clusters button in Expanded Schema View keeps the label "Hide schema clusters" and reports hidden clusters as pressed, like the Hide Isolated Nodes button, instead of swapping its label while also reporting a pressed state.

### Changed
- Filters are locked during a trace, with the reason shown; right-click menu items are shown disabled with a reason instead of disappearing; schema boxes get Expand/Collapse in the right-click menu; double-click on an object opens Show Details; Esc steps back one level, including collapsing the last expanded schema.
- Trace depth controls show the object count before the click, and the add-neighbour control shows "+N".
- `dataLineageViz.maxNodes` accepts up to 5,000 objects (default stays 2,000).
- Large graphs: nodes render as plain boxes when zoomed out, off-screen nodes are skipped above 300 nodes, edge animation stops above 200 edges, and a click re-renders only the nodes it changes.
- Large graphs: lines fade and thin as the number of rendered edges grows (full strength up to about 100 edges, the floor from 2,000), more in dark themes than in light ones and not in high-contrast themes; highlighted and route lines keep full emphasis.
- Dependencies updated to their latest patch and minor releases: React 19.3.0, React Flow (`@xyflow/react`) 12.11.6, DOMPurify 3.4.16, fast-xml-parser 5.11.1, js-yaml 5.4.2, JSZip 3.10.2, marked 18.0.14 and Zod 4.6.5.

## [1.2.0] - 2026-09-21

### Added
- **Detail view** (Objects / Detail switch on AI previews and AI bookmarks): column-level findings of an AI analysis, rendered on the same objects; procedures and scalar functions render as compact hubs. The column-flow tooltip on objects is removed.
- The assistant reads the current screen state and recalls a saved AI view's findings and open questions in later chats.
- Column trace runs the same exploration as an object trace plus column findings, synthesizes at full depth, continues past objects without a SQL body, and records a column decision for every route.
- A follow-up adds the requested object, or its chain to the source or to the end, to the presented graph; a render amendment patches the committed report. "Explore related objects" lists candidates, marks those already on the graph, and asks before adding.

### Changed
- Rejection and repair handling: one guard stops repeated errors, broken array boundaries are repaired, over-long names are repaired per field, and every dropped value is logged.
- An explicit graph/render request is answered in discovery.
- `@lineage` SQL code search reports the governing IF/WHILE condition of each hit.
- In an untrusted workspace, workspace values for `dataLineageViz.parseRulesFile`, `dmvQueriesFile`, `excludePatterns` and `ai.outputTemplateFile` are ignored until the workspace is trusted.

### Fixed
- Parser and trace: bracketed `]]` escapes, comments inside identifiers.
- Display: large graphs stay responsive while dragging, over-limit views report it, saved views fit the graph on restore, and the collapsed report rail stays docked.
- Assistant: XML/unfenced tool calls are read without stalling the turn, bookmarks recall their AI run, formula notes reach the report, and a broad SQL code search stays within memory and time limits.
- Webview: search hits keep their pending zoom; the AI description overlay is simplified.

## [1.1.0] - 2026-08-20

### Added
- The analysis engine runs on LangChain/LangGraph, with a request-scoped bridge to the model supplied by VS Code.
- A "Show graph preview" follow-up renders a bounded lineage view without running a full analysis.

### Changed
- Scope gate buttons (Approve & Proceed, Change scope, Cancel) invoke a command directly instead of posting a chat reply.
- The chat answer carries the summary, intro, and closing of the result.
- Dependencies updated; `npm audit` reports no known vulnerabilities.

### Removed
- Settings `dataLineageViz.ai.contextPayloadBudget` and `dataLineageViz.ai.showToolInvocations`.
- Chat tool references `#lineage_get_scope_bundle` and `#lineage_present_result`; both tools are now internal to the analysis engine.

### Fixed
- A saved database project is no longer discarded when one of its records carries a field this build does not recognise.
- A live connection reports a database platform even when the engine-metadata query identifies none, falling back to the server-reported platform.
- References into schemas not selected during a live database import are classified correctly instead of being reported as unresolved.

## [1.0.3] - 2026-07-19

### Added
- Copilot Chat buttons (Approve & Proceed, Refine scope, Cancel) for gate resolution.
- Post-approval discovery memo to carry semantic intent across SM hops.
- Runtime schema expansion during the scope gate.
- Transactional repair for AI tool calls (validates and merges exact field patches via a held draft).
- Closed-stream guard on the chat response writer to handle cancellation and unexpected stream closures.

### Changed
- Bounded AI memory using sliding-window token eviction and post-walkthrough hop compaction.
- Completed session turns now replay only the minimal trailing tool-pair.
- Migrated webview UI to Tailwind CSS v4.

### Fixed
- Fixed new-chat isolation to prevent inheriting state from previous sessions.
- Fixed cancellation propagation to correctly terminate background analysis when "Stop" is clicked.
- Fixed stale detail panel data persisting after schema deselection.
- Fixed silent failures on unresolved column references during AI previews.
- Fixed synthesis phase by injecting a one-shot corrective if `present_result` is skipped, with fallback to a deterministic archive render.

## [1.0.2] - 2026-06-26

### Added
- **Schema View for large graphs** — expand and collapse schemas in place; opening several at once is additive.
- **Edit a trace by hand** — add or remove neighbours with ＋ / －; the trace always stays connected.
- **Refresh command** — resync display settings without reloading the data.
- **draw.io export** now covers the schema overview and expanded views.

### Changed
- Redesigned large-graph overview and unified keyboard shortcuts.
- Schema View no longer auto-switches back to Object View when filters drop the node count below the threshold — after load, the toolbar toggle is the only thing that changes the view; `renderLimit` remains the sole safety gate.
- Extracted utility functions from `lineageParticipant.ts` into `participantUtils.ts` to reduce the monolith size.

### Fixed
- Clearer error notifications on failed view, project, or export actions.
- Graceful fallback when built-in templates or parse rules fail to load.
- External-only schemas no longer crash the graph.
- The panel auto-recovers after a display crash, with clearer error messages.
- Schema View is steadier (collapse on rebuild, *Clear All Filters*, schema-node clicks).

## [1.0.1] - 2026-05-20

### Added
- **Detail Search: scope dimming.** Results from schemas/nodes outside the active filter now render dimmed with a ⊘ "Not in current view" separator, consistent with Quick Jump.
- **AI preview descriptions** can now be maximized and resized for easier reading.

### Fixed
- **AI lineage tracing no longer stalls.** When the assistant references an object or column that isn't in the loaded model, it now notes it and moves on — instead of retrying until it gave up with a half-finished ("partial") trace.

### Changed
- **Clearer AI self-correction.** When the assistant makes a genuine mistake (such as a column that doesn't exist on an object), it now gets a specific, actionable correction with the valid options instead of a generic failure — improving trace accuracy.

## [1.0.0] - 2026-05-12

### Changed
- **Chat-first answers.** Lineage questions return structured Markdown in chat by default; the graph panel and walkthrough only launch when explicitly requested.
- **Asymmetric depth tracing.** Specify independent upstream/downstream depths in a single request (e.g. "3 upstream, 1 downstream").
- **Schema color palette expanded to 15 colors** for both light and dark themes; schemas beyond the 10th now map to a second set of lighter paired variants, giving each additional schema a distinct color.

### Added
- **One-click deeper analysis.** Post-discovery pill launches the hop-by-hop walkthrough with scope preview and consent gate — no need to re-type the question.
- **Persistent discovery context.** The AI carries a memo of the discovery findings and any focus/exclusion instructions through every hop of the walkthrough.
- **Customizable chat output** via `aiOutputTemplates.yaml`.

### Removed
- **Inline mode** — superseded by the chat-vs-walkthrough split.


## [0.9.x] - 2026-02 to 2026-04

### Added
- **`@lineage` AI assistant** — natural-language lineage questions in Copilot Chat; choose `business`, `technical`, or `both` analysis lens; scope approval gate with Schema → Type → Node preview before every run
- **Column tracing** — follow a named column hop-by-hop through views, procedures, and functions, tracking renames and transformations
- **Database import** — SQL Server, Azure SQL, Fabric DW, and Synapse via live connection; platform auto-detected
- **Schema overview** — graphs with 150+ nodes open as a schema-level bubble map; double-click to drill in
- **Find Path** — shortest dependency path between any two nodes
- **Graph Analysis** — islands, hubs, orphans, longest paths, cycles
- **Table design viewer** — columns, constraints, foreign keys, and statistics
- **Column metadata** — column details for views and table-valued functions in the detail panel
- **Project sessions** — save connections, schema selections, and filter states as named projects with exclusion rules
- **AI output templates** — customizable `@lineage` output format via `dataLineageViz.ai.outputTemplateFile`

## [0.8.x] - 2026-02

- Export to Draw.io, UDF detection, EXEC return values, correct read/write edge directions

## [0.7.x] - 2026-02

- Detail Search, Node Info Bar, Demo Data, `dacpac-sql` language

## [0.6.x] - 2026-01

- Fabric + SSDT support, Interactive Trace, Schema Focus, Smart Search, DDL Viewer, Custom Parse Rules

## [0.5.0]

- Initial preview release
