# Changelog

## [1.1.0] - 2026-08-02

### Added
- LangChain/LangGraph-based AI backend.
- Added a request-scoped LangChain bridge for the model provided by VS Code, including automatic, disabled, required, and named tool selection.
- Added a **Show graph preview** follow-up that opens a bounded, transient lineage preview without starting the full hop-by-hop analysis.

### Changed
- Scope approval actions now resume or cancel the paused analysis directly instead of submitting the decision as another chat message. Changing scope creates a revised proposal before analysis begins.
- AI trace logging now includes LangGraph phase and gate lifecycle events plus sanitized provider failures in the existing session trace.
- Multi-target neighbor pruning uses one batched reachability check when the complete batch is safe.
- `lineage_get_scope_bundle` now stores its discovery-scope artifact through the session write queue.

### Fixed
- Saved database projects are no longer dropped when the MSSQL extension supplies additional runtime connection fields.

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
