# AI Prompt Engineering — "Incremental Blackboard"

The `@lineage` participant uses a sophisticated prompt architecture designed to maintain reasoning quality during deep (30+ hop) lineages. It implements the **Incremental Blackboard** pattern, where the system provides topological grounding (The Map) and the AI provides semantic synthesis (The Narrative).

---

## 1. Context Separation of Concerns

To prevent token explosion and "Context Drift," the prompt is split into three strictly separate domains.

### 1.1 The Map (Topological Grounding)
The **Map** is injected by the extension in every hop. It is the "ground truth" of where the AI is in the graph.
- **Content**: Visited nodes, Open Agenda, current position, and neighbor metadata (columns/types).
- **Rule**: The AI is instructed **never to repeat** topological facts found in the Map (e.g., "I am visiting Table X") to save tokens.

### 1.2 The Blackboard (Incremental Narrative)
The **Blackboard** is a single, incrementally growing string (the Short Memory).
- **Behavior**: In every hop, the AI receives the current Blackboard and must provide a `narrative_update`.
- **Content**: Dense business logic, formulas, renames, and filter conditions. It tells the "Story of the Data" without the SQL noise.

### 1.3 The Detail Archive (Hard Drive)
Detailed technical findings are stored in **Detail Memory**.
- **Behavior**: The AI writes technical evidence (verbatim SQL, LaTeX formulas) to this archive during the hop loop, but **cannot see it** until Phase 3. This keeps the active context clean for the current SQL analysis.

---

## 2. Selection-Inference Routing

The system uses a **Selection-Inference** pattern to ensure the AI remains grounded.

### 2.1 Metadata-Guarded Questions
For every neighbor the AI wants to visit, it **MUST** generate a specific sub-question.
- **Example**: *"Check `sp_CalcTax` to see if the 10% rate is hardcoded or read from a table."*
- **Validation**: The AI receives column lists for all neighbors *before* visiting. Its questions must refer to valid metadata, or the tool call will be rejected ("Fail Early").

### 2.2 The "Fail Early" Loop
If the AI hallucinates a column or node ID in its `route_requests`, the `lineage_submit_findings` tool returns an error immediately. The AI then re-analyzes the metadata and submits a corrected route.

---

## 3. Lifecycle Prompt Swapping

The assistant dynamically swaps system prompts as the session progresses to keep attention on relevant instructions.

### 3.1 Navigation Mode (Hops)
Focuses on the "Analyst" workflow:
1.  Read focus DDL.
2.  Answer the current sub-question.
3.  Update the Blackboard Narrative.
4.  Archive technical evidence to Detail Memory.
5.  Propose next routes with validated questions.

The navigation-mode prompt persists across sliding-memory wipes and contains no language about completion, final answers, or `enrich_view` — the engine owns those. Situational awareness ("you are mid-loop, N items remain") is delivered as data in every hop payload (`sm_status`, `agenda_remaining`, `checklist.open`), not as prose the model has to re-learn each turn.

The BB nav prompt never mentions `route_requests[].columns`; the CT nav prompt owns all column-level routing guidance. The validator reinforces this by silently dropping `columns` outside column-trace sessions.

### 3.2 Synthesis Mode (Phase 3)
Focuses on the "Documentarian" workflow:
- The mode prompt is swapped to the **Synthesis Grounding Contract**.
- The AI is provided with the full **Archive** (verbatim findings from all hops).
- It is tasked with assembling the final business logic documentation into `lineage_enrich_view`.

---

## 4. Grounding Contract

The AI is bound by a strict **Grounding Contract** to ensure accuracy:
- **No Hallucinations**: Every claim in the final report must cite evidence from a Detail Memory slot.
- **LaTeX for Math**: Formulas must use LaTeX syntax for clear rendering.
- **Tables for Renames**: Column transformations must be presented in Markdown tables.
- **Zero SQL in Summary**: High-level summaries must be business-centric; all SQL evidence must reside in the detailed sections.

---
