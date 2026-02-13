# Changelog

## [0.8.2] - 2026-02-13

### Added
- **Graph Analysis** — New analysis toolbar button with three modes: Islands (find disconnected subgraphs), Hubs (identify most-connected nodes), and Orphan Nodes (reveal objects with no dependencies)

### Fixed
- **Import feedback** — Wizard now shows status messages when loading a .dacpac, including errors for corrupt files and warnings for empty databases

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
- **Default Values** — Fallback defaults now match package.json: maxNodes=250, rankSeparation=120, direction=LR

## [0.7.1] - 2026-02-03

- **Demo Data** — Load Demo now uses real AdventureWorks dacpac with DDL viewing
- **Test Data** — Public test folder with AdventureWorks dacpacs (classic + SDK-style)

## [0.7.0] - 2026-02-02

- **Detail Search** — Full-text search panel for SQL bodies of views, procedures, and functions; results grouped by type with code snippets and match highlighting; click a result to zoom to the node in the graph
- **No Red Squiggles** — DDL viewer uses custom `dacpac-sql` language: full SQL syntax coloring without language server diagnostics
- **Node Info Bar** — Right-click → "Show Details" for In/Out/Unresolved/Excluded counts with hover tooltips

## [0.6.x] - 2026-01

- **Fabric + SSDT Support** — Both traditional SSDT and Microsoft.Build.Sql (Fabric SDK) dacpacs fully supported
- **Interactive Trace** — Click any object to trace upstream/downstream dependencies with configurable depth
- **Schema Focus** — Star a schema to focus on it and its neighbors; filter by schema and object type
- **Smart Search** — Autocomplete with schema/type info and keyboard navigation
- **DDL Viewer** — Stable single-URI viewer with in-place content updates across monitors
- **Custom Parse Rules** — YAML-based SQL extraction rules with regression test suite
- **Case-Insensitive Schemas** — Schema names normalized to uppercase, eliminating duplicates
- **Layout Controls** — Horizontal/vertical toggle, rebuild button, configurable trace defaults

## [0.5.0]

- Initial preview release
