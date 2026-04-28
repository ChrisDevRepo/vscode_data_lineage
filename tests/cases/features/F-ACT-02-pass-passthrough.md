# F-ACT-02-pass-passthrough

## Question

> Show me the lineage of `[ai].[FactSalesReport]` upstream depth 3. Don't include passthrough / wire-only nodes that just SELECT from a single source without transformation.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Active → AI applies pass verdict for SELECT-* / synonym nodes |
| Persona | analyst |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |
| Direction | upstream |

## Expected Outcome

| Field | Value |
|-------|-------|
| `submit_findings(verdict=pass)` calls | ≥ 1 (at least one wire-only node visited) |
| Pass-tagged nodes appear in `present_result.nodes[]` but consolidated under "Passthrough / Pruned" subsection in description |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |

## Required Nodes

- [ai].[FactSalesReport]
- At least one upstream node where the DDL is essentially `SELECT * FROM <single_source>` or `CREATE SYNONYM`.

## Forbidden Nodes

_None — pass nodes are not removed, just consolidated._

## Optimal Path

1. start_exploration → gate (if scope > 10) → approve.
2. Hop on FactSalesReport → analyze.
3. Hop on upstream wire node → AI inspects DDL — finds it's `SELECT * FROM ...` with no transformation → emits `verdict='pass'`, badge_label="Passthrough", note_caption="Passthrough — copies from <source>".
4. Continue hops; analyze nodes where business logic lives.
5. Synthesis: pass nodes are listed under a `### Passthrough / Pruned` subsection per `prompts.ts buildSynthesisPrompt` rule, NOT given their own section entry.

## Verification Rules

- ≥1 `submit_findings` with `verdict='pass'`.
- Pass nodes have `note_caption` mentioning passthrough/wire role.
- `present_result.description` contains a `Passthrough / Pruned` heading or equivalent consolidation.
- `present_result.sections[].text` does NOT enumerate pass-node bodies (the synthesis rule "render as one-line mentions inside a `### Passthrough / Pruned` subsection — do not expand their text").

## Engine guards exercised

- Verdict=pass handling in `submit_findings` — node visited but body not captured for synthesis lift.
- Synthesis prompt rule on pass-slot consolidation.

## Harness

Real-Haiku capture turns required to validate the AI's verdict reasoning. Canned orchestrator can simulate via name pattern (e.g. `vBare*` → pass) but the case's intent is to verify the AI inspects DDL and makes a content-based judgement.

## Known Limitations

`pass` verdict requires DDL inspection — the AI must call `lineage_get_neighbor_columns` for tables/views or accept the focus DDL for procs/functions. If the AI shortcuts to pass without inspection, it's a content-quality finding (B-axis), not an engine bug.

## Evaluation Notes

Validates the verdict-trichotomy (analyze / pass / prune) per `BLOCK.verdictCategories`. Pass is the trickiest verdict because it requires the AI to recognize "this is a wire" without overspending on capture.
