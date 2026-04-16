# AI Implementation Details (Internal)

This document describes the low-level logic of the `@lineage` Chat Participant and its State Machines.

---

## 1. The "Hop-and-Distill" State Machine

The AI uses an iterative SM to survive deep lineages without exhausting the token budget.

### 1.1 Memory Model
- **Short-Term Memory (Narrative)**: A high-level summary of the trace progress. Visible in the prompt.
- **Detail Memory (Evidence)**: Full DDL analysis and column-level mappings. Stored in `AiMemoryManager` and only injected when relevant to the current "Hop".

### 1.2 Verification Loop
The SM acts as an **Auditor**:
1. AI proposes a list of columns to trace.
2. SM validates these columns against the `DatabaseModel`.
3. If the AI hallucinations a column, the tool returns a "Correction Required" message, forcing the AI to self-correct before the trace proceeds.

---

## 2. Token Budgeting

- **Threshold**: 80% of `maxInputTokens`.
- **Strategy**: When the budget is hit, the SM "Compacts" the history. It replaces old tool results with "Stub" messages (`evicted_round_X`) to keep the latest hop context fresh while maintaining the global narrative.

---

## 3. Tool Filtering

The SM uses "Phases" to restrict which tools the AI can call:
- `discover`: Only search and BFS tools.
- `ct_active`: Only column-trace specific tools (hop analysis, synthesis).
- `bb_active`: Only blackboard tools.

This prevents the AI from jumping into a new trace before completing the current one.
