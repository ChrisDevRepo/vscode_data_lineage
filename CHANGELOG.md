# Changelog

## [1.2.1] - 2026-09-23

### Added
- **Trace navigator** in the trace view: browse a trace by level, highlight routes and find objects.

### Changed
- A deep analysis whose scope is over a limit is now refused to you up front, naming the limit and its setting, with no approval card. Each object the analysis reads takes one round (every procedure, view or function, and a table only where it is read itself) against `dataLineageViz.ai.maxRounds`, which applies without a reload; a column trace may start with at most `dataLineageViz.ai.maxTraceColumns` columns (default 10). The `dataLineageViz.ai.explorationTokenBudget` and `dataLineageViz.ai.explorationNodeCap` settings are removed.
- The AI deep-analysis approval card is now a compact summary, with a **Show full plan** follow-up for the complete detail.
- Improved the graph on large models: faster rendering, more stable layout and view handling, correct spacing around AI preview badges and footnotes; a selection over `dataLineageViz.maxNodes` is refused with the count, external-reference nodes included, instead of being silently trimmed.
- Optimized the `@lineage` assistant's backend and request handling.
- After an analysis, `@lineage` answers follow-up questions by walking the loaded graph, and a quick overview question can be answered without a tool call.
- A typed reply while the approval card waits is read as approve, change or cancel.
- Accessibility: keyboard focus, accessible names and roles for popups, menus and dialogs, and AA contrast in the toolbar and detail views.
- Edges fade and thin as the graph gets denser.
- Dependencies updated: React 19.3.0, `@xyflow/react` 12.11.6, DOMPurify 3.4.16, fast-xml-parser 5.11.1, js-yaml 5.4.2, JSZip 3.10.2, marked 18.0.14, Zod 4.6.5. New: `comlink` (layout worker) and `react-arborist` (trace navigator).

### Fixed
- The AI approval card and its **Approve & Proceed** / **Change scope** / **Cancel** buttons stay visible in VS Code releases that collapse a completed chat response: the card's closing line now comes before the buttons instead of after them. While the card waits, **Show full plan** is the only follow-up offered.
- The AI's "stopped early" and "Discovery budget reached" notices stay visible in VS Code releases that collapse a completed chat response: they now close the answer instead of preceding it.
- `@lineage` message handling migrated to LangChain/LangGraph standards (tool-calling transcript, `trimMessages`, history reset and cancellation).
- Numeric settings are read inside their declared range everywhere; a rejected AI report is repaired by resending only the changed sections.
- Schema View threshold: the toggle and its tooltip use the same `renderLimit`-capped threshold as the initial view.
- **Search Objects** focuses the picked object in the graph.
- An unreadable `.dacpac`, or a load that ends without a model, reports an error instead of failing silently.
- **Reload** on a settings notice reloads the open source, including the demo.
- The assistant's view of the visible graph respects **Hide Isolated Nodes**.
- With `dataLineageViz.ai.enabled` off, the `@lineage` participant and its tools are hidden from the chat and tool pickers instead of appearing inert.

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
