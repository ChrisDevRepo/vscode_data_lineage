# Changelog

## [1.1.1] - 2026-09-06

### Added
- The assistant checks each SQL comment against the statement it annotates. A comment that
  contradicts the code, or that carries an operational instruction such as "do not use this
  procedure", is called out; one verified correct and relevant to the question is written into the
  detail description instead of only being captured. An incomplete comment is not a finding.

### Changed
- A question that asks for lineage "back to its original sources", with no level count, is no longer
  answered as if it had asked for three levels. The approval card and the assistant's working memory
  now report the depth the engine actually enforces, so an unbounded trace is not silently truncated
  and delivered as complete.
- An AI capture writes its own marked line for every structural finding, including one the
  surrounding prose already describes, so a finding that was detected is also delivered.
- The computed-column recipe renders every distinct formula on a branch, not one per column.

### Fixed
- A long turn no longer stalls and ends without an answer when two large object bodies cannot be
  held at once: evicting a body no longer discards the record that the read already happened, which
  had made the assistant re-request the same object until the turn ran out of tool calls.
- A tool call a model emits in the `<function=...>` XML form is read as a call instead of being
  rejected as message text, and the rejection hint now names the channel as the repair rather than
  asking again for fields that were already present.
- A refused prune candidate is logged as a prune outcome rather than a rejection, so the run summary,
  the host log and the trace no longer report three different rejection counts for the same run.

## [1.1.1] - 2026-08-26

### Added
- The assistant reads what is on screen, and recalls a saved AI view's findings and open questions in later chats.

### Changed
- The ⚠️ structural-callout rule for AI captures now lives in one template key, `structural_callouts`, sent once per hop instead of once per capture angle. The template `schemaVersion` is 3: a custom overlay file needs re-scaffolding with "Data Lineage: Create AI Output Templates".
- The transform marker on a column edge in the column view is now a chip you can hover for detail, with a matching legend key; an unmarked line means the value passed through unchanged.
- The column-trace hop instruction now extends the object instruction instead of replacing it, so a node that shapes rows without carrying a traced column is classified the same way whether or not column tracing is active.
- During a column trace the assistant decides per neighbour whether to follow the traced columns into it: an object that only narrows which rows the answer returns is now explored as a whole object, instead of being asked about columns it does not supply.
- The approval card's depth line states what the engine will do with the depth (a default start it can extend) instead of what the assistant estimates, so the card carries only facts.
- A depth stated in a question is a hard limit per direction; objects past it become follow-up leads.
- Column-level findings from an AI column analysis can be shown on the objects; object lineage stays the default view.
- The longest-chain report lists up to 25 chains, deepest first, instead of reusing the graph node limit as a chain count.
- A trace narrowed to part of the model is held to the same render limit as any other view, and reports when it exceeds it rather than drawing an oversized view. Adjust the ceiling with `dataLineageViz.renderLimit`.
- A one-direction trace (upstream only, or downstream only) now draws every edge between the objects it includes; an edge that pointed against the trace direction between two traced objects was previously hidden.

### Removed
- Saved views no longer restore the camera position they were captured at; a restored view fits the graph instead.
- The always-on column-flow tooltip on objects; the column view, which shows the same flows in full, replaces it.

### Fixed
- Retrying a rejected tool call no longer fails a Gemini 3 turn with a provider 400 over a missing thought signature: the replayed exchange is closed by a user-role continuation note — the provider's documented turn boundary — sent to every provider alike.
- A `sections` array the model sends JSON-string-encoded is decoded and accepted instead of being rejected.
- A prose tool call whose payload body is not fenced is read instead of rejected.
- A redundant leading `(?i)` in a DDL search pattern is normalized away instead of rejected.
- Rejection hints name the repair the engine will accept: a guard that admits records what it admitted, the budget rejection names a repair that exists when one route is staged, and the incomplete-chain hint offers the passthrough escape only where it is accepted.
- A column trace whose focus node carries none of the traced columns may end the chain there, and a focus that declares none of the traced columns stays in the answer.
- A repeated column relation is skipped before the row accumulators run.
- A follow-up widens the exploration border only for a lead the run itself offered.
- A contributor column the engine cannot verify is logged instead of accepted silently, and the notes schema no longer licenses a bare kept node the engine requires covered.
- The column view degrades quietly when a node has no column data, costs one tab stop, and builds hover adjacency once.
- Switching between saved AI views in column mode no longer keeps the previous view's pinned or hovered column thread lighting rows of the new view.
- Focusing a column card centers on the card instead of on an object-sized box above it.
- Dev-only transitive dependencies updated; `npm audit` reports no known vulnerabilities.
- Upgraded the graph rendering library and corrected large-graph rendering: dragging stays responsive, and a trace past the render limit reports it instead of drawing an oversized view.
- Formulas in AI descriptions render as mathematics, inline and as blocks.
- Depth follows data-flow direction, so a shared audit table no longer makes objects look closer.
- Repeated identical tool calls no longer loop a turn without an answer, and a read the model keeps resending after it was already answered is charged like any other unproductive resend once the short grace is used, so the turn ends with a clear failure instead of running to the call limit.
- A repair turn that keeps resending an identical rejected result is bounded by the attempt budget after a short grace, so it ends with a clear failure instead of looping until the call limit stops it.
- Schema-invalid tool calls are rejected naming the sent value and the expected shape of every offending field, so one repair round can fix a mistyped field instead of guessing.
- A per-side exploration depth that the local model server sends quoted as a JSON string is decoded and accepted instead of failing the turn after repeated rejections.
- A column target that names an object is rejected with a pointed explanation instead of failing later in column-flow validation it cannot satisfy.
- Improved column tracking: each hop of a column trace receives its own lineage questions.
- A column trace no longer hands a procedure a column the source table does not have, so bidirectional traces starting at a view now complete.
- SQL parsing corrections: objects are no longer dropped after a wildcard storage path, and a few spurious dependency edges no longer appear.
- Graph traversal corrections: the longest dependency chain no longer stops where it meets a circular dependency, and a large graph-pattern report no longer overruns a chat turn.
- The longest-chain graph analysis now picks the longest real chain even when a shorter branch runs through a circular dependency.
- A commented-out object after a bracketed name containing an apostrophe no longer appears as a dependency.
- A bracketed name containing a doubled `]]` escape is captured as one identifier instead of being cut at the first `]`.
- The column-level Detail view now lays out with the same settings as object lineage.
- A follow-up brings in only an object the analysis itself raised as an open question, and only that object rather than its whole schema; an object outside the approved scope that was never raised still needs a scope approval.
- A bookmark recalls the AI run it was saved from, even after a later exploration in the same chat.
- A damaged saved AI run record is ignored instead of read as valid.
- AI DDL search now names the actual reason a search pattern was rejected instead of one generic hint.
- The column-level Detail view recovers cleanly from a rendering error when you switch back to it.

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
