# Changelog

All notable user-facing changes to Data Lineage Viz are documented in this file.
The newest version heading collects changes until that version ships.

## [1.2.6] - 2026-10-08

### Added
- The output log warns when a module uses a cursor or dynamic SQL, which are not fully supported, with the module count (the debug log names the modules); the references the parser captures still load.

### Changed
- Column-trace instructions state value lineage only, with one `column_flow` example: join, filter, grouping and ordering columns and row operations such as TRUNCATE or DELETE are described in sections, not mapped. `combine` and `filter` are only an extra role beside a value role; a column used only in ON, WHERE, GROUP BY, PARTITION BY or ORDER BY, or as a lookup key, is not a source; `[]` is sent when nothing feeds the arriving columns. Neighbor questions and prunes are described as optional, and stale field references are corrected.
- A rejected findings call lists every fault with its path, accepted schema or metadata values, and fields to resend; final examples validate against their owning field, using an empty list only where accepted. Empty choices state withdrawal; a verified empty exit omits unrelated column-flow advice while retaining the answer callout, and no countdown is shown. A rejected retry keeps every field that validates, never overwrites a held valid field with a faulty one, an omitted faulty optional field is withdrawn and named in the acknowledgement, and `column_flow_repairs` is removed in favor of resending `column_flow` whole.
- An arriving column-trace column without a mapping ends at that hop and is listed in the acknowledgement's `ended_columns`; the `terminated_inputs` field and its rejections are removed.
- `focus_node_id` is optional on hop commands: an omitted id means the dispatched hop, which the acknowledgement names; a different id is still rejected.
- A hop no longer needs a question or prune for every neighbor. The engine continues mapped neighbors with the column instruction; a column-trace neighbor that is neither named nor mapped is reported as not followed.
- Column-trace hops record every valid neighbor-and-column mapping; attachment to the requested columns selects continuation. Procedure writes retain real source-to-target pairs without duplicate procedure-column edges; writes with no source column retain their procedure-to-target edge, and asked columns keep a preview row even without a mapping.
- Indexed report repairs share field detection, schemas and merging, with shorter correction instructions.
- At a procedure hop, each column-trace mapping must name the neighbor table column it writes (`writes_to`), or `null` when the procedure writes no neighbor table. Edges no longer attach to the procedure itself because the field was left out.
- A column-trace source that lists roles must include a value role (`pass_through`, `compute` or `aggregate`); `combine` and `filter` are only extra roles beside one. A column that only filters or joins rows is rejected with one fixed message and is described in sections instead of drawn as an edge. Leaving the roles out is still accepted.

### Removed
- The SQL Server (mssql) extension integration and the `dataLineageViz.database.connectionProvider` setting; databases connect through built-in connections only. Projects saved with an mssql connection keep it without the password; set the password with **Update Database Password**.

### Fixed
- A retry after a rejected findings call no longer offers a neighbor for pruning when the kept column mapping still uses it; the offered prune choices match the ones the check accepts.
- A procedure mapping whose `writes_to` names an unknown object or a table the procedure does not write to is rejected with its own fix text: name a table the procedure writes to, or send `writes_to: null` and describe the write in sections. It was rejected as an unknown source with advice to drop the reference.
- A table reached by several paths forwards the same question and carried columns to each next object once, so chains of shared tables no longer double the queued work at every fork and merge.
- An object passed through without analysis forwards the same question, carried columns and caller output to each next object once, as tables do, so chains of such objects no longer double the queued work at every fork and merge.
- Investigation and follow-up ids are sequence numbers instead of a short hash, so two distinct investigations can no longer collide and stop the exploration with an error; caller-context columns are matched with the source's identifier case rule.
- A function without declared columns now gets column-trace edges: its column names are accepted unverified like those of a procedure or external object, as a source and as the output of its own hop, but it is never offered as its own source. Tables and views without column metadata are still refused.
- Exploration depth is strict only for a level count or complete chain the user stated; a vague request starts at an approximate 3 levels instead of a strict single level or the whole graph.
- The served `out_col` is limited to the columns arriving at an upstream hop.
- Column-trace hops describe column_flow as one entry per arriving column, restore the recipe depth items (rules and branches, mapping, loading, error handling, gaps), and ask kept neighbors for their rules and thresholds.
- Equivalent SQL identifier delimiters, outside whitespace and source-permitted casing bind to known object identities without changing authored content or guessing missing names.
- Column-trace tool descriptions permit SQL-supported contextual dependencies without treating them as arithmetic or aggregate inputs.
- Column-trace instructions relate qualified columns to neighboring objects, and retain SQL facts beyond the requested trace in sections.
- Prohibited neighbor entries receive removal guidance instead of invalid-JSON instructions, and object-valued repair fields retain their diagnostics without incompatible scalar choices.
- Offered column sources follow the same scope admission rules as submitted mappings.
- Malformed findings repairs preserve held questions, column mappings and sections until a valid correction is submitted.
- Report and preview rejections retain valid content and request only defective section fields; malformed retries preserve the draft, and correction choices remain available during escalation.
- Distinct investigation questions retain SQL literal case and whitespace when tasks merge.
- Repeated tool-call IDs fail before execution through a shared native/headless transport guard. Live provider verification honors inherited HTTP(S) proxy and NO_PROXY settings while retaining deadlines and redirect credential protection. Stored baseline reads preserve API request spacing after delayed timers and across concurrent sources.
- Hop neighbor choices now share one backend projection across context, schemas and routing. Neighbor, column and enum rejections share first-fault, second-choices feedback without exposing unrelated catalog columns.
- Prune choices and submissions share the action-state policy. Queued column demands merge quoted and padded equivalents under the source case policy, preserving task identities and authored questions.
- AI rejection, retry and cancellation handling, including a cancel while a graph preview is drawn.
- Column-name comparison is consistent across trace admission and hop schemas, accepting identifier quoting and outer whitespace while respecting source case sensitivity.
- Neighbor pruning rejects non-adjacent targets atomically. Repeated AI rejections preserve complete repair choices for large objects and retain valid findings or report text for focused repairs.
- Database query timeouts, live import metadata and saved-project timestamps.
- A DACPAC three-part name to another database no longer resolves to a local object with the same schema and name; the DACPAC name is its current database, as on a live connection.
- Reconnecting a database project by server now matches a saved connection whose server is written with a `tcp:` prefix.

## [1.2.5] - 2026-10-07

### Changed
- The approval card stays short with large filters: exclusions show as counts and long object lists end in **+N more**.

### Fixed
- Several improvements in backend rejection handling for AI analysis.

### Dependencies
- Security updates: katex, source-map-js.

## [1.2.4] - 2026-10-06

### Fixed
- Approval card object names show underscores and other Markdown characters as written instead of with a leading backslash.
- The schema legend's expanded list scrolls inside the canvas so every schema is reachable; **Show less** stays visible below the list, and scrolling the list no longer zooms the graph.
- Column traces follow only the columns whose value produces the traced column; join, filter, group and order columns are explained, not traced.

## [1.2.3] - 2026-10-01

### Fixed
- Parameterized functions imported from DACPACs now retain their parameters and return types when the signature is stored inside the function implementation.
- Column traces stage the writer→carrier relation of a writer procedure even when the hop omits `writes_to`, so the column-lineage view stays one chain connected to the traced origin instead of detaching the branches a writer feeds ([#59](https://github.com/ChrisDevRepo/vscode_data_lineage/issues/59)).

## [1.2.2] - 2026-10-01

### Added
- Built-in SQL Server connections (SQL login or Microsoft Entra ID) replace the SQL Server (mssql) extension's connection-sharing API, which Microsoft is retiring ([#57](https://github.com/ChrisDevRepo/vscode_data_lineage/issues/57)). Select them with `dataLineageViz.database.connectionProvider`; the mssql extension stays the default for now.

### Fixed
- DACPAC import handles encoded names, dotted column names, `(max)` lengths, CLR type names and foreign-key actions.

### Dependencies
- New for built-in connections: tedious, @microsoft/vscode-azext-azureauth.
- Security updates: undici, markdown-it, brace-expansion, fast-uri.

## [1.2.1] - 2026-09-30

### Added
- **Trace navigator** in the trace view: browse a trace by level, highlight routes and find objects.
- Setting `dataLineageViz.ai.maxTraceColumns` caps the starting columns of one column trace.

### Changed
- `@lineage` backend reworked on LangChain/LangGraph standards: optimized messaging, fewer and clearer rejections.
- Clearer AI limits: an analysis over a limit is refused up front with the setting to change.
- Compact approval card and better follow-up handling in chat.
- Faster graph rendering on large models: layout runs in a background worker, with more stable layout and view handling and a higher object limit.
- Accessibility improvements across the graph and detail views.
- Dependencies updated: React 19.3.0, @xyflow/react 12.11.6, DOMPurify 3.4.16, fast-xml-parser 5.11.1, js-yaml 5.4.2, JSZip 3.10.2, marked 18.0.14, Zod 4.6.5. New: comlink for the layout worker, react-arborist for the trace navigator.

### Fixed
- AI approval card and notices stay visible in current VS Code releases.
- Settings, search, reload and error-reporting fixes.
- Graph and assistant views stay in sync with the active filters and AI setting.
- Database projects connect again with SQL Server (mssql) extension v1.46, which removed the connection API Data Lineage used. Connections now come from the connections saved in the SQL Server extension.
- Open Wizard asks to close the open view instead of doing nothing.

### Known issues
- Microsoft is retiring the mssql connection-sharing API, so the SQL Server extension shows a retirement notice when Data Lineage connects. A built-in SQL driver will replace it in a coming release.

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
