# AI Implementation Details (Internal)

Low-level architecture of the `@lineage` Chat Participant, state machines, and memory model. This document provides deep-dive technical details for developers. For a public-facing overview, see `docs/AI_ARCHITECTURE.md`.

---

## 1. Memory Model: Two-Tier Architecture

Inspired by MemGPT, the `AiMemoryManager` separates narrative summaries from grounded evidence to manage context pressure during deep traces.

### 1.1 Two-Tier Memory (hop-by-hop mode only)

- **Short memory** (`narrative[]`): Incremental index of 1-line summaries (~100-200 chars/hop). All entries are visible in every hop's `working_memory`, providing cross-hop continuity.
- **Detail memory** (`detailSlots` Map): Per-node extractive evidence stored in local RAM at full fidelity. Structured by aspect: `COLUMNS`, `TRANSFORMS`, `JOINS`, `FILTERS`, `DATA FLOW`, `QUESTION RELEVANCE`. This is never evicted and is delivered **only at synthesis** (Phase 3) as the AI's sole source for the final narrative.

### 1.2 Detail Depth by Verdict
- `relevant` / `trace` → Full findings (business meaning + SQL evidence, 8000 char hard limit).
- `pass` → Full findings stored (no evidence destruction).
- `irrelevant` / `prune` → Summary only + removed from graph.

In **inline mode** (small scopes), detail memory stores only labels/captions as the AI already has all DDL in context.

### 1.3 Working Memory During Hops
`buildBaseWorkingMemory()` in `smBase.ts` provides:
- `all_summaries`: Every 1-line summary collected so far.
- `pending_questions`: Outstanding sub-questions (Blackboard mode).
- `checklist`: Progress metadata (hop count, noted nodes, total nodes in scope, coverage percentage).

### 1.4 Per-Hop Context Cleaning (Sliding Memory)
To keep the context flat (~10-15K tokens) regardless of hop count, `cleanHopContext()` in `lineageParticipant.ts` performs aggressive cleaning after each hop:
- Retains: System prompt + User question + Mode prompt + Last tool call/result.
- Evicts: Stale tool results and intermediate reasoning.
- Continuity: The `working_memory` injected into the hop context is the **only** cross-hop continuity.

---

## 2. Token Budgeting & Guards

### 2.1 Execution Mode Gating
`shouldSmInline()` in `tokenBudget.ts` determines the mode:
- **Inline**: Scope ≤ `ai.inlineNodeCap` (10) AND estimated tokens ≤ `ai.inlineTokenBudget` (10K).
- **SM Mode**: Exceeds either threshold; triggers hop-by-hop exploration with sliding memory.

### 2.2 Context Pressure
- `CONTEXT_PRESSURE_THRESHOLD = 0.75`: When input tokens exceed 75% of the budget, the oldest turns are evicted (dropped and logged).
- **Hard Limits**: Findings are capped at 8000 chars (`DEFAULT_FINDINGS_LIMIT`), summaries at 500 chars (`DEFAULT_SUMMARY_LIMIT`). Submissions exceeding these are rejected rather than truncated.

---

## 3. State Machine Types

### 3.1 Type 1: Blackboard (`blackboardState.ts`)
Passive exploration for broad questions spanning multiple schemas or objects.
- **Agenda**: A priority queue (Question-Priority Queue) manages nodes to visit.
- **Priority Levels**: BFS default (0), neighbor (1), question-boosted (2), mandatory (3).
- **Verdicts**: `relevant` (logic found), `pass` (passthrough), `irrelevant` (utility/unrelated).
- **Pruning**: `prune_ids` triggers `cascadePrune()`, removing unreachable nodes from the agenda (diamond-safe).

### 3.2 Type 2: Dependency Trace
Linear object-level traversal without specific column tracking. Used for "What does this procedure depend on?" style questions.

### 3.3 Type 3: Column Trace (`columnTraceState.ts`)
Active lineage tracking for specific fields through renames and transformations.
- **Rename Tracking**: Maps `activeColumns` (inputs) to `columnsOut` (outputs) using `INSERT/SELECT` or `UPDATE/CTE` alias resolution.
- **Validation**: Enforces fail-early validation—the AI must explicitly trace columns. hallucinated columns result in immediate tool rejection.

---

## 4. Unified Node Classification

All SM types share a three-category classification system (see `smPrompts.ts`):

| Category | Verdict (BB/CT) | Detail Memory | Badge | Graph Action |
| :--- | :--- | :--- | :--- | :--- |
| **Logic/Transform** | `relevant` / `trace` | Full findings | YES | Kept |
| **Passthrough** | `pass` / `pass` | Full findings | NO | Kept |
| **Utility/Utility** | `irrelevant` / `prune` | Summary only | NO | Cascade Prune |

---

## 5. Tool Filtering & Lifecycle

The `lineageParticipant.ts` manages 5 phases of tool visibility:
1. `discover`: All retrieval tools visible (Entry state).
2. `ct_active`: Only Column Trace tools visible (SM running).
3. `ct_done`: Classic tools restored, BFS excluded (SM result authoritative).
4. `bb_active`: Only Blackboard tools visible (SM running).
5. `bb_done`: Classic tools restored, BFS excluded.

---

## 6. Guard Functions (`smGuards.ts`)

- `wouldOrphanNotedNode()`: Rejects prunes that disconnect already-analyzed nodes.
- `CASCADE_REJECT_THRESHOLD` (50%): Rejects prunes that would wipe out more than half the remaining agenda.
- `findBridgeNodes()`: Automatically re-connects orphans in the final result graph to ensure a continuous visual path.

---

## 7. Persistence & Partial Results

SM instances persist across follow-up messages in the same chat session. If a session ends prematurely (AI stops or round limit reached), `forceComplete()` triggers `getResult()` to extract a partial result. This ensures the "Show in Graph" button and `enrich_view` still work with whatever data was collected.
