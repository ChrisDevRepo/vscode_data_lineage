# Changelog

## [Unreleased]

### BREAKING
- **`submit_findings.detail_analysis` removed; replaced by `sections: CapturedSection[]`.** The locked `confirm_sm_start` classification (`business | technical | both`) now drives mechanical schema validation: each finding submits exactly one section per fired `*_capture` template (`business` → 1; `technical` → 1; `both` → 2). Mismatches are rejected with `classification_lock_violation`. Closes the prompt-vs-data-model gap that compounded the business-section regression baseline1 → testing — the YAML capture templates can finally promise structure that the data model carries. Hard cutover (no deprecated alias). All consumers updated: `DetailSlot.sections`, `HopFinding.sections`, `lineage_submit_findings` tool schema, eval extract, unit tests.
- **`/trace` and `/search` slash commands phase-gated.** Both are valid only in `idle` and `completed` phases. Invocation mid-active or mid-synthesis emits a clarifying message and returns without injecting a discovery-phase prompt. Closes a class of phase-prompt collision bugs.

### Changed
- **`confirm_sm_start` gate rendering rewritten.** Replaces the text-only "Exploration Plan" markdown + 2 buttons (Approve & Proceed / Decline) with a nested-bullet scope tree + 3 buttons (Approve & Proceed / Refine scope / Cancel). Tree is built from `engine.getScopeSummary()` so the live hop count anchors the tree the user sees. "Decline" renamed to "Cancel" for clarity.
- **`classifyGateReply` widened to 4-way** (`'yes' | 'no' | 'refine' | 'redirect'`). Anchored end-of-line on the literal command tokens — partial-affirm phrases like "yes but ignore staging" no longer match `yes`; they fall through to `redirect` where the participant treats them as scope-refinement intent. Add/remove vocabulary is deliberately NOT pattern-matched mechanically — that interpretation belongs to the AI per Anthropic / OpenAI / Google routing-pattern guidance.
- **`dispatchExit` finalizer** — single emission site for the gate button row at the end of dispatch. Every exit kind that lands the session in `awaiting_gate` (initial gate, refine re-render, AI clarifying-question turn) gets the same row. New exit kinds can't forget the buttons.
- **Synthesis prompt reframed to answer-the-question-first.** `buildSynthesisPrompt` and `buildSynthesisReminder` now lead with the gestalt task ("Answer the user's question across the whole graph") with assembly mechanics second. Adds an explicit linear-chain carve-out: when each step `A → B → C → D` transforms differently, keep one section per step instead of compressing the narrative. Mirrored in `aiOutputTemplates.yaml` `sections.instruction` so the AI sees one consistent message in both surfaces.
- **Follow-up prompt made proactive.** `buildFollowUpPrompt` now opens by stating that the original question, the per-node archive, and the rendered result graph are all in context — and that the AI can quote from the archive, browse the catalog, or refine the visualization without restarting. Catalog-lookup tools (`lineage_get_object_detail`, `lineage_search_ddl`, `lineage_search_objects`) are reframed as full follow-up affordances, not footnotes.
- **YAML capture templates rewritten as independent specs.** `business_capture` and `technical_capture` no longer cross-reference each other ("after the X slot"). Each describes one self-contained section. Each template includes a GOOD few-shot example. Sibling-variant detection moved entirely to synthesis (where the AI sees the whole picture).
- **YAML synthesis emits peer sections, not nested subheadings.** When `classification === 'both'`, business and technical content land as PEER entries in `present_result.sections[]` — not as a `#### Technical` subheading inside the business body. The two angles describe different things and stand independently.
- **Quantitative prescriptions removed from prompts.** `general` template's "800–2,000 chars per Columns / logic section" replaced with quality criteria (cover every business rule, every SQL evidence point). `sections` density "2-4 / 4-8 / 10-12" rule replaced with semantic guidance (group similar slots, one per distinct logic). Per the design rule: AI does grouping/order, system does numbers.
- **Active-phase prompt streamlined.** Legacy `writeFindings` block removed — superseded by YAML capture templates. `pruningProtocol` now only injects in SM mode (it referenced a tool not exposed in inline). `buildToolUsageBlock` consolidated to point at the YAML as single source.
- **`prompt-change` skill updated** with audit insights: prompt-vs-data-model integrity rule, capture-vs-synthesis phase split, AI-does-semantic / system-does-quantitative rule, and an 8-point clarity checklist applied to every prompt block before commit.

### Added
- **Discovery-phase refinement loop on `confirm_sm_start`.** The exploration gate now renders the proposed scope as a hierarchical tree (Schema → Type → Node) anchored to a live post-filter hop count, with three buttons — **Approve & Proceed**, **Refine scope**, **Cancel**. *Refine scope* opens the chat input pre-filled with `@lineage refine: ` so the user describes the narrowing in natural language; the AI translates the intent into a full structural re-spec (`excludeTypes` / `excludeSchemas` / `excludeNodeIds` / `passNodeIds` / `forceMode` / `classification` / `targetColumns`), the engine re-runs BFS, and the gate re-emits with the new tree. Loop continues until Approve or Cancel. AI owns add/remove interpretation — no keyword regex in the participant.
- **Three new orthogonal scope-narrowing axes** on `lineage_start_exploration`: `excludeSchemas`, `excludeNodeIds`, and `passNodeIds`. The first two cut the node and any subtree reachable only through it; `passNodeIds` keeps the node in scope, contracts through it to its in-direction bodied neighbours so descendants stay reachable, and the engine auto-emits `verdict:'pass'` so no analysis is written. Default interpretation when the user says "ignore" / "skip" / "don't analyze X". REPLACE semantics across refine rounds — each call overrides prior, AI accumulates by re-sending all prior plus the new one.
- **`forceMode` override** — `'inline' | 'sm'` on `lineage_start_exploration`. Bypasses the size+budget heuristic when the user says "force inline" / "do this as sliding memory".
- **Engine accessor `classifyForRefine(nodeIds[])`** returns `{ prunable, mustPass }` based on alternate-path reachability from origin. The AI consults it before choosing prune vs pass: a node is prunable only when its descendants remain reachable via another path.
- **Engine accessor `getScopeSummary(namesPerType)`** is the single source of truth for the gate detail markdown and the "Scope: N nodes" line — both come from this snapshot so the count and the tree never diverge.
- **Pure renderer `renderScopeSummaryMd(summary)`** in `src/ai/scopeSummaryRenderer.ts` (no `vscode` import) — testable and reusable. 50/50 unit assertions in `tests/unit/refine-loop.test.ts`.
- **Eval cases** `bb-q1-employee-technical.md` and `bb-q1-employee-both.md` exercise the locked-classification paths that were previously untested.
- **Mechanical guards** G11 (classification-locked sections contract) and G12 (slash-command phase gate). Both enforce contracts that prompt prose alone cannot reliably hold.

### Note
- Eval regression gate against `baseline1` is deferred — eval harness migrating to vscode-tester in a separate CR.

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
