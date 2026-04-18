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

### 1.4 Stage-Placement Invariants

Every prompt surface has a stage (DISCOVERY / ACTIVE / SYNTHESIS / ALL). Before adding a rule, decide the stage:

| Rule class | Stage | Canonical surface |
|---|---|---|
| Global invariant (validate, no fabrication, LaTeX, output-shape decision, archive-is-unbounded) | ALL | `buildSystemPromptBase` |
| Discovery-phase tool routing | DISCOVERY | Tool `modelDescription` first; system prompt only if cross-tool |
| Mode-specific per-hop workflow | ACTIVE (one mode) | `smPrompts.ts` BLOCK constant in that mode only |
| Verdict definitions | ACTIVE + tool | `submit_findings.modelDescription` (tool) + `BLOCK.verdictCategories` (nav) — keep identical |
| Output format | SYNTHESIS + tool | `aiOutputTemplates.yaml` `instruction` (canonical) + `enrich_view.modelDescription` (reference) |

Do not duplicate across surfaces. The system prompt is sent on every turn — anything repeated in nav or tool description is triple-billed. If a rule belongs in a tool description, keep it there; the tool is visible at every call that matters.

### 1.5 Per-Phase Template Scope

`aiOutputTemplates.yaml` has 7 `instruction` fields. Injecting all 7 into the system prompt on every turn wastes tokens in phases where the model cannot write `enrich_view`.

| Phase | Templates injected | Reason |
|---|---|---|
| DISCOVERY | `summary` + `description` | Trivial questions finalized without SM need a chat-description template. Others route to `start_exploration`. |
| ACTIVE (hop loop) | *none* | Model writes `detail_analysis` via `submit_findings`. Format governed by `BLOCK.writeFindings` in `smPrompts.ts`. Output templates are irrelevant here. |
| SYNTHESIS | `title`, `intro`, `sections`, `closing`, `description`, `highlights`, `notes` | All `enrich_view` fields are written here. |

Saving: ~1,000 tokens per ACTIVE hop. For a 26-hop session, ~26k tokens total (~12% of session input).

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

- **Metadata-first routing** — for every neighbor, the AI gets `{ id, schema, name, type, edge_direction, edge_type, boundary, cols }` before deciding to visit it. Every `route_requests` entry carries a focused sub-question; blind routing is a reasoning failure.
- **Sub-question depth** — `route_requests[].question` and `current_task` may be a single yes/no ("Does this procedure apply the rule the parent referenced?") or a multi-part investigation ("Which columns X/Y/Z flow through this proc, how are they transformed, and what conditions filter them?"). Frame the question at the depth the next hop needs — narrow questions constrain the next hop's analysis unnecessarily.
- **Fail-early validation** — `submit_findings` rejects unknown node IDs and (in `column_trace` mode only) column names that don't appear on the target. The AI self-corrects from the rejection payload.
- **Column scope** — in `blackboard` / `dependency` modes, `route_requests[].columns` is silently dropped; in `column_trace` mode, names must exist on the target.

### Depth handling — three modes

`start_exploration` accepts `depth` + `depth_enforcement` to express the exploration scope. Three modes reflect three distinct situations:

| Mode | Trigger | Out-of-scope route behavior | AI awareness |
|---|---|---|---|
| `strict` | User set depth via an explicit slash command (e.g., future `/trace:depth=1`) | **Rejected** with a structured envelope | `depth_budget`, `depth_enforcement: 'strict'`, per-neighbor `in_budget: false`, `focus_node.depth_from_origin` |
| `soft` | User expressed depth in natural language ("1 level deep", "direct neighbors", "immediate dependencies") | **Allowed**; scope expands in-place; expansion recorded in `working_memory.budget_expansions` | Same as strict plus `budget_expansions[]` — AI can see how many times it went beyond and why |
| `silent` (default) | No user depth signal — AI chose a cautious starting scope on a large graph | **Allowed silently**; scope expands in-place; no awareness fields emitted | **None.** The AI routes freely as if no budget existed. Engine auto-grows scope underneath. |

Picking the mode is the AI's job at `start_exploration` time; the tool description in `package.json` guides the choice.

Why the silent default matters: on a 30-level-deep graph, seeding `depth=5` BFS can still pull hundreds of nodes. A cautious AI can pass `depth: 2, depth_enforcement: 'silent'` — the initial agenda is tight, and as `route_requests` reveal that level-3 nodes are needed, the engine absorbs them into scope transparently. No "out of budget" warnings confuse the AI; the user never set one.

---

## 4. Synthesis Grounding Contract

- Cite only from archive slots — no new facts.
- If a slot reads thin, call `lineage_get_object_detail` and expand from the DDL.
- Preserve LaTeX formulas and markdown tables from slot analyses verbatim.
- Variant siblings each get their own section — delta wording is fine ("Same skeleton as X; deltas: …").
- Two deliverables — chat prose **and** `enrich_view` sections — both at per-slot depth. Chat is for reading; the view is for graph navigation.
- **Archive abundance** — the archive is comprehensive by design; do not compress, do not summarize. Lift per-node analyses into sections, expanding with interpretation as needed. The per-section `text` and fallback `description` have no length limit. Shallow synthesis negates the exploration's effort.

---

## 5. Model-Agnostic Authoring

VS Code Copilot routes across providers (Claude, GPT-4o/4.1/5, Gemini, etc). `@lineage` prompts MUST work on any of them — no wording tuned to a single model's quirks.

Design rules (observed across providers):

1. **Hard tool invariants go in code, not prose.** Prompt text signals intent; mechanical guards (parallel-call rejection, state pre-checks, schema validation) enforce contracts. A rule that can only be upheld by the model reading carefully is not upheld.
2. **Structured refusal envelopes.** Errors returned to the AI use `{error, hint, next_action}` JSON shape — every model parses this more reliably than prose.
3. **Positive framing with alternative.** Pair any prohibition with a valid next action: "Use submit_findings for queued neighbors (start_exploration is not valid here)." Pure prohibitions ("Do NOT …") vary in effectiveness by model.
4. **One canonical surface per rule.** Duplication does not compound compliance on any model. Tool contracts live in `modelDescription`; per-hop workflow in nav prompts; global invariants in system prompt.
5. **Abundance signals where storage allows.** Where the engine preserves verbatim (Detail Archive), prompts say "write thoroughly". UI-real-estate fields (summary, note_caption, badge_label) keep their pixel budgets local.

These rules map directly to the mechanical guards in `.claude/skills/prompt-change/references/prompt-surface-map.md` and the anti-pattern table in `references/best-practices.md`.

---
