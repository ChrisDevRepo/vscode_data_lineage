# Changelog

## [1.0.1] - 2026-05-20

### Added
- **Detail Search: scope dimming.** Results from schemas/nodes outside the active filter now render dimmed with a ⊘ "Not in current view" separator, consistent with Quick Jump.

### Fixed
- SM BB-mode: `bb_field_unknown` guard now fires before Zod parsing; corrective injection includes a BB-mode reminder so the AI does not resubmit `column_flow` after a forced bounded wipe
- SM route validation: `route_validation_failed` hint now identifies graph-absent nodes explicitly, preventing casing-variant retry loops that exhaust the 3-error budget

## [1.0.0] - 2026-05-12

### Changed
- **Chat-first answers.** Lineage questions return structured Markdown in chat by default; the graph panel and walkthrough only launch when explicitly requested.
- **Asymmetric depth tracing.** Specify independent upstream/downstream depths in a single request (e.g. "3 upstream, 1 downstream").
- **Schema color palette expanded to 15 colors** for both light and dark themes; schemas beyond the 10th now map to a second set of lighter paired variants, giving each additional schema a distinct color.

### Added
- **One-click deeper analysis.** Post-discovery pill launches the hop-by-hop walkthrough with scope preview and consent gate — no need to re-type the question.
- **Persistent discovery context.** The AI carries a memo of the discovery findings and any focus/exclusion instructions through every hop of the walkthrough.
- **Customizable chat output** via `aiOutputTemplates.yaml`.

### Removed
- **Inline mode** — superseded by the chat-vs-walkthrough split.


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
