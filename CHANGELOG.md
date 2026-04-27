# Changelog

## [Unreleased]

### Changed
- **Lighter synthesis prompt.** Reduced the per-synthesis-turn prompt by ~7,500 tokens (~18%) and stabilised the prefix so consecutive turns hit the prompt cache. Removed redundant umbrella templates (`sections`, `business_subsection`, `technical_subsection`); the lift+group+label rule now lives in the synthesis cue itself. Stripped the routing-only `fullNodes[]` and `edges[]` lists from the synthesis-transition tool result — the agent works from `detail_slots[]` exclusively.
- **`closing` only fires on graphs with 5+ sections.** Small explorations now skip the closing template, saving ~140 tokens.

### Fixed
- **No stale per-hop sub-question at synthesis.** The `<current_task>` block from the last active-phase hop no longer leaks into the synthesis prompt.

### Removed
- **`description` is no longer an AI-writeable field.** The full description shown in the description overlay is built deterministically by the engine (`orderAndAssemble`) from `title + intro + sections[] + closing`. Removed the AI-input field, the YAML template, the `STAGE_BY_KEY` entry, and the validation passthrough — the AI now writes structured parts only; the engine assembles the document. No user-visible change to the rendered overlay.

### Added
- **Pick the analysis lens before exploration.** Choose `business`, `technical`, or `both` when starting a `@lineage` exploration. Business reports describe domain meaning (rules, formulas, consumer impact). Technical reports describe execution (SQL evidence, joins, loading patterns, antipatterns). `both` produces two peer sections per node, one of each.
- **Approve scope before analysis runs.** Every exploration shows a scope tree (Schema → Type → Node) with the live hop count. Approve to proceed, **Refine scope** to narrow it, or **Cancel**. Refine opens the chat input prefilled — describe the narrowing in plain English ("ignore staging", "drop UDFs", "trace ProductID only") and the assistant re-runs the scope. The loop continues until you approve or cancel.
- **Column trace.** Ask `@lineage` to follow specific columns end-to-end ("trace TotalRevenue back to its sources"). Per-hop column attribution is captured alongside the regular analysis.
- **Hop-by-hop progress.** During long explorations, `@lineage` shows `Hop X / N — analyzing <node>…` per step, then `Synthesizing the answer…` while assembling the final report.
- **Follow-up after the report.** Once a graph is rendered, follow-up actions appear as chips: replay the full description, explore deferred objects, or ask refinements ("rename a label", "drop a node from the graph", "add this related object") — refinements edit the existing report instead of restarting.
- **Smart grouping at synthesis.** When several procedures share the same shape (e.g. 3+ SPs with the same TRUNCATE+INSERT skeleton differing only in filter, or sibling EV cases / allocation rules), `@lineage` labels them once, groups them under a single section, and summarises them together — one comparison table with the shared SQL hoisted above the rows. Distinct logic still gets its own section.
- **Big-picture closing.** When the analysis spans 5+ sections, the report ends with a one-paragraph through-line that names the overall pipeline answer in the lens you asked for, plus a `⚠️` flag for any cross-cutting risk that doesn't fit a single section.

### Changed
- **Business-mode quality matches `main`.** `@lineage` business-mission output (chat narrative, structured graph description, badge labels) is restored to the depth and structure produced before the testing branch's regressions. Technical mission and `both` mission produce their own corresponding outputs without bleeding into business reports.
- **Cleaner reports.** Reports open with a one-sentence answer to the original question, then group related objects together before per-object detail. Out-of-scope objects are no longer enumerated inline — they remain available via the deferred-objects follow-up chip.
- **Friendlier progress lines.** Progress reads as plain sentences ("Inspecting 3 neighbours for pruning…", "Loading lineage context…") instead of raw tool names.
- **Customisable prompt templates.** `assets/aiOutputTemplates.yaml` drives both per-hop capture and final report rendering. Edit either side; changes flow through.
- **Cleaner cancellation.** Pressing Stop mid-response exits cleanly — no "stream closed" error.

### Fixed
- **No technical content in business reports.** SQL fences, XPath, namespace URIs, datatype tables, and JOIN syntax no longer leak into business-mission slots. Business reports stay business; technical reports stay technical.
- **No planning preamble in chat.** The `Now I have all slots. Assembling the final report.` leak no longer welds onto the first heading of the synthesised answer.
- **Visible synthesis progress.** The 30–90s synthesis call now shows a `Synthesizing the answer…` progress chip — no perceived hang.
- **Sibling procedures kept distinct in reports.** Each procedure gets its own section unless it genuinely shares the same shape (then it joins a comparison table). Pipeline-stage over-grouping that collapsed 22 procedures into 7 buckets is fixed.

## [0.9.9] - 2026-04-26

### Added
- **Scope confirmation before long explorations** — `@lineage` shows the planned scope (nodes, schemas, depth) and asks for approval. Reply `yes` to proceed, `no` to pause, or ask a different question to redirect.
- **Natural-language scope hints** — Phrases like "direct neighbors", "one level", or "ignore UDFs and views" are honored as actual scope rules, not just prompt prose.
- **Mission briefing** — `@lineage` writes a short plan (intent, scope, filters) at the start of each exploration. Stays anchored across long multi-hop sessions.
- **Deferred follow-ups** — References that fall outside the approved scope are surfaced as one-click chips below the response. Click to investigate that specific object.
- **Incremental view updates** — Ask `@lineage` to add or remove specific tables in an existing view without restarting the analysis.
- **Show-full-description chip** — Every `@lineage` response that produced a graph view includes a chip that replays the full AI description inline. No re-analysis, no extra API call.
- **Loading Pattern line** — Reports for stored procedures now start with a one-line `**Loading Pattern:**` summary (full / incremental / SCD2 / MERGE / etc.). Views and functions skip the line.
- **Business vs technical reports** — `@lineage` infers whether your question is business-oriented, technical, or both, and shapes the report accordingly. Technical reports add a `#### Technical` subsection per section with SQL snippets, formulas, and performance observations.
- **Customizable AI output templates** — `aiOutputTemplates.yaml` now drives both what `@lineage` captures per node AND how the final report renders. Edit either side; changes flow through.
- **Better compatibility with Copilot Free** — `@lineage` resolves the active chat model dynamically, fixing "Chat provider not registered" errors.

### Changed
- **Friendlier chat progress lines.** While `@lineage` works, progress lines now read as plain sentences — "Inspecting 3 neighbours for pruning…", "Hop 5 / 22 — analyzing spCadenceRule_DEPT…", "Loading lineage context…" — instead of raw tool names like "Invoking get_neighbor_columns…". One source of truth covers both the inline chat stream and VS Code's native invocation chrome.
- **`Objects` row in the AI description overlay.** Each section's objects render as a single comma-separated row of clickable links, prefixed by a small "Objects" caption — easier to scan than the previous one-heading-per-object stack. Clicking a name still focuses the graph on that node.
- **Cleaner synthesis reports.** Out-of-scope objects no longer appear as an enumerated "Deferred objects for follow-up" section inside the report. The report stays anchored on the analyzed nodes; the post-synthesis follow-up chip remains the single place to drill into deferred objects.
- **`@lineage` is clearer about its current focus.** The hop prompt now states the focus node id in plain text (in `<mission_state>` and in the gate-resume message), so the AI reliably identifies its analysis target on hop 1 — eliminating the first-hop waste where the AI inspected the origin table instead of the seeded procedure.
- **Starting-point table summaries.** When you ask about a table as your starting point, `@lineage` now produces one clean dossier slot for it — Purpose, Columns, Upstream sources, Downstream consumers, Grain / keys — instead of folding the table into a neighbouring procedure's analysis. Mid-graph tables are unchanged (still contracted through to the procedures around them).
- **Synthesis rendering rules.** The intro paragraph is now narrative prose only (no column dumps). Sibling procedures sharing the same shape (e.g. multiple EV cases, multiple allocation rules) render as one comparison table with the shared formula hoisted above — not one bullet per variant. Every ⚠️ invariant from every slot is preserved (no merging across variants). Section headers use plain `##` — no auto-numbered prefix.
- **Authoring hygiene.** Procedure analysis names only columns the procedure reads or writes. Neighbour tables' full schemas belong in catalog inspection output, not in a procedure's slot. Soft authoring aim is 800–2 000 chars per `Columns / logic` section — split into sub-sections rather than prose-extending a single section.
- **Cheaper synthesis retry.** When the synthesis free-text guard fires, the retry re-sends a minimal prompt (plus the essential system / user / tool-result messages) instead of the full stable prefix — cuts retry cost significantly.
- **Ask follow-ups after the report** — once `@lineage` finishes, you can keep asking: tweak a label, drop a node from the graph, or add a deferred node. Refinements edit the existing report instead of starting over.
- **Reports answer the question first** — every `@lineage` report opens with a one-sentence answer to the original question, then groups related objects together before diving into per-object detail.
- **Full conversation history retained** — `@lineage` no longer drops older turns from active context; the assistant remembers the whole session.
- **30-minute AI session timeout** — Idle exploration sessions expire automatically. Starting a new exploration discards any old in-progress one with a brief in-chat notice — no blocking dialog.
- **Cleaner cancellation** — Pressing Stop mid-response no longer produces a red "stream closed" error. The handler exits cleanly.

### Fixed
- **"Show full description" chip restored.** The chip that replays the full AI description inline after a graph view was lost during an earlier refactor. It now reappears below every successful `@lineage` exploration that produced a view; clicking it prints the cached description verbatim, with no model round-trip.
- **Slot hijack on first hop.** If the AI's `submit_findings` was rejected with `focus_mismatch`, it could retry by just swapping the `focus_node_id` field while keeping the original (wrong-subject) analysis body. The analysis would then end up stored under an unrelated node. `submit_findings` now rejects with `focus_subject_mismatch` when the authored analysis opens by naming a different scope node than the declared focus — identifier-match contract, not content judgement.
- **Silent route drops.** Routes that passed acceptance but produced no new hop (table whose contracted forward fell outside scope) no longer silently report `accepted: true`. The route_outcome is downgraded to `{ accepted: false, deferred: true, reason: 'depth_contracted_beyond_budget' }` so the AI can tell routed-and-enqueued apart from routed-but-dropped.
- **Prompt duplication.** The "Grounding rule" sentence was repeated four times across the active-phase prompt; the out-of-scope routing paragraph was repeated three times. Both are now stated once in their canonical surface.
- **`/search` and `/trace` returning empty** — Slash commands now reliably invoke their lineage tools instead of fast-failing with zero tokens.
- **Lost first-node context after consent** — The first node's context is now preserved across the consent boundary, preventing tool hallucinations at the start of an exploration.
- **Truncated DDL during AI exploration** — `@lineage` can now resolve full DDL on demand during multi-hop traces.
- **Out-of-scope deferred follow-ups** — Dependencies hidden by a natural-language filter (e.g. "ignore UDFs") are offered as deferred follow-up chips instead of being silently dropped.

## [0.9.8] - 2026-04-12

### Added
- **Structured graph descriptions** — AI results organized into labeled sections ordered by data flow, with matching badge numbers on nodes
- **"Show in Graph" button** — one-click after AI trace completes
- **`@lineage` loading pattern detection** — AI memory captures full/incremental/SCD2/MERGE patterns per node
- **`@lineage` DDL observations** — AI memory captures code comments, version annotations, performance risks, anti-patterns

### Changed
- **Question-adaptive AI output** — sections adapt to question type: business logic leads with formulas/renames, performance leads with execution patterns, documentation combines both
- **Richer AI detail memory** — comprehensive per-node documentation with SQL evidence + business meaning (8000 char limit, up from 5000)
- **Faster AI on small scopes** — small traces deliver all data at once; larger scopes use hop-by-hop with persistent memory
- **More accurate AI findings** — citations reference verbatim SQL evidence instead of generic summaries
- **Clearer trace progress** — "Node X of Y" shows stable scope total instead of dynamic frontier count

### Fixed
- **AI memory reliability** — centralized short memory validation with soft/hard limits; removed silent truncation and duplicated checks
- **`@lineage` follow-up links** — removed "Detailed explanation" link (documentation is now full-depth on first render); fixed "Explore top hub" matching wrong tools
- **`@lineage` LaTeX in chat** — added rule to use ```math fenced blocks instead of $$ delimiters
- **OOP scopeSize getter** — consolidated CT/BB scope accessors into base class; removed redundant CT private field
- **Schema-aware AI queries** — `@lineage` scopes searches to active schema filter
- **Find Path ignores filters** — searches the full model regardless of active filters
- **Reliable search from overview** — drill-down from schema overview works without race conditions
- **Search visibility in overview mode** — quick search and detail search correctly show objects as "in view," highlight matching object names, and keep snippet marks visible

## [0.9.7] - 2026-03-31

### Added
- **Column metadata for views & functions** — Views and table-valued functions now show column details in the detail panel, with a toggle between columns and DDL source
- **`@lineage` column tracing** — Ask the AI assistant to follow columns hop-by-hop through views, procedures, and functions, tracking renames and transformations

### Fixed
- **CTE UPDATE parsing** — `UPDATE alias SET ... FROM cte_name` patterns and chained CTE references now correctly produce write edges to the underlying table
- **`@lineage` LaTeX rendering** — Fixed math formula display in AI description overlay

### Changed
- Reduced webview payload size on large data warehouses by keeping column metadata on the extension host
- Updated documentation with lineage-focused examples

## [0.9.6] - 2026-03-27

### Added
- **Schema overview** — Large graphs (150+ nodes by default) automatically open as a schema map: one bubble per schema with object counts and type icons. Double-click a bubble to drill into that schema. Toggle with the status bar button or disable via `dataLineageViz.overview.enabled`.
- **`@lineage` AI assistant** — Ask questions about your graph in GitHub Copilot Chat (`@lineage what depends on Sales.Order?`, `@lineage trace upstream from dbo.FactSales`). Requires GitHub Copilot and VS Code 1.95+.
- **AI output templates** — Customize how `@lineage` formats summary, description, badges, highlights, and notes via `dataLineageViz.ai.outputTemplateFile`. Scaffold with Command Palette → *Create AI Output Templates*. See [AI Prompts Guide](docs/AI_PROMPTS.md).
- **Primary key badges** — PK columns are flagged in the table detail view. Composite keys show ordinals (PK1, PK2, …).
- **Platform detection** — The extension identifies SQL Server, Azure SQL, Fabric, and Synapse from both dacpac files and live connections.

### Changed
- **Unified detail panel** — DDL and table detail share one moveable panel; opens directly to the right type. Search highlights carry through (SQL: F3 navigation; table: column and FK names).

## [0.9.5] - 2026-03-24

### Changed
- Updated dependencies: picomatch 4.0.3 → 4.0.4, picomatch 2.3.1 → 2.3.2
- **Start screen** — Most recent project shown upfront; "Load Projects" button to browse all saved projects.
- **Dropdowns and tooltips** — Dropdowns no longer clip behind other UI elements. Toolbar buttons show themed tooltips on hover.

### Added
- **Project sessions** — Save connections and schema selections as named projects. Start screen shows project cards; "Create New" opens the setup wizard.
- **Saved Views** — Save and restore filter states (schemas, types, search, exclusions) per project.
- **Loading screen** — Progress view for all data paths with elapsed timer and 60 s timeout.
- **Exclusion Rules** — ⊘ toolbar filter to hide nodes by pattern in real-time. Supports `%` wildcards and regex. Add via dropdown, right-click → "Exclude from view", or `Delete` key.

## [0.9.4] - 2026-03-12

### Fixed
- BFS trace: removed co-writer filter that caused non-deterministic results; added direction-aware edge filtering.

## [0.9.3] - 2026-03-08

### Fixed
- False-positive external cross-DB nodes from SQL Server CLR type method calls.

## [0.9.2] - 2026-03-07

### Fixed
- Updated dependencies to address security vulnerabilities reported by GitHub

### Added
- **Table design viewer** — Tables and external tables open in a styled HTML view with column details, constraints, and foreign keys.
- **Table statistics** — Quick Stats and Detail Stats for database-imported tables, with platform-aware sampling.
- **External Table nodes** — External tables support
- **Virtual external references** — OPENROWSET file paths, cross-database 3-part names
- **External Refs analysis** — New analysis mode listing all file sources and cross-database references
- **Analysis quick-switch** — Icon strip at the top of the analysis sidebar
- **View/function parser supplement** — body parser runs as fallback for views and functions
- **Schema-grouped neighbor details** — In/Out neighbor list groups by schema

### Changed
- **Catalog-original casing** — Schema and object names displayed exactly as defined in the database.

## [0.9.1] - 2026-02-25

### Changed
- Added Workspace Trust support — extension now works in restricted workspaces

## [0.9.0] - 2026-02-20

### Added
- **Database Import** — Import schema and dependencies from SQL Server, Azure SQL, Fabric DW, or Synapse
- **Quick Reconnect** — Wizard remembers your last data source
- **Find Path** — Right-click any node to discover the shortest path to another node
- **Graph Analysis** — Structural insights: islands, hubs, orphans, longest paths, and cycles
- **MiniMap** — Draggable overview map with schema-colored nodes
- **Sidebar** — Quick access to the wizard, demo, and settings
- **COPY INTO / BULK INSERT** — Recognize bulk-load targets

### Fixed
- Four parsing patterns that previously produced incomplete lineage graphs

## [0.8.2] - 2026-02-14

### Fixed
- **Import feedback** — Status messages for loading, errors, and empty databases

## [0.8.1] - 2026-02-08

### Added
- **Export to Draw.io** — Export the lineage graph as a `.drawio` file
- **Copy Qualified Name** — Right-click any node to copy `[schema].[name]` to clipboard

## [0.8.0] - 2026-02-08

### Added
- **UDF Detection** — Inline scalar function calls now appear as dependencies
- **EXEC Return Values** — Procedures called with `@result = proc` are now captured
- **Smarter Edge Directions** — Dependencies now have correct read/write arrows

### Fixed
- Security upgrade (CVE-2026-25128), quoted identifiers, theming, trace edge cases

## [0.7.x] - 2026-02

- Detail Search, Node Info Bar, Demo Data, custom `dacpac-sql` language

## [0.6.x] - 2026-01

- Fabric + SSDT support, Interactive Trace, Schema Focus, Smart Search, DDL Viewer, Custom Parse Rules

## [0.5.0]

- Initial preview release
