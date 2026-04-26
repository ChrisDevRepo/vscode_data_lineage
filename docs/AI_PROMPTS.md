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

The file `assets/aiOutputTemplates.yaml` is the single editable surface for output formatting and per-hop capture. Authoritative phase routing for keys is defined by `STAGE_BY_KEY` in `templateRenderer.ts`; the YAML `stages:` field is informational for human readers.

### 3.1 Override mechanism

Set `dataLineageViz.ai.outputTemplateFile` to a path of your choosing. Your overlay merges on top of the built-in YAML; your keys win, missing keys fall back to the built-in defaults. Unknown keys are logged at WARN and ignored. Non-string `instruction` fields are skipped at load. A bad overlay never breaks activation — at worst the affected key reverts to the empty default and the related instruction is omitted from the prompt.

### 3.2 Classification gating

Four of the keys fire only when the session's mission classification (`business | technical | both`) matches. At ACTIVE the classification is typically `undefined` and every gated key fires unconditionally so capture stays broad. At SYNTHESIS the classification is resolved and only the matching subsection body renders. The classification value also surfaces as a `**Mission type:** <value>` cue read by the `intro` instruction.

| Key | Fires when classification is |
|---|---|
| `business_capture` | `business`, `both`, or `undefined` |
| `technical_capture` | `technical`, `both`, or `undefined` |
| `business_subsection` | `business`, `both`, or `undefined` |
| `technical_subsection` | `technical`, `both`, or `undefined` |

### 3.3 Key inventory — purpose + maintenance

**SYNTHESIS — final document on the chat panel + graph card.**

| Key | Purpose | Maintain when |
|---|---|---|
| `summary` | One-line graph-card teaser (~120 chars). Shown on the AI view card and at discovery for trivial single-object questions. | Tightening or loosening the card-line tone; changing the max-character target. |
| `title` | The `# …` document heading (≤ 80 chars) naming the analysis subject and key finding. | Changing how the title balances subject vs. finding; banning step counts. |
| `intro` | 2–4 sentence narrative opener before the sections. | Changing tone, what the intro is allowed to mention (e.g. ban schema dumps), or how it anchors to the user's question. |
| `sections` | Section assembly contract — density floor (≥ 11 H2 for 20-node scopes), sibling-variant grouping, label-by-role rule, no leading numbers in headers. | Changing how many sections you want, when sibling procedures collapse into one comparison table vs. each get their own H2, or how sections are labelled. |
| `closing` | Optional `---` divider + cross-cutting through-line / risk. | Changing when a closing fires (e.g. always vs. only on 5+ sections) or what cross-cutting issues warrant it. |
| `description` | Fallback long-form body, used only when `sections[]` is absent. | Changing the unstructured fallback's shape and depth target. |
| `highlights` | 2–3 critical-node glows on the graph (Lineage or Diagnostic scheme). | Changing how aggressively to highlight or the colour scheme. |
| `notes` | Per-node graph captions — one-line, what the node does specifically in this flow. | Changing caption length or style (e.g. always lead with the formula vs. the role). |
| `business_subsection` | Section body for the business angle: formulas, `\| From \| To \| Business meaning \|` table, ⚠️ inline rule. Mirrors `business_capture`. | Changing how business rules render at full depth in the final document. Edit alongside `business_capture` so capture and render agree. |
| `technical_subsection` | `#### Technical` subheading body: SQL snippets + LaTeX formulas side-by-side, join strategy, antipatterns. Mirrors `technical_capture`. | Changing how technical content renders. Edit alongside `technical_capture`. |
| `loading_pattern` | SP load-type label (`reload` / `append` / `upsert` / `historization` / `purge` / `orchestration`). Emitted only when origin is a stored procedure. | Adding or renaming a load-type vocabulary value. |

**ACTIVE — per-hop capture into the unbounded archive.**

| Key | Purpose | Maintain when |
|---|---|---|
| `business_capture` | What the AI writes into `detail_analysis` for the business angle: business meaning, formulas, column renames, ⚠️ invariants, question-relevance evidence. | Adding a per-hop business-content requirement (e.g. "always list affected consumers"). The archive is unbounded — bias toward signalling depth, not character ceilings. |
| `technical_capture` | What the AI writes for the technical angle: verbatim SQL, loading pattern, joins, antipatterns, distribution hints. | Adding a per-hop technical-content requirement (e.g. "always note hash-distribution column"). |
| `structural_summary` | Reduced active-phase template fired only when the user's starting point is a non-bodied node (table). Replaces `business_capture` / `technical_capture` for that one hop with a Purpose / Columns / Upstream / Downstream / Grain skeleton. | Changing the table-origin slot shape — e.g. adding an FK / index sub-section. Don't put transform formulas here; those belong in the procedure slots. |

**ACTIVE + SYNTHESIS — shared depth + format floor.**

| Key | Purpose | Maintain when |
|---|---|---|
| `general` | Per-section character floor (800–2 000 chars), `\| From \| To \| Notes \|` table format, ```sql``` code-fence rule, ⚠️ inline rule. Fires at both active capture and synthesis render so the contract is identical end-to-end. | Adjusting the depth target, adding a supported markdown feature, or banning an unsupported one (e.g. mermaid is not allowed). |

### 3.4 How to maintain — operating guidance

- **Edit the `instruction:` field, not the `example:` / `bad_example:` / `good_example:` fields.** Only `instruction` is injected into the prompt; the other fields exist for the human reader.
- **Mirror capture and render edits.** When `business_capture` says "list every CASE branch", `business_subsection` should say "render every branch from the archive". If the two drift, captured content fails to surface or output references content that was never captured.
- **Test in isolation.** When you change one key, verify the resulting output against an existing baseline (e.g. `tmp/baseline/output_main/`). Use the iteration-review skill to compare H2 count, line count, and label diversity before merging.
- **Avoid character ceilings on archive fields.** The archive is unbounded; capping `detail_analysis` per slot pushes the model to pre-compress, which starves synthesis for detail. Use floors ("aim 800–2 000 chars per section") not ceilings.
- **Verdict names are locked.** `analyze` / `pass` / `prune` are enforced by a Zod enum on `submit_findings.verdict`; only the YAML descriptions can change, not the names.
- **Don't hand-edit the validated stages.** `STAGE_BY_KEY` in `templateRenderer.ts` is the authoritative routing. Adding a new key requires both a YAML entry and a `STAGE_BY_KEY` registration.

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
