# follow-q3-active-sm-warning

## Question

### Turn 1

> List all objects that directly read or write the Employee table

### Turn 2 (concurrent / before turn-1 completes)

> Trace TotalRevenue column upstream from FactSalesReport

## Classification

| Field | Value |
|-------|-------|
| Type | multi-turn / concurrency smoke test |
| Subtype | Active-SM wipe confirmation — TTL + completion-flag check |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | Turn 1: [HumanResources].[Employee] · Turn 2: [ai].[FactSalesReport] |
| Direction | Turn 1: bidirectional · Turn 2: up |
| Columns | Turn 1: _None_ · Turn 2: [TotalRevenue] |
| Filter | None |

## Expected Outcome

### Turn 2 — while turn 1 is still active (SM incomplete)

| Field | Value |
|-------|-------|
| Expected error | `active_sm_warning` (or similar — wipe confirmation) |
| Reason | Turn 1's SM not `complete` AND not stale (< 2 hours) |
| Recovery | Agent may either wait for turn 1 or explicitly confirm wipe |

### Turn 2 — after turn 1 completes (SM status = complete)

| Field | Value |
|-------|-------|
| Behavior | Turn 1's SM silently reset (no confirmation needed) |
| SM Type | ct_columns (new SM for turn 2) |
| Delivery | sm (sliding — ct-q1 baseline) |
| Reason | Status=complete → `resetIfStale()` path |

## Fact Check (verified 2026-04-16)

- `AiSession.isStale()` returns true when session age > 2 hours
- `toolProvider.ts` wipe-confirmation guard (lines 272-283): fires when `sess.stateMachine && status !== 'complete' && !isStale()`
- `resetIfStale()` silently resets when SM is complete OR stale — no confirmation
- Proxy proxies the confirmation via tool response — it is NOT a VS Code modal dialog in the proxy context
- Known limitation: real VS Code shows an async confirmation popup; proxy shows `confirmationMessages` field in the response

## Required Behavior

1. When turn-1 SM is active (`status !== 'complete'` AND not stale):
   - `lineage_start_column_trace` response must include a wipe-active-SM warning/confirmation
   - SM state in proxy should be unchanged (turn 1's SM still present)
2. When turn-1 SM is complete:
   - New SM is created for turn 2
   - Turn 1's `resultGraph` remains accessible (not overwritten until `storeCtResult()`)

## Required Nodes

_Not applicable — this is a concurrency/lifecycle test._

## Forbidden Nodes

_None._

## Optimal Path

### Scenario A (SM active, mid-flow)
1. Turn 1 calls start_exploration, goes through a few hops
2. BEFORE turn 1 completes, turn 2 calls start_column_trace
3. Tool confirmation message blocks or warns
4. Agent interprets warning, either resumes turn 1 or confirms

### Scenario B (SM complete)
1. Turn 1 completes normally (bb-q1 → enrich_view → done)
2. Turn 2 calls start_column_trace — no warning, silent reset
3. New CT SM created, trace runs

## Known Limitations

_The real VS Code extension shows a VS Code dialog for the wipe. In the proxy, the response includes the confirmation message as a `confirmationMessages` field. This test validates that behavior is exposed correctly over HTTP._
