# AI Prompt Engineering

The `@lineage` participant is a VS Code chat participant — stateless-per-turn, uses tools, streams markdown via `ChatResponseStream`. The state machine is a tool the model calls; the model is a domain responder, not a persistent agent. Prompts stay focused on the task (analyze the focus node, write the archive, route neighbors); the engine handles completion, cascade-prune, and memory delivery.

---

## 1. Prompt Layers

Three prompt layers, each with a different lifetime.

### 1.1 System Prompt (session-stable)
Built by `buildSystemPromptBase(maxRounds)` in `src/ai/prompts.ts` and cached across the session so the LM cache stays hot. Six terse rules cover validation, tool routing, output shape, and LaTeX guidance. Callers append the platform context, schema context, and `aiOutputTemplates.yaml` fields. Matches the 0.9.8 system-prompt shape.

### 1.2 Navigation Prompt (per-mode, per-session)
`buildNavigationPrompt(mode)` in `src/ai/smPrompts.ts`. Injected once at the `discover → active` phase transition and re-injected inside every sliding-memory wipe so mode guidance survives the hop loop. Three modes:
- **`blackboard`** — business logic / exploration framing.
- **`column_trace`** — column-level trace with rename tracking.
- **`dependency`** — structural dependency trace (no column tracking).

Each mode prompt spells out the per-hop workflow (read DDL → write archive → assign badge/note → route neighbors), the three verdicts (`relevant` / `pass` / `irrelevant`), and the routing contract (every `route_requests` entry needs a specific sub-question). No "autonomous agent" framing, no persona headers — the prompt matches VS Code chat-participant conventions.

### 1.3 Synthesis Prompt (phase 3)
`buildSynthesisPrompt()` in `src/ai/smPrompts.ts`. Delivered once the agenda drains. Spells out the two-deliverable contract (chat prose + `enrich_view` sections, one per archived slot) and the grounding contract (cite archive only, no new facts, preserve LaTeX and tables from slot analyses). The model self-regulates per-slot section depth based on question shape.

---

## 2. Per-Hop Memory

Every hop the engine delivers a `WorkingMemory` snapshot containing:
- `user_question` — echoed verbatim.
- `all_summaries: Array<{ nodeId, summary }>` — every prior hop's one-line summary, in visit order, unbounded.
- `pending_questions` — self-asks the model has not yet answered.
- `checklist` — `{ current_hop, noted, total, open, coveragePct }` plus the drain signals `sm_status` and `agenda_remaining`.

No AI-managed narrative. No cumulative "blackboard" the model has to rewrite. No token-budget-filtered slice of detail slots. The Detail Archive (`detail_analysis` per node) is stored internally and only surfaces at synthesis.

This matches the 0.9.8 contract: the state machine stores, delivers, and executes; the AI decides relevance.

---

## 3. Routing & Grounding

- **Metadata-first routing** — for every neighbor, the AI gets `{ id, schema, name, type, edge_direction, edge_type, boundary, cols }` before deciding to visit it. Every `route_requests` entry must name a specific sub-question ("Does this proc apply the 10% VAT rate?"); blind routing is a reasoning failure.
- **Fail-early validation** — `submit_findings` rejects unknown node IDs and (in `column_trace` mode only) column names that don't appear on the target. The AI self-corrects from the rejection payload.
- **Column scope** — in `blackboard` / `dependency` modes, `route_requests[].columns` is silently dropped; in `column_trace` mode, names must exist on the target.

---

## 4. Synthesis Grounding Contract

- Cite only from archive slots — no new facts.
- If a slot reads thin, call `lineage_get_object_detail` and expand from the DDL.
- Preserve LaTeX formulas and markdown tables from slot analyses verbatim.
- Variant siblings each get their own section — delta wording is fine ("Same skeleton as X; deltas: …").
- Two deliverables — chat prose **and** `enrich_view` sections — both at per-slot depth. Chat is for reading; the view is for graph navigation.

---
