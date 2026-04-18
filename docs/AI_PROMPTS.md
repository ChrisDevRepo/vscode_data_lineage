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

**ACTIVE-phase mechanical enforcement (2026-04-18):** the chat loop sets `vscode.LanguageModelChatToolMode.Required` and narrows the visible tool set to `submit_findings` during ACTIVE. The AI cannot emit free-form text mid-loop — it must call a tool. Termination is owned by the engine (agenda drains → synthesis prompt injected). Prompt surfaces therefore contain no self-exit vocabulary (`complete: true`, "final answer", "enrich_view only after"); those paths are unreachable by design.

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

| Mode | Trigger | Cap | Out-of-cap route behavior |
|---|---|---|---|
| `strict` | User set depth via slash command OR unambiguous NL phrase ("direct neighbors", "one level", "immediate", "just the upstream") | `depth` exactly | Returns `action_required` — engine pauses, participant asks user yes/no, yes caches the class for the session |
| `soft` | Vague NL phrase ("nearby", "surrounding", "next level") | `depth + 1` | Auto-expand within the cap; `action_required` beyond |
| `silent` (default) | No user depth signal — AI chose a cautious starting scope | `depth + 2` | Auto-expand within the cap; `action_required` beyond |

**Same `action_required` path for schema filter.** A route to a schema outside `session.filter.schemas` triggers the same combined envelope — one gate may list both a schema violation and a depth violation together, and a "yes" caches each class (schema or depth) separately on the session allowlist.

**Picking the mode is the AI's job at `start_exploration` time** — the `depth_enforcement` parameter description in `package.json` is the single source of truth for the mapping. When in doubt about NL phrasing, prefer the stricter option; the consent-gate path handles legitimate expansion cleanly.

**AI-visible signals every hop** (`working_memory` and neighbor metadata):
- `depth_budget` / `depth_cap` / `depth_enforcement` — always set when the session has a budget
- Per-neighbor: `in_budget`, `in_user_filter`, `would_trigger_action_required`
- `verdict_counts`, `recent_rejections`, `active_schemas`, `budget_expansions` — tally and memory for self-correction
- `checklist.rounds_used` — monotonic counter (not a countdown; see s1 paper on budget anchoring)

See `docs/AI_ARCHITECTURE.md § Scope Budget Enforcement` for the flow diagrams and the two-loop (exploration + consent gate) lifecycle.

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
