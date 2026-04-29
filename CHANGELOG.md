# Changelog

## [0.9.9] - 2026-04-26

### Added
- **Pick the analysis lens before exploration** — Choose `business`, `technical`, or `both` when starting a `@lineage` exploration. Business reports describe domain meaning (rules, formulas, consumer impact). Technical reports describe execution (SQL evidence, joins, loading patterns, anti-patterns). `both` produces two peer sections per node, one of each angle.
- **Approve scope before analysis starts** — Every exploration shows a scope tree (Schema → Type → Node) with the live hop count. Approve to proceed, **Refine scope** to narrow it, or **Cancel**. Describe the narrowing e.g. ("ignore staging", "drop UDFs", "trace ProductID only") and the assistant re-runs. The loop continues until you approve or cancel.


### Changed
- **Faster, more focused AI hops** — each exploration step sends a leaner context to the model by routing only the templates relevant to the locked analysis angle and removing repeated guidance the engine already enforces structurally.
- **Starting-point table summaries** — When you ask about a table as your starting point, `@lineage` produces a clean dossier (Purpose, Columns, Upstream sources, Downstream consumers, Grain / keys) instead of folding it into a neighbouring procedure's analysis.
- **AI output templates expanded** — `aiOutputTemplates.yaml` now drives both per-hop capture instructions (`business_capture`, `technical_capture`, `structural_summary`) and final report rendering (`title`, `intro`, `closing`, `notes`, `highlights`). Previously it only controlled report rendering; per-hop analysis content required source edits.
- **Unified exploration engine** — the three separate state-machine classes (Blackboard, Column Trace, and their abstract base) are merged into a single `NavigationEngine` with mode variants (Inline, SM-Blackboard, SM-Column-Trace). Classification locking, scope approval gate, and the Detail Archive memory model are shared across all modes.
- **Typed extension-webview messaging contract** — all messages between the extension host and the graph UI are now defined in a single Zod-validated schema; replaces untyped `postMessage` calls so malformed messages are caught at the boundary instead of causing silent UI failures.
- **Full conversation history retained** — `@lineage` no longer drops older turns from active context; the assistant remembers the whole session.
- **Cleaner cancellation** — Pressing Stop mid-response exits cleanly — no "stream closed" error.

## [0.9.8] - 2026-04-12

### Added
- **Structured graph descriptions** — AI results organized into labeled sections ordered by data flow, with badge numbers on nodes
- **"Show in Graph" button** — one-click after AI trace completes

### Changed
- **Inline mode for small scopes** — small traces deliver all DDL at once; larger scopes use hop-by-hop with persistent memory

### Fixed
- Schema-aware AI queries, Find Path ignoring active filters, search visibility in schema overview

## [0.9.7] - 2026-03-31

### Added
- **Column metadata for views & TVFs** — column details in the detail panel with columns/DDL toggle
- **`@lineage` column tracing** — follow columns hop-by-hop through views, procedures, and functions, tracking renames and transformations

### Fixed
- CTE `UPDATE alias SET … FROM cte_name` patterns now produce correct write edges

## [0.9.6] - 2026-03-27

### Added
- **Schema overview** — graphs with 150+ nodes open as a schema-level bubble map; double-click to drill in
- **`@lineage` AI assistant** — natural-language lineage questions in GitHub Copilot Chat. Requires GitHub Copilot and VS Code 1.95+
- **AI output templates** — customize `@lineage` output format via `dataLineageViz.ai.outputTemplateFile`
- **Platform detection** — identifies SQL Server, Azure SQL, Fabric, and Synapse from dacpac and live connections

## [0.9.5] - 2026-03-24

### Added
- **Project sessions** — save connections and schema selections as named projects
- **Saved Views** — save and restore filter states (schemas, types, exclusions) per project
- **Exclusion Rules** — hide nodes by `%` wildcard or regex pattern in real time

## [0.9.4] - 2026-03-12

### Fixed
- BFS trace non-deterministic results from co-writer filter; direction-aware edge filtering restored

## [0.9.3] - 2026-03-08

### Fixed
- False-positive external cross-DB nodes from SQL Server CLR type method calls

## [0.9.2] - 2026-03-07

### Added
- **Table design viewer** — column details, constraints, and foreign keys for tables and external tables
- **Table statistics** — Quick and Detail stats for database-imported tables with platform-aware sampling
- **External tables & virtual refs** — OPENROWSET file paths and cross-database 3-part names surfaced as nodes
- **External Refs analysis** — lists all file sources and cross-database references

## [0.9.1] - 2026-02-25

- Workspace Trust support

## [0.9.0] - 2026-02-20

### Added
- **Database Import** — SQL Server, Azure SQL, Fabric DW, Synapse
- **Find Path** — shortest dependency path between any two nodes
- **Graph Analysis** — islands, hubs, orphans, longest paths, cycles

## [0.8.x] - 2026-02

- Export to Draw.io, UDF detection, EXEC return values, correct read/write edge directions

## [0.7.x] - 2026-02

- Detail Search, Node Info Bar, Demo Data, `dacpac-sql` language

## [0.6.x] - 2026-01

- Fabric + SSDT support, Interactive Trace, Schema Focus, Smart Search, DDL Viewer, Custom Parse Rules

## [0.5.0]

- Initial preview release
