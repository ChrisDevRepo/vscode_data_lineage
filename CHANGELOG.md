# Changelog

## [0.7.4] - 2026-02-07

### Fixed
- **Security** — Upgraded XML parser dependency to address CVE-2026-25128
- **DDL Viewer** — Multiple panels now show correct DDL content independently
- **Parser** — Short table/schema names (e.g. `hr`, `dim`, `api`) no longer silently dropped
- **Theming** — Full support for Light+, Dark+, High Contrast Dark, High Contrast Light
- **Config** — Invalid exclude patterns now logged to Output window instead of silently ignored
- **Trace** — Fixed edge case when tracing a missing node
- Bidirectional edge layout now uses write direction
- Async file loading in extension host
- Various React rendering and cleanup fixes

### Removed
- Dead code cleanup

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
