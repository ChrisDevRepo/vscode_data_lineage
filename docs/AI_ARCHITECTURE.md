# AI Assistant Architecture — "Explore-First" & "Hop-and-Distill"

The `@lineage` AI participant bridges deterministic graph traversal with semantic reasoning to help users understand complex data flows. This document provides a high-level overview of the architectural patterns used to deliver large-scale lineage insights within the VS Code environment.

---

## 1. Core Philosophy: Explore-First

The assistant does not attempt to "guess" the entire lineage in a single pass. Instead, it follows a **Hop-and-Distill** pattern:
1.  **Hop**: The AI moves one level deep from the current focus object.
2.  **Distill**: It analyzes the DDL (SQL) for that specific hop to identify columns, renames, and business logic.
3.  **Synthesize**: Findings are accumulated into a holistic view that explains the "Story" of the data.

---

## 2. Execution Models

The assistant automatically switches between two execution modes based on the complexity of the request:

### 2.1 Inline Mode (Small Scopes)
For small lineages (default < 10 nodes), the AI receives the full context simultaneously. This allows for immediate reasoning and labeling in a single pass, providing a fast and fluid user experience.

### 2.2 State Machine (SM) Mode (Complex Lineages)
For deep, complex traces (30+ hops), the assistant employs an iterative state machine. This ensures that the AI remains grounded in evidence by purging stale context per hop while retaining critical findings in long-term memory.

---

## 3. Visual Synthesis

The final output of an AI exploration is not just text, but a **Visual Bookmark**. This includes:
- **Depth-Ordered Sections**: Grouping nodes into logical business phases (e.g., "Source", "Transformation", "Mart").
- **Smart Labels & Badges**: Surfacing column counts, rename alerts, and critical logic directly on the graph.
- **Narrative Overlays**: Providing a text-based explanation that stays synced with the visual selection.

---

## 4. Session Protection

The AI architecture is designed for multi-window stability:
- **Atomic Sessions**: Each chat window has its own isolated state. Closing a panel or starting a new trace perform an atomic wipe to prevent data leakage.
- **2-Hour TTL**: Stale or abandoned sessions are automatically cleared after 2 hours to ensure the user is never "locked" by old reasoning state.

---

## 5. Further Reading

For detailed implementation logic, state machine transitions, and developer-only concepts, refer to the **Internal Developer Documentation** (`docs-internal/`).
