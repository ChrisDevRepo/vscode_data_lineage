# Eval Run — 2026-04-06T13:02

**Branch:** testing
**Dacpac:** tmp/AdventureWorks2025_AI.dacpac (148 nodes, 170 edges)
**Tests run:** 5 (new category tests — rejection, scope, output quality)
**Baseline:** 14/14 PASS (from prior run)

## Results

| Test | Grade | Delivery | Key Checks | Notes |
|------|-------|----------|------------|-------|
| rej-ct-focus | **FAIL** | sm | 2/3 nodes_required, self_corrected=true | Only 1 hop completed after focus_mismatch recovery |
| rej-ct-columns | **PASS** | sm | 11 nodes, 6 renames, self_corrected=true | Full trace after invalid_columns recovery |
| scope-bb-external | **PASS** | inline | 23 nodes found | No external nodes reported (WARN) |
| output-ct-chain | **FAIL** | sm | chain_length 6 < min 10 | B-NEW7: Qty branch truncated at SalesStaging |
| ct-always-reject | **PASS** | sm | 3 rejections, 11 nodes, recovery=prune | Full trace after 3x invalid_columns |

**Totals: 3 PASS, 0 PARTIAL, 2 FAIL**

## vs Baseline

| Test | Baseline | Current | Delta |
|------|----------|---------|-------|
| rej-ct-focus | NEW | FAIL | — |
| rej-ct-columns | NEW | PASS | — |
| scope-bb-external | NEW | PASS | — |
| output-ct-chain | NEW | FAIL | — |
| ct-always-reject | NEW | PASS | — |

No regressions (all 14 baseline tests not re-run this session).

## Root Cause Analysis

### Single Root Issue: `shouldInline()` hard gate removes AI agency for CT

**Location:** `src/extension.ts:669-696` (CT), `src/extension.ts:791-817` (BB)

When `shouldInline(scopeDdlChars)` returns true:
1. Extension runs BFS inline (depth 5), dumps all DDL
2. Destroys state machine (`_columnTraceState = null`)
3. Returns `hint: "Do NOT call any more tools"`

The AI has NO ability to request hop-by-hop CT. The extension decides.

**Impact on failures:**
- `output-ct-chain`: AI schema (28 nodes, ~7K tokens) always fits 20K budget → forced inline. Agent gets all DDL at once, doesn't trace Qty branch deeply (B-NEW7).
- `rej-ct-focus`: SM was active (scope exceeded budget in this session config). But focus_mismatch error response omits hop context, forcing agent to reconstruct DDL from memory.

### Sub-Issue: focus_mismatch error missing hop context

**Location:** CT `submitVerdicts()` error path in `columnTraceState.ts`

Error returns `{ error, hint }` only. No DDL, no neighbors, no columns. Agent must recall from prior tool response. After error recovery, attention is consumed → incomplete verdicts.

## Recommendations

### R1: CT always uses SM (never inline) — HIGH PRIORITY

Column tracing is fundamentally per-node reasoning. Inline delivery defeats the purpose.

**Change:** Remove `shouldInline` gate from `start_column_trace` in `extension.ts:669-696`. Always proceed to `getHopContext()`. Keep inline gate for BB (exploration CAN work inline for small scopes).

**Risk:** Low. More tool rounds for small CT, but CT correctness improves.

### R2: Resend hop context on focus_mismatch — MEDIUM PRIORITY

**Change:** In CT `submitVerdicts` focus_mismatch handler, include `hop_context: getHopContext()` in the error response. One-line change.

**Risk:** Very low. More data in error response = easier self-correction.

### R3: Add eval test for SM type selection — LOW PRIORITY

New test: natural language question → verify AI picks CT (not BB) for column questions and BB (not CT) for exploration questions. Currently eval tests preset the tool choice in agent instructions.

## Not Yet Tested (remaining 18 tests)

- 8 AdventureWorks dacpac tests (bb-q1/q2/q4, ct-q3-aw, dep-q1, bb-q6/q8, rej-bb-focus)
- 6 Customer dacpac tests (bb-q5/q7/q9, guard-bb-direct-neighbor, scope-bb-out-of-filter, output-bb-badges)
- 4 tests overlap with baseline (already PASS)

## Next Steps

1. Apply R1 + R2 fixes
2. Re-run rej-ct-focus and output-ct-chain to verify
3. Run remaining 8 AW dacpac tests
4. Update baseline with new results
