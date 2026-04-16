# bb-inline-q3-errorlog

## Question

> What writes to the ErrorLog table?

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | Naturally small scope — no filter needed |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [dbo].[ErrorLog] |
| Direction | upstream |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) — scope ≤ 10 |
| Scope | 2–5 nodes |
| Max hops | 1 (inline batch) |
| Filter expected | No |
| Required tools | lineage_start_exploration, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 60000 |
| Max hop-avg tokens | 4000 |

## Fact Check (verified 2026-04-16)

- Origin: [dbo].[errorlog] ✓
- Filter: none
- **scope: 5 nodes** → inline ✓
- uspLogError, uspPrintError present in model ✓
- Delivery: inline (confirmed)

## Required Nodes

- uspLogError
- uspPrintError

## Forbidden Nodes

_None — this test explicitly wants the error SPs._

## Optimal Path

1. Search for ErrorLog → find [dbo].[ErrorLog]
2. start_exploration upstream — only 2-3 nodes (uspLogError, uspPrintError) write to it
3. Inline delivery automatic
4. enrich_view showing error-handling pipeline

## Known Limitations

_This test validates that the "forbidden nodes" list in other tests (uspLogError, uspPrintError) is context-dependent — those are irrelevant to business questions but relevant when asked about ErrorLog directly._
