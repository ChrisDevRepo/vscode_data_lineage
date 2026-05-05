# Changelog

## [1.0.0] - 2026-05-05

### Changed
- **Discovery is now the primary state, SM is opt-in.** Most ad-hoc questions are answered directly in chat using catalog tools. The `confirm_sm_start` consent gate is triggered only when the user asks for a graph render, a detailed multi-object analysis, or column tracing — or when the engine rejects an over-budget catalog request. SM internal phases (active hops + synthesis) only fire after gate approval.
- **Discovery chat output is YAML-tunable.** The new `discovery_chat` key in `aiOutputTemplates.yaml` controls answer length, citation discipline, single-vs-balanced format, and the biz/tech/math reference shapes used in chat prose.
- **BFS asymmetric depth.** `lineage_start_exploration` now accepts `upstream_depth` and `downstream_depth` overrides for `direction='bidirectional'` — e.g. "all upstream, 2 downstream".
- **Formulas render reliably in the result panel** — mathematical expressions in AI descriptions now render consistently. Dollar signs in SQL and business text (amounts, column names) no longer produce rendering artifacts in the result panel.

### Removed
- **Inline mode** — replaced by the discovery-vs-SM split above. The `dataLineageViz.ai.inlineTokenBudget` and `inlineNodeCap` settings are removed; small-scope answers stay in discovery, larger scopes go through SM after the consent gate. Single execution path = simpler contract.

### Added
- **Discovery budget guard.** Per-tool boundary check at `lineage_get_neighborhood` / `lineage_search_ddl`: over-budget catalog requests (default `dataLineageViz.ai.discoveryNodeCap=8` / `discoveryTokenBudget=8000`) are hard-rejected with a structured `over_discovery_budget` envelope pointing the AI at `lineage_start_exploration`.


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
