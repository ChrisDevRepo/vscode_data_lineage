# Changelog

## [1.0.0] - 2026-05-05

### Changed
- **Chat is the default — graphs only when you ask.** Most lineage questions get a quick chat answer summarizing the loaded model. The side-panel graph and consent gate now fire only when you ask for a visual render, request column tracing, or open a scope too large for chat.
- **Discovery answers read like a structured memory of what was inspected.** Multi-object dependency questions ("trace upstream from X two levels", "what feeds Y") return as Markdown with one heading per node visited — business meaning, technical execution, formulas in math fences, column-rename tables, and ⚠️ data-quality flags inline.
- **Trace any direction depth combination.** Ask for "all upstream, 2 downstream" or any other up/down combination — both bounds are honoured independently in one request.

### Added
- **One-click "deeper analysis" path.** After the chat answers a multi-object dependency question, a follow-up "Start deeper hop-by-hop analysis" pill appears under the answer. Clicking it walks the same graph through the structured renderer with consent gate, scope preview, and the rendered detail panel — no need to re-type the question.
- **The walkthrough remembers what you said in chat.** Once you approve the structured walkthrough, the AI composes a short memo of the chat question, what was already found, and any "ignore X / focus on Y / be careful with Z" you mentioned during the chat. That memo rides every hop of the walkthrough so the analysis stays anchored to your intent — even when the AI reaches a node that wasn't on the original ignore list.
- **Customizable chat-answer style.** Tune the discovery chat output (length, structure, framing references, rendering primitives like math fences and rename tables) via `aiOutputTemplates.yaml` — the same template surface that drives the rendered SM detail, so chat and graph share consistent formatting.

### Removed
- **Inline mode** — superseded by the chat-vs-walkthrough split. One execution path now: chat for ad-hoc and dependency questions, the structured walkthrough for visual renders, column traces, and over-budget scopes.


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
