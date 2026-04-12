# CT (Column Trace) State Machine — Deep Analysis

## 1. How CT Works Today (Lifecycle)

```
start_column_trace(origin, columns, direction)
  │
  ├─ scope small? ──→ INLINE: return BFS + all DDL (no SM, AI analyzes at once) ✅ works
  │
  └─ scope large? ──→ SM MODE: init() → seed frontier with origin's neighbors
                        │
                        ↓
                    getHopContext()  ← pops FIFO frontier
                        │              returns: focus_node{id,DDL,cols} + neighbors[] + active_columns
                        ↓
                    AI reads DDL, decides per neighbor:
                        trace(columns_to_trace) → add to frontier
                        prune → remove + cascade
                        pass → auto-queue children
                        revisit → restore pruned node
                        │
                        ↓
                    submitVerdicts(focus_node_id, verdicts[])
                        │
                        ├─ validate focus_node_id matches current
                        ├─ validate columns exist on neighbor (tables/views only)
                        ├─ after 2 rejections per hop → accept on trust
                        ├─ update frontier, chain, cascade prunes
                        └─ return {ok, advanced, frontierSize}
                        │
                        ↓
                    getHopContext() again (next frontier entry)
                        ... repeat until frontier empty ...
                        │
                        ↓
                    getResult() → chain[] with columnsIn/Out per node + edges + stats
```

**Key properties:**
- Frontier: FIFO array (`.shift()` to pop, `.push()` to add) — NOT priority queue
- Column validation: only on tables/views that have column metadata; SPs skip validation on SP→SP exec edges; after 2 rejections → accept on trust
- No backtracking: once a hop is processed, can't revisit (except explicit `revisit` verdict for pruned nodes, max 3)
- `path_so_far`: reconstructed each hop — shows chain entries + passthroughs, but NOT the raw DDL from prior hops

## 2. CT SM Code Details

### columnTraceState.ts (897 lines)

**init() — lines 148-280:**
- Validates direction, resolves origin, runs BFS scope, seeds frontier
- Frontier entries: `{ nodeId, activeColumns: [...targetColumns], depth: 1, parentNodeId: originId }`
- Origin added to chain with `columnsIn: targetColumns`

**getHopContext() — lines 284-443:**
- Pops FIFO frontier (`.shift()`)
- Skips visited/pruned/missing nodes
- Sets `currentFocusNodeId`, `currentFocusActiveColumns`, `currentFocusDepth`
- Returns: `{ trace_status, action_required, focus_node: { id, s, n, t, DDL, cols, active_columns }, neighbors[], path_so_far[], sub_question }`
- Status → 'awaiting_verdicts'

**submitVerdicts() — lines 447-677:**
- Validates: status check (line 461), focus_mismatch (line 465), per-verdict column validation
- Column validation: fetch neighbor columns → case-insensitive check → reject with `{ error: 'invalid_columns', invalid: [], valid: [] }`
- MAX_REJECTIONS_PER_HOP = 2 → after that, accept on trust (line 513)
- SP→SP exec edge → skip column validation (line 504)
- Verdict processing: trace → add to chain + frontier; prune → removedSet + cascade; pass → auto-queue children; revisit → restore from prunedEntries
- Returns: `{ ok: true, advanced, frontierSize }`

**getResult() — lines ~695+:**
- Returns full chain with columnsIn/Out per node + edges + stats

### Key response structure (what AI sees)

The hop context nests the focus node ID:
```json
{
  "focus_node": {
    "id": "[ai].[spbuildsalesreport]",  ← AI must extract THIS
    "s": "ai",
    "n": "spBuildSalesReport",
    ...
  }
}
```

The AI must submit it as a flat field:
```json
{
  "focus_node_id": "[ai].[spbuildsalesreport]"  ← and send it HERE
}
```

### BB comparison

BB has the SAME nesting (`focus_node.id` → submit as `focus_node_id`). But BB works because:
- BB mode prompt is 30+ lines with explicit field instructions
- CT mode prompt is 5 lines with no field mapping guidance
- BB verdict model is simpler (3 types: relevant/noted/irrelevant) vs CT (4 types + column tracking)

## 3. CT Code Footprint

| Component | Lines | CT-only? |
|-----------|-------|----------|
| columnTraceState.ts | 897 | Yes |
| CT handlers in extension.ts | ~195 | Yes |
| CT defs in package.json | 52 | Yes |
| column-trace-state.test.ts | 1,126 | Yes |
| smGuards.ts | 253 | Shared (BB needs all of it) |
| buildHopFocusNode (tools.ts) | 25 | Shared (BB uses it) |
| **Total CT-specific** | **~2,150** | |

Removing CT has zero impact on shared code — BB uses all shared utilities.

## 4. Rejection Analysis Framework

### Classification

| Classification | Meaning | Action |
|---------------|---------|--------|
| **HALLUCINATION** | AI invented a value not in model or SM response | Model limitation. Count it. |
| **DESIGN_CONFUSION** | Correct value was in SM response but AI extracted wrong due to ambiguous structure/prompt | OUR bug — fix prompt or response. |
| **VALID_REJECTION** | SM correctly rejected a logically wrong action | Working as intended. |

### CT rejection types

| Error | Check |
|-------|-------|
| `focus_mismatch` | Was `focus_node.id` in the response? If yes + AI sent undefined → DESIGN_CONFUSION. If AI sent a different real ID → HALLUCINATION. |
| `invalid_columns` | Are submitted columns similar to real ones (case mismatch)? → DESIGN_CONFUSION. Completely fabricated? → HALLUCINATION. From a different node? → DESIGN_CONFUSION. |
| `missing_columns` | Did prompt explain trace requires columns? |
| `revisit_invalid` | Always HALLUCINATION. |
| Prune guard rejection | Did AI have info to know this would fail? |

### BB rejection types

| Error | Check |
|-------|-------|
| Focus mismatch | Same as CT. |
| `invalid_questions` | Node ID close to real one (typo)? → DESIGN_CONFUSION. Fabricated? → HALLUCINATION. |
| `rejected_prune_ids` | Was Guard 0 / cascade threshold explained in prompt? |
| `complete_rejected` | Was remaining_agenda visible? |

**Target: DESIGN_CONFUSION = 0.** Every rejection should be either HALLUCINATION (model limit) or VALID_REJECTION (correct behavior).

## 5. Architectural Observations

### CT SM is only needed when it works worst
- Small scope → inline (all data at once, works well)
- Large scope → SM (cascading errors, no backtracking, sliding window drops context)

### CT's accept-on-trust is silent garbage propagation
- After 2 column rejections → SM silently accepts any column name
- Wrong columns cascade to all future hops via `activeColumns`
- No detection, no warning, no recovery

### BB can answer column questions without CT
- BB reads DDL at each node, records findings in natural language
- Working memory persists ALL summaries across all hops
- More reliable than CT's precise column tracking for complex traces

### Potential: graceful degradation strict → freeform
- When CT strict validation fails repeatedly → degrade to BB-style freeform
- Accumulate rejection history → present to AI for self-correction at end
- Based on Reflexion pattern (Shinn et al. 2023)

### Column selectivity
- AI should trace only columns relevant to the question (not ALL input columns)
- SM already supports this (trace/prune per neighbor) — it's a prompt guidance issue
