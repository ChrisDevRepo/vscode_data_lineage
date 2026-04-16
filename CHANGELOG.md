# Changelog

## [0.9.9] - 2026-04-16

### Improved
- **Enhanced Stability & Performance** — Significant internal updates to the communication layer and graph engine. The app is now more reliable, faster when filtering large databases, and protected against unusually complex SQL patterns.
- **Documentation Overhaul** — Cleaned up public guides to be more user-friendly while moving deep technical details to a private developer resource.

### Added
- **Incremental AI view updates** — You can now ask the AI to add or remove specific tables and update descriptions in an existing graph without restarting the entire analysis.
- **Smarter AI session protection** — Added automatic cleanup for old AI sessions (2-hour timeout) and a confirmation warning if you try to start a new analysis while one is already active.
- **Improved AI "Memory"** — The AI now better remembers its initial findings from the start of a conversation, leading to more consistent results in complex, multi-step traces.

### Fixed
- **Table Statistics Routing & Timeout** — Corrected message routing between the extension host and detail panel to ensure Quick/Standard stats results are displayed. Added a robust timeout mechanism using the `tableStatistics.queryTimeout` setting to prevent hangs on slow connections.
- **Clean slate for new chats** — Starting a new chat window now correctly resets the AI state, preventing buttons or findings from old conversations from appearing.
- **Improved "Show in Graph" button** — The button now only appears when a full AI analysis is ready, and it is correctly hidden after simple table lookups.
- **Smart schema filtering** — The AI can now analyze objects outside your active filters when asked, with better validation to ensure requested schemas exist in your model.
- **Enriched state machine dumps** — Debugging information now includes unique session IDs and timestamps for easier troubleshooting.

### Changed
- **Internal architecture cleanup** — Refactored AI session management for better stability and more reliable state handling across different chat windows.

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
