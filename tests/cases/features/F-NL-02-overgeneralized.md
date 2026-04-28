# F-NL-02-overgeneralized

## Question

> Trace upstream from `[ai].[FactSalesReport]` depth 3 but skip `uspLogError`, `uspPrintError`, and `RECON`.

(User named 3 identifiers — exactly as F-NL-01 — but the AI mis-translates to a type-blanket.)

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Discovery → AI passes excludeTypes when user named identifiers → engine rejects |
| Persona | n/a — this case tests AI failure mode |
| Difficulty | hard (negative test) |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome (this is a NEGATIVE test — engine rejection expected)

| Field | Value |
|-------|-------|
| `start_exploration` returns | `error: nl_filter_overgeneralized, hint: "use excludeNodeIds — user named identifiers, not a type blanket"` |
| AI recovers | re-calls with `excludeNodeIds[]` (per F-NL-01 path) |
| Final result | identical to F-NL-01 |

## Required Nodes (after recovery)

Same as F-NL-01.

## Optimal Path

1. AI mis-translates "skip uspLogError, uspPrintError, RECON" → `excludeTypes: ['procedure']`.
2. Engine `init()` detects user-named-identifiers + AI passed `excludeTypes` → returns structured rejection envelope `nl_filter_overgeneralized` with hint.
3. AI reads the hint, re-calls `lineage_start_exploration` with `excludeNodeIds[]` resolved per F-NL-01.

## Verification Rules

- Bridge JSONL contains exactly 1 rejection envelope `error: 'nl_filter_overgeneralized'` after the first `lineage_start_exploration`.
- Second `lineage_start_exploration` in the same turn carries `excludeNodeIds` (recovery).
- `[AI] [Engine] [BFS]` log line emits `excludeTypes=[]` after recovery.

## Engine guards exercised

- `nl_filter_overgeneralized` rejection (per `code-quality.md` "Mechanical Enforcement Over Prompt Language" table).

## Harness

Real-Haiku required to produce the over-generalization behavior naturally. Auto-orchestrator's canned heuristic does NOT replicate the failure mode — the rejection wouldn't fire.

## Evaluation Notes

Negative test — designed to verify the engine's rejection envelope fires correctly when the AI overreaches. Pairs with F-NL-01 to bracket the correct vs incorrect translation paths.
