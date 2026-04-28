# F-ACT-03-route-reject-recover

## Question

> Trace upstream from `[ai].[FactSalesReport]` depth 2.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Active → invented nodeId → fuzzy candidate → recovery |
| Persona | n/a — negative test |
| Difficulty | hard (negative test) |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [ai].[FactSalesReport] |

## Expected Outcome

| Field | Value |
|-------|-------|
| One `submit_findings` call has `route_requests` with an invented `nodeId` | yes (e.g. `[ai].[vwPriceList]` when the real id is `[Sales].[vwPriceList]`) |
| Engine returns | `error: route_validation_failed, route_target_candidates: { '[ai].[vwPriceList]': ['[Sales].[vwPriceList]'] }` |
| AI recovers | uses the candidate verbatim in next `submit_findings` |
| Final agenda includes the resolved id | yes |

## Optimal Path

1. Hop on FactSalesReport → analyze.
2. AI emits `submit_findings` with `route_requests: [{ nodeId: '[ai].[vwPriceList]', question: 'price source' }]` (id mis-prefixed — real prefix is `[Sales]`).
3. Engine `submitFindings` validates routes → unresolved → builds fuzzy candidates via `levenshtein` + `fuzzyMatchNodeIds(target, scopeNodeIds, 3)`.
4. Returns `error: 'route_validation_failed'` envelope with `route_target_candidates: { '[ai].[vwPriceList]': ['[Sales].[vwPriceList]'] }`.
5. AI reads the envelope, picks the candidate verbatim, re-submits with corrected nodeId.
6. Route accepted; agenda extended.

## Verification Rules

- Bridge JSONL contains 1 `error: 'route_validation_failed'` envelope.
- Envelope carries `route_target_candidates` with at least 1 candidate per unresolved id.
- Next `submit_findings` (same turn) uses the candidate id verbatim — no further fuzzy-mismatch.
- `route_target_candidates` does NOT contain the AI's invented id (must be a real in-scope node).

## Engine guards exercised

- `route_validation_failed` rejection (CR-B1).
- `route_target_candidates` fuzzy candidates (CR-B2 — top-3, distance ≤ max(3, len·0.4), pool = `scopeNodeIds`).
- AI cooperative-side recovery via candidate read (the protocol the prompt-side JSDoc + tool description teach).

## Harness

Requires real-Haiku capture turn — canned orchestrator never invents ids. Without real-Haiku, `route_target_candidates` payload is never exercised.

## Evaluation Notes

Validates the CR-B2 envelope end-to-end. The mechanical side (envelope contents) is testable without AI; the **cooperative side** (does the AI use the candidate?) requires real-Haiku.
