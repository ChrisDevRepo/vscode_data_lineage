# Changelog

## [Unreleased] - optimization branch

### Added
- **"Show full description" chip** — after every `@lineage` response that produced a graph view, a second chat chip renders the full AI description 1:1 inline. No re-analysis, no extra LM call — the description is captured when the view is created and replayed verbatim on click. Complements the existing "Detailed explanation (N)" chip (which extends the scope via deferred questions).
- **Metadata band above sections** — every `enrich_view` description now starts with an `**In:** … / **Out:** … / **Loading Pattern:** …` banner between the intro and the first section. In/Out are direct graph neighbors of the origin (object-level, not column-level). Loading Pattern is AI-inferred and only appears when the origin is a stored procedure — views and UDFs skip the line. Empty neighbor sets render as `(none — root node)` / `(none — terminal node)`.
- **Per-section object table** — when a section groups two or more nodes under one label, the render layer prepends a `| Object | In | Out |` table showing each node's direct graph neighbors. Clarifies variant-sibling families at a glance. Single-object sections skip the table — redundant with the badge + section title.
- **Technical subsection (classification-driven)** — when the session is classified as `technical` or `both`, each `enrich_view` section includes a `#### Technical` block: SQL code snippets (not full statements), LaTeX formulas, variant delta-mode wording, performance observations (Hash/Nested Loop joins, Cartesian warnings, DISTINCT/OR antipatterns, distribution hints). NO NEW FACTS — archive stays the sole evidence. Column I/O tables, nullability/precision prose, and full SQL statements remain out of scope.
- **Mission-type classification gate** — at the active→synthesis transition `@lineage` infers the mission type (`business` | `technical` | `both`) from the user's question and mission brief. Inline mode streams a one-line banner (`> Starting analyze phase — <kind>-driven.`); SM mode folds the signal into the existing `confirm_sm_start` messaging. No chip, no user override — re-ask the question for a different angle.
- **YAML-driven capture rules** — `aiOutputTemplates.yaml` now drives both what the AI writes into `detail_analysis` per hop (capture phase) AND how the final enrich_view document renders (synthesis phase). Four new keys split the work by phase: `business_capture` + `technical_capture` fire at the active hop loop (capture rules); `business_subsection` + `technical_subsection` fire at synthesis (render rules). Users edit the YAML to change either what gets archived or how it gets rendered; edits to capture keys flow end-to-end because the archive is the sole evidence at synthesis. `BLOCK.writeFindings` in `smPrompts.ts` slimmed to engine invariants only (archive is sole evidence, NO NEW FACTS, mission_brief anchor, pass/irrelevant verdict shortcuts). Content rules (formulas, column renames, SQL snippets, DDL observations, join types, antipatterns, distribution hints) moved to the YAML capture keys.

### Changed
- **Deferred follow-ups now fire for NL-filtered dependencies** — when the user's question included an NL filter like `ignore UDFs and views`, `@lineage` was silently dropping references to out-of-scope objects instead of deferring them. The "Detailed explanation (N)" chip consequently stayed hidden. `@lineage` now still won't *analyze* filter violators, but if one is a meaningful dependency for the mission it lists it as a deferred follow-up the user can click to review.
- **Cancellation-aware chat handler** — pressing Stop (or starting a new prompt mid-answer) no longer produces a red `*Error: Response stream has been closed*` bubble in chat. The handler observes VS Code's cancellation signal, exits cleanly as a typed `cancelled` state, and logs a single `Chat response cancelled by user` line instead of escalating to an error. Same behavior when VS Code tears the stream down for any other reason (host reload, etc.).

### Documentation
- **Two-mode contract documented** — `docs/AI_ARCHITECTURE.md`, `docs-internal/AI_IMPLEMENTATION.md`, and `README.md` now clearly describe the split between inline mode (small scope, AI decides completion via `complete: true`, per-route yes/no when stepping outside your filter schemas) and hop-by-hop SM mode (large scope, user-approved upfront with `confirm_sm_start`, closed-loop with deferred follow-up chips at synthesis). No behavior change — the contract was already in the code since 0.9.9; docs caught up.

### Internal
- `src/ai/chatResponseWriter.ts` — new `ChatResponseWriter` class owns the `ChatResponseStream` + `CancellationToken` lifecycle; encapsulates `open | cancelled | closed` states as a discriminated union; every `stream.markdown / progress / button` call in `lineageParticipant.ts` routes through it. `HopLoopExit` extended with a first-class `cancelled` variant so `dispatchExit` handles user-cancel via exhaustive switch, not caught exceptions.
- `AiSession.lastEnrichViewDescription` — stores the last successful enrich_view description for the "Show full description" chip. Cleared on `resetExploration()`.
- `AiSession.classification` — mission-type field (`business | technical | both`), Zod-validated at `setClassification()`. Cleared on `resetExploration()`.
- `src/ai/templateRenderer.ts` — graph-topology projection helpers (`renderMetadataBand`, `renderSectionObjectTable`, `shouldEmitLoadingPattern`). Pure projection; no content decisions.
- `src/ai/classification.ts` — `ClassificationSchema` (Zod enum), `inferClassificationFromText()` heuristic, `CLASSIFICATION_BANNER` text lookup.
- Five new `aiOutputTemplates.yaml` keys: `loading_pattern`, `business_capture`, `business_subsection`, `technical_capture`, `technical_subsection` — phase-pure instruction blocks. `*_capture` ship at ACTIVE (capture rules); `*_subsection` ship at SYNTHESIS (render rules). Each key declares its `stages:` list as informational; canonical routing lives in `STAGE_BY_KEY` in `src/ai/templateRenderer.ts`. Overlays that contradict canonical routing are logged and ignored; fallback on malformed user YAML shows a VS Code notification and reverts to shipped defaults.
- Branch workflow — `restore-0.9.8-quality` frozen on remote as `baseline1`; `optimization` forked from it for ongoing work.
- Local-only dev tool: `.claude/skills/iteration-review/SKILL.md` — automates the UAT baseline-vs-iteration comparison (content quality first, tokens/duration second). Not shipped (`.claude/` is gitignored).

## [0.9.9] - 2026-04-18

### Added
- **Scope budget + consent gate** — Before long explorations, `@lineage` surfaces the planned scope (nodes, schemas, depth) and asks for confirmation. Reply `yes` to proceed, `no` to pause, or ask a different question to redirect.
- **Natural-language depth handling** — "direct neighbors", "one level", or explicit type filters ("ignore UDFs and views") are honored structurally at the engine level, not just as prose hints.
- **Mission briefing** — When exploration starts, `@lineage` writes a short plan (intent, scope, filters) that survives context wipes on long multi-hop sessions.
- **Deferred follow-ups** — When `@lineage` encounters references outside the approved scope, it surfaces them as clickable follow-up chips below the response. One click investigates the specific object.
- **Incremental AI view updates** — Ask the AI to add or remove specific tables in an existing view without restarting the analysis.

### Changed
- **Modernized logging engine** — OOP architecture; preserves all existing diagnostics.
- **Modular extension bridge** — UI-bridge logic decomposed into specialized modules for easier maintenance.
- **AI session management** — 30-minute session timeout with automatic cleanup; starting a new exploration while a previous one runs discards the old findings with an in-chat notice (no blocking dialogs).


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
