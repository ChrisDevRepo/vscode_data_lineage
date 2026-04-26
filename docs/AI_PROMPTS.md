# Interface Spec: AI Prompt Engineering

The `@lineage` participant is a stateless-per-turn VS Code chat participant that utilizes an autonomous state machine to navigate database graphs. This document defines the multi-layered prompt architecture used to maintain reasoning quality and context efficiency.

## 1. Prompt Layers (The Hourglass Model)
The system implements an "Hourglass" flow to manage token budgets and prevent reasoning degradation in long contexts.

1.  **Discovery (Wide)**: Initial turn where the AI identifies intent and maps the starting scope. Full search and graph-wide pattern detection tools are available.
2.  **Active (Narrow)**: The "Horse with Blinkers" phase. The AI is isolated to a single focus node to prevent global context bloat. Reasoning is limited to DDL analysis and neighbor routing.
3.  **Synthesis (Wide)**: Unbounded access to the collected "Detail Archive" to generate the final enriched report.

### 1.1 The Routing Contract
- **Class D (Direct)**: Isolated metadata lookups. **Constraint**: Forbidden from narrating "flow" or "lineage" across multiple objects.
- **Class S (State Machine)**: Relationship-driven analysis. **Mandate**: Any request for a "lineage graph", "annotated trace", or "join explanation" must trigger `start_exploration`.
- **Tiebreaker**: Prefer Class S when ambiguous.

## 2. Phase-Scoped Prompt Assembly
System prompts are assembled by `buildStageSystemPrompt` in a fixed order.

| Phase | Responsibility | Key Components |
| :--- | :--- | :--- |
| **Discovery** | Intent mapping. | `buildDiscoveryPrompt`, Routing Contract (Class D vs. Class S). |
| **Active** | Node-by-node analysis. | `buildActivePhasePrompt`, Verdict Semantics, YAML Capture Rules. |
| **Synthesis** | Holistic reporting. | `buildSynthesisPrompt`, YAML Assembly Rules, Archive Lifting. |
| **Follow-Up** | Refinement. | `buildFollowUpPrompt`, Supplement-mode rules. |

## 3. Custom Output Templates (YAML Interface)
Authoritative phase routing for YAML keys is defined by `STAGE_BY_KEY` in `templateRenderer.ts`. The YAML `stages:` field is informational for users.

| Phase | Keys Injected | Responsibility |
| :--- | :--- | :--- |
| **Active** | `*_capture` | **Capture Rules**: What the AI writes into `detail_analysis` per hop. |
| **Synthesis** | `summary`, `title`, `intro`, `sections`, etc. | **Assembly Rules**: How pre-formatted slot bodies are grouped and framed. |

**Classification Gate**: Capture keys are gated by the session's classification (`business | technical | both`). At Active, both angles fire. At Synthesis, the classification surfaces as a `**Mission type:** <value>` cue for the `intro` instruction.

## 4. Per-Hop Memory Snapshot (Active Phase)
Every hop, the engine delivers a strictly isolated `WorkingMemory` snapshot via the system prompt:
- **`mission_brief`**: The session intent anchor.
- **`current_task`**: The sub-question driving the current node visit.
- **`focus_node`**: DDL, columns, and topological path of the focus object.
- **`short_term_memory`**: A sliding window of the last 3 node summaries.

This ensures that any logic not captured in the YAML-defined `detail_analysis` during the hop is lost to the final report, forcing high-quality per-node capture.

## 5. Depth Enforcement Modes
The `start_exploration` tool accepts a `depth_enforcement` parameter to control scope expansion:

| Mode | Trigger | Behavior on Out-of-Cap Route |
| :--- | :--- | :--- |
| **`strict`** | Explicit depth (e.g. `/depth 2`). | Engine pauses; emits `action_required` consent gate. |
| **`soft`** | Vague signal ("nearby"). | Auto-expand +1; then gate. |
| **`silent`** | No signal. | Auto-expand +2; then gate. |

## 6. Implementation Reference
- `src/ai/prompts.ts`: Builder function implementations.
- `src/ai/templateRenderer.ts`: YAML integration and phase routing.
- `src/ai/smPrompts.ts`: Mode-specific analysis and verdict blocks.
