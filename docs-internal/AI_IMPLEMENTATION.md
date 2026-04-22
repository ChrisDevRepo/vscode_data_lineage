# AI State Machine — Implementation Details

## 1. Per-Session Memory (Asymmetric Tiering)

`AiMemoryManager` (`src/ai/memoryManager.ts`) is the single owner of per-session memory. It implements an **Asymmetric Tiering** pattern to manage context efficiency while maintaining full-fidelity reporting.

### 1.1 Memory Store (The Archive)
The manager holds a map of `DetailSlot` per visited node. This is the **Long-Term Memory**.

| Field | Source | Lifecycle | Purpose |
| :--- | :--- | :--- | :--- |
| **`DetailSlot.analysis`** | AI submits via `submit_findings.detail_analysis` | **Synthesis Only** — never delivered during hops. | High-fidelity technical documentation. |
| **`DetailSlot.summary`** | AI submits via `submit_findings.summary` | **Every Hop** (as part of a sliding window) | Local continuity & rename tracking. |

### 1.2 Working Set (The Sliding Window)
Every navigation hop in **Sliding Memory Mode**, the manager emits a `WorkingMemory` snapshot. To prevent **Context Poisoning** and token bloat, the snapshot uses a **Sliding Window** (Narrow Context).

- **`short_term_memory: Array<{nodeId, summary}>`**: Contains one-liners for the last **3** nodes only.
- **Incremental Loading**: New findings are appended; the oldest finding in the window is evicted.
- **Verification**: `memoryManager.ts:getWorkingMemory` slices the `detailSlots` values to `-3`.

In **True Inline Mode**, the working set is bypassed and the AI receives the full context of all nodes in scope at once.

### 1.3 Memory Persistence by Verdict

| Verdict | Artifacts Stored | Topological Consequence |
| :--- | :--- | :--- |
| **`analyze`** | `detail_analysis` + `summary` | Node kept in graph; analysis archived. |
| **`pass`** | `summary` only | Node kept in graph (e.g. as a bridge); no logic archived. |
| **`prune`** | `summary` only (optional) | Node and all unvisited descendants removed from graph. |

---

## 2. Token Budget & Context Management

### 2.1 The Hourglass Model
The context lifecycle follows an hourglass shape, but with a wide-center option for small graphs:
1. **Discovery (Wide)**: AI sees global stats to map the mission.
2. **Active (Wide or Narrow)**: 
   - **True Inline (Wide)**: For Blackboard questions below budget, the AI receives all DDL at once. No history wipe.
   - **Sliding Memory (Narrow)**: For large graphs or Column Trace aspect, the engine physically prunes global arrays and uses a sliding window. History is wiped every hop.

3. **Synthesis (Wide)**: Engine "opens the vault," delivering the entire Detail Archive (unbounded characters) for report generation.

### 2.2 Mechanical Phase Gating
Tools are gated by phase in `lineageParticipant.ts`:
- **Active Phase**: Tool set narrowed to `lineage_submit_findings` only. `Required` tool mode prevents free-form chat.       
- **Synthesis Phase**: `lineage-presentation` tools (e.g. `lineage_present_result`) are restored; navigation tools are hidden.

---

## 3. Tool Vocabulary & Grounding

### 3.1 Imperative Verbs
We moved from adjectives (`relevant`, `irrelevant`) to imperative verbs (`analyze`, `prune`) to improve instruction following. Models reason more predictably about "doing" rather than "categorizing."

### 3.2 Selection-Inference Validation
The `NavigationEngine` performs "Fail Early" validation:
- Rejects routes to non-existent nodes/columns.
- Prevents `prune` verdicts that would orphan noted work (`wouldOrphanNotedNode`).
- Detects parallel `start_exploration` storms via `parallel_call_forbidden`.
- **Batch Submission**: Supports `submit_findings` with an array of findings for True Inline mode.

---

## 4. Synthesis & Reporting

### 4.1 Holistic Aggregation
Once the agenda is empty, the participant transitions to the `synthesis` phase.
1. The engine provides a `synthesis_reminder` (re-anchoring on intent).
2. The AI generates the `lineage_present_result` payload.
3. The UI renders the result as a numbered report with interactive node badges.

### 4.2 Handling Partial Results
If `MAX_ROUNDS` (default 50) is reached, the SM triggers a partial synthesis. `present_result` renders the partial graph, and the UI surfaces a "Budget Limit Reached" notice.

## References
- `src/ai/smBase.ts` — Unified Navigation Engine.
- `src/ai/memoryManager.ts` — Asymmetric Memory Tiering.
- `docs-internal/HOURGLASS_FLOW.md` — Context visualization.
