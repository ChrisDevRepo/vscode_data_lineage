# Changelog

## [0.9.8] - 2026-04-06

### Added
- **Structured graph descriptions** — AI results organized into labeled sections ordered by data flow, with matching badge numbers on nodes
- **"Show in Graph" button** — one-click after AI trace completes

### Changed
- **Faster AI on small scopes** — small traces deliver all data at once; larger scopes use hop-by-hop with persistent memory
- **More accurate AI findings** — citations reference verbatim SQL evidence instead of generic summaries
- **Clearer trace progress** — "visited X of S" replaces fluctuating estimates

### Fixed
- **AI memory reliability** — centralized short memory validation with soft/hard limits; removed silent truncation and duplicated checks
- **Schema-aware AI queries** — `@lineage` scopes searches to active schema filter
- **Find Path ignores filters** — searches the full model regardless of active filters
- **Reliable search from overview** — drill-down from schema overview works without race conditions

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
  HierarchyID methods (`GetAncestor`, `GetDescendant`, `GetLevel`, `ToString`, `Parse`, etc.),
  XML data type methods (`.nodes()`, `.value()`, `.query()`, `.exist()`, `.modify()`), and
  Geometry/Geography spatial methods (`STDistance`, `STArea`, `STIntersects`, etc.) no longer
  appear as virtual external nodes in the lineage graph.

## [0.9.2] - 2026-03-07

### Fixed
- Updated dependencies to address security vulnerabilities reported by GitHub

### Added
- **Table design viewer** — Tables and external tables open in a styled HTML view with column details, constraints, and foreign keys.
- **Table statistics** — Quick Stats (distinct counts, null%) and Detail Stats (+ min/max, string lengths) for database-imported tables, with platform-aware sampling.
- **Table constraint info** — Table design view shows UQ/CK columns and FK section.
- **External Table nodes** — External tables support
- **Virtual external references** — OPENROWSET file paths, cross-database 3-part names
- **External Refs analysis** — New analysis mode listing all file sources and cross-database references grouped by kind and database, with direct neighbors shown per entry
- **Analysis quick-switch** — Icon strip at the top of the analysis sidebar lets you jump between all analysis modes without closing and reopening
- **View/function parser supplement** — body parser runs as fallback for views and functions
- **Schema-grouped neighbor details** — In/Out neighbor list groups by schema; ⊘ marks objects not visible in the current view.

### Changed
- **Catalog-original casing** — Schema and object names displayed exactly as defined in the database.

## [0.9.1] - 2026-02-25

### Changed
- Added Workspace Trust support — extension now works in restricted workspaces

## [0.9.0] - 2026-02-20

### Added
- **Database Import** — Import schema and dependencies from SQL Server, Azure SQL, Fabric DW, or Synapse
- **Quick Reconnect** — Wizard remembers your last data source and offers one-click reopen or reconnect
- **Find Path** — Right-click any node to discover the shortest path to another node
- **Graph Analysis** — Structural insights: islands, hubs, orphans, longest paths, and cycles
- **MiniMap** — Draggable overview map with schema-colored nodes
- **Sidebar** — Quick access to the wizard, demo, and settings
- **Sibling Filter** — Optionally hide unrelated procedures that write to the same table during trace
- **COPY INTO / BULK INSERT** — Recognize bulk-load targets in Fabric, Synapse, and SQL Server

### Changed
- Settings apply automatically when changed — no manual reload needed
- Settings reorganized into Import, Layout, Trace, and Analysis sections

### Fixed
- **More dependencies detected** — Four patterns that previously produced incomplete lineage graphs are now handled correctly:
  - Old-style comma joins (`FROM Orders, Customers`) — all tables now appear as sources, not just the first
  - `DELETE` statements — the deleted table now shows as a write target, giving it the same bidirectional edge as INSERT/UPDATE
  - `OUTPUT INTO` clauses — the audit or staging table receiving OUTPUT rows is now captured as a second write target
  - CTE-based UPDATE (`WITH cte AS (…) UPDATE cte SET …`) — the underlying real table is resolved and recorded as the write target
- **Parser** — SQL cleansing hardened: nested block comments, double-quoted identifiers, and bracket-quoted names with dots (e.g. `[sp.v4.5]`) all handled correctly

## [0.8.2] - 2026-02-14

### Fixed
- **Import feedback** — Status messages for loading, errors, and empty databases

## [0.8.1] - 2026-02-08

### Added
- **Export to Draw.io** — Export the lineage graph as a `.drawio` file with schema-colored left bands, orthogonal curved edges, bidirectional markers, and a schema legend
- **Copy Qualified Name** — Right-click any node to copy `[schema].[name]` to clipboard for quick use in SQL editors

### Fixed
- **Trace Banner** — Immediate trace from search autocomplete now shows the banner so users can exit the trace

## [0.8.0] - 2026-02-08

### Added
- **UDF Detection** — Inline scalar function calls now appear as dependencies in the graph
- **EXEC Return Values** — Procedures called with `@result = proc` are now captured
- **Smarter Edge Directions** — Dependencies that previously showed as undirected now have correct read/write arrows

### Fixed
- **Security** — Upgraded XML parser dependency (CVE-2026-25128)
- **Quoted Identifiers** — Bracket-quoted names with special characters now parsed correctly
- **Short Names** — Short schema or table names (e.g. `hr`, `dim`, `api`) no longer silently dropped
- **DDL Viewer** — Multiple panels now show correct DDL content independently
- **Theming** — Full support for Light+, Dark+, High Contrast Dark, and High Contrast Light
- **Exclude Patterns** — Invalid patterns now logged to the Output window instead of silently ignored
- **Trace** — Fixed edge case when tracing a node not present in the graph

## [0.7.3] - 2026-02-03

### Fixed
- **Animation Settings** — Edge animations now respond correctly to `highlightAnimation` and `edgeAnimation` settings (fixed missing useMemo dependencies)
- **Default Values** — Fallback defaults now match package.json: maxNodes=500, rankSeparation=120, direction=LR

## [0.7.1] - 2026-02-03

- **Demo Data** — Load Demo now uses real AdventureWorks dacpac with DDL viewing
- **Test Data** — Public test folder with AdventureWorks dacpacs (classic + SDK-style)

## [0.7.0] - 2026-02-02

- **Detail Search** — Full-text search panel for SQL bodies of views, procedures, and functions; results grouped by type with code snippets and match highlighting; click a result to zoom to the node in the graph
- **No Red Squiggles** — DDL viewer uses custom `dacpac-sql` language: full SQL syntax coloring without language server diagnostics
- **Node Info Bar** — Right-click → "Show Details" for In/Out/Unresolved/Excluded counts with hover tooltips

## [0.6.x] - 2026-01

- **Fabric + SSDT Support** — Both traditional SSDT and Microsoft.Build.Sql (SDK-style) dacpacs fully supported
- **Interactive Trace** — Click any object to trace upstream/downstream dependencies with configurable depth
- **Schema Focus** — Star a schema to focus on it and its neighbors; filter by schema and object type
- **Smart Search** — Autocomplete with schema/type info and keyboard navigation
- **DDL Viewer** — Stable single-URI viewer with in-place content updates across monitors
- **Custom Parse Rules** — YAML-based SQL extraction rules with regression test suite
- **Case-Insensitive Schemas** — Schema names normalized to uppercase, eliminating duplicates
- **Layout Controls** — Horizontal/vertical toggle, rebuild button, configurable trace defaults

## [0.5.0]

- Initial preview release
