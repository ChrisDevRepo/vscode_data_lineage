# AI Prompt Engineering

The `@lineage` participant is a VS Code chat participant — stateless-per-turn, uses tools, streams markdown via `ChatResponseStream`. The state machine is a tool the model calls; the model is a domain responder, not a persistent agent. Prompts stay focused on the task (analyze the focus node, write the archive, route neighbors); the engine handles completion, cascade-prune, and memory delivery.

---

## 1. Prompt Layers (The Hourglass Model)

The prompt architecture follows an "Hourglass" model to manage context efficiency and prevent hallucinations:
- **Discovery (Wide):** Full search and routing capabilities to map the initial mission.
- **Active (Narrow):** Sliding memory loop where the AI is isolated to a single node to prevent global context bloat.
- **Synthesis (Wide):** Unbounded memory access for reporting, returning to a wide context for final delivery.

### 1.1 General System Prompt (session-stable)
Built by `buildGeneralSystemPrompt()` in `src/ai/prompts.ts`. Injected into every turn. Contains global invariants: platform rules, schema context, and LaTeX guidance.

### 1.2 Discovery Phase Prompt
Built by `buildDiscoveryPrompt()` in `src/ai/prompts.ts`. Used when the AI is searching for objects or defining the `mission_brief`. Includes the rules for `start_exploration` and the "Budget: 50 rounds" constraint. This phase also applies when the AI is idle between explorations.

### 1.3 Active Phase / Navigation Prompt (Sliding Memory)
Built by `buildActivePhasePrompt()` (general active rules) and `buildNavigationPrompt(mode)` (mode-specific workflow). 
- **Isolated Analysis:** The AI operates like a "horse with blinders." It sees only the current node's DDL and its immediate neighbors.
- **Incremental Loading:** Instead of the full history, the AI receives `working_memory.short_term_memory`—a sliding window of the most recent node summaries to ground immediate reasoning.
- **Mechanical Enforcement:** Global arrays (`agenda`, `visited_nodes`, `all_summaries`, `pending_questions`) are physically stripped from the JSON payload during this phase to prevent context poisoning and token bloat.

### 1.4 Synthesis Phase Prompt
Built by `buildSynthesisPrompt()` in `src/ai/prompts.ts`. Hyper-focused on generating the final report.
- **Long-term Memory Access:** The AI regains access to the full, unbounded Detail Archive generated during the active phase.
- **No Routing Noise:** Discovery routing instructions are omitted during report generation to maximize reasoning tokens for the final output. Routing capabilities return only when the session transitions back to the Idle state.

### 1.5 Stage-Placement Invariants

Every prompt surface has a stage (DISCOVERY / ACTIVE / SYNTHESIS / ALL). Before adding a rule, decide the stage:

| Rule class | Stage | Canonical surface |
|---|---|---|
| Global invariant (validate, no fabrication, LaTeX, output-shape decision, archive-is-unbounded) | ALL | `buildGeneralSystemPrompt` |
| Discovery-phase tool routing | DISCOVERY | Tool `modelDescription` first; system prompt only if cross-tool |
| Mode-specific per-hop workflow | ACTIVE (one mode) | `smPrompts.ts` BLOCK constant in that mode only |
| Verdict definitions | ACTIVE + tool | `submit_findings.modelDescription` (tool) + `BLOCK.verdictCategories` (nav) — keep identical |
| Output format | SYNTHESIS + tool | `aiOutputTemplates.yaml` `instruction` (canonical) + `present_result.modelDescription` (reference) |

Do not duplicate across surfaces. The general system prompt is sent on every turn — anything repeated in nav or tool description is triple-billed. If a rule belongs in a tool description, keep it there; the tool is visible at every call that matters.

### 1.6 Per-Phase Template Scope — stage routing

`aiOutputTemplates.yaml` has 14 keys. Each declares a `stages:` field listing which phases inject it into the AI system prompt. The authoritative routing lives in code (`STAGE_BY_KEY` in [`src/ai/templateRenderer.ts`](../src/ai/templateRenderer.ts)) — the YAML `stages:` field is informational for power-user readers; overlays that contradict the canonical routing are logged and ignored.

Routing via the helper `resolveStagePrompt(templates, phase, classification)`:

| Phase | Keys injected | What they shape |
|---|---|---|
| **DISCOVERY** | `summary`, `description` | Trivial questions finalized without SM need a chat-description template. Others route to `start_exploration`. |
| **ACTIVE** (per-hop) | `general`, `business_capture`, `technical_capture` | **Capture rules** — what the AI writes into `detail_analysis` per node. `general` fires once regardless of classification (depth target, shared format rules). `business_capture` / `technical_capture` are classification-gated but both fire at ACTIVE (classification is still `undefined`) — the AI captures both angles per node. |
| **SYNTHESIS** | `general`, `title`, `intro`, `sections`, `closing`, `description`, `highlights`, `notes`, `loading_pattern`, `business_subsection`, `technical_subsection` | **Render rules** — how the captured content becomes the final present_result document. `general` fires once (ungated). A `**Mission type:** <value>` line is injected by code (classification is code-resolved). |

**Convention: `*_capture` at ACTIVE, `*_subsection` at SYNTHESIS.** This keeps each YAML key phase-pure — no meta preambles inside the instruction text.

**`general` key** fires at both ACTIVE and SYNTHESIS, ungated — not in `CLASSIFICATION_GATED`. It owns the shared depth target and format rules (tables, lists, code fences, ⚠️ inline placement, supported block types). Avoids duplication when classification is `both` (business and technical both fire; `general` still fires once).

**Classification gating** (`CLASSIFICATION_GATED` in `templateRenderer.ts`): at SYNTHESIS the gate applies: `business_*` keys fire for `business`/`both`; `technical_*` keys fire for `technical`/`both`.

**Human-readable section titles.** Inside the injected block, each instruction is prefixed by `#### <Human Title>` (not the snake_case YAML key name). The AI reads `#### Business angle`, `#### Technical section block`, etc. — clear communicative labels, no internal identifiers.

**LaTeX, markdown tables, code fences** stay in `buildGeneralSystemPrompt` because they are tied to the webview renderer capability, not user preference. Do not restate in YAML.

**User overlay safety.** If the user points `dataLineageViz.ai.outputTemplateFile` at an invalid YAML, the loader logs a WARN + shows a VS Code notification and falls back to the shipped defaults. Per-key: unknown keys log a WARN and are ignored; missing `instruction` fields log an INFO and keep the built-in value for that key; the built-in defaults always succeed so the extension remains functional.

---

## 2. Per-Hop Memory (Active Phase)

Every hop the engine delivers a strictly isolated `WorkingMemory` snapshot containing:
- `user_question` — echoed verbatim.
- `mission_brief` — the global intent anchor created during discovery.
- `current_task` — the specific sub-question routing the AI to the current node.
- `focus_node` — the DDL, depth level, and topological path of the current object.
- `neighbors` — direct connections for further routing decisions.
- `short_term_memory` — the last 3 node summaries (sliding window).

This architecture ensures that what is not captured in the YAML-defined `detail_analysis` during the hop cannot be generated later, forcing high-quality per-node capture.

---

## 3. Routing & Grounding

- **Metadata-first routing** — for every neighbor, the AI gets `{ id, schema, name, type, edge_direction, edge_type, boundary, cols }` before deciding to visit it. Every `route_requests` entry carries a focused sub-question; blind routing is a reasoning failure.
- **Sub-question depth** — `route_requests[].question` and `current_task` may be a single yes/no ("Does this procedure apply the rule the parent referenced?") or a multi-part investigation ("Which columns X/Y/Z flow through this proc, how are they transformed, and what conditions filter them?"). Frame the question at the depth the next hop needs — narrow questions constrain the next hop's analysis unnecessarily.
- **Fail-early validation** — `submit_findings` rejects unknown node IDs and (in `column_trace` mode only) column names that don't appear on the target. The AI self-corrects from the rejection payload.
- **Column scope** — in `blackboard` mode, `route_requests[].columns` is silently dropped; in `column_trace` mode, names must exist on the target.

### Depth handling — three modes

`start_exploration` accepts `depth` + `depth_enforcement` to express the exploration scope. Three modes reflect three distinct situations:

| Mode | Trigger | Cap | Out-of-cap route behavior |
|---|---|---|---|
| `strict` | User set depth via slash command OR unambiguous NL phrase ("direct neighbors", "one level", "immediate", "just the upstream") | `depth` exactly | Returns `action_required` — engine pauses, participant asks user yes/no, yes caches the class for the session |
| `soft` | Vague NL phrase ("nearby", "surrounding", "next level") | `depth + 1` | Auto-expand within the cap; `action_required` beyond |
| `silent` (default) | No user depth signal — AI chose a cautious starting scope | `depth + 2` | Auto-expand within the cap; `action_required` beyond |

**Same `action_required` path for schema filter.** A route to a schema outside `session.filter.schemas` triggers the same combined envelope — one gate may list both a schema violation and a depth violation together, and a "yes" caches each class (schema or depth) separately on the session allowlist.

**Picking the mode is the AI's job at `start_exploration` time** — the `depth_enforcement` parameter description in `package.json` is the single source of truth for the mapping. When in doubt about NL phrasing, prefer the stricter option; the consent-gate path handles legitimate expansion cleanly.
