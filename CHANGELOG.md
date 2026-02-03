# Changelog

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

## [0.5.0] - 2026-01-31

- **Native SQL Viewer** — View DDL with syntax highlighting, Ctrl+F, and multi-monitor support
- **SQL Viewer Toolbar** — Dedicated button + smart updates when clicking nodes
- **Complete DDL Generation** — Full CREATE statements for views, procedures, and functions
- **Interactive Trace** — Click any object to highlight upstream/downstream dependencies with depth control
- **Smart Search** — Autocomplete with schema/type info and keyboard navigation
- **Schema & Type Filtering** — Multi-select schema filter and type toggles
- **Layout Options** — Toggle horizontal/vertical layout, resizable panels
- **Source Navigation** — Right-click to jump to SQL definition files
- **Custom Parse Rules** — YAML-based extraction rules for custom SQL patterns
- **Theme Support** — Automatic VS Code light/dark theme adaptation
