# AI Output Templates — YAML Tuning Guide

`@lineage` reads its capture and rendering rules from a single YAML file: [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml). This document is your map for editing that file — what each key does, when it fires, and what to maintain alongside what.

The YAML is the only authoritative surface. Everything below describes how the YAML drives behaviour. For the broader engine architecture (Map & Router, hop payload, state machine) see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## How to override

1. Command Palette → **Data Lineage: Create AI Output Templates** — copies the built-in YAML into your workspace.
2. Set `dataLineageViz.ai.outputTemplateFile` to its path.
3. Edit the `instruction:` field on any key. Your overlay merges on top of the built-in defaults; your keys win, missing keys fall back to the defaults.
4. Unknown keys are logged at WARN and ignored. A bad overlay never breaks activation — at worst the affected key reverts to its default.

Only the `instruction:` text is injected into the prompt. The `example:`, `good_example:`, and `bad_example:` fields exist for the human reader; the AI never sees them.

## AI writes parts — engine builds the document

Two responsibilities, two owners:

| Owner | What they produce | Where it lives |
|-------|-------------------|----------------|
| **AI** writes structured PARTS | Per-hop: `business_capture` / `technical_capture` / `structural_summary` produces the section body bodies stored in `detail_slots[].sections[].text`. <br>Synthesis: `summary`, `title`, `intro`, `sections[]` (each `{ label, node_ids[], text }` lifted verbatim from a slot), `closing`, `notes[]`, `highlight_groups[]`. | YAML templates in this file describe what the AI writes. |
| **Engine** builds DETERMINISTIC outputs | The full markdown document shown in `AiDescriptionOverlay` (the description blob), section numbering (`## N {label}`), badge chips on the graph, `### Objects [name](#focus-node:id)` link headers. | `orderAndAssemble()` in [`src/ai/tools.ts`](../src/ai/tools.ts). No YAML template — there is intentionally no `description` instruction; if you find one in an old overlay, it is dead. |

So the rendering pipeline reads:

```
hop 1, hop 2, …, hop N         →  N archive slots  (capture keys)
                                          ↓
                            synthesis turn lifts each
                          slot.text into present_result
                                          ↓
              AI sends parts: title + intro + sections[] + closing
                                          ↓
                        engine assembles the document
                          via orderAndAssemble()
                                          ↓
              numbered ## N headings, badges, link headers,
                            full description blob
```

The lift+group+label rule for `sections[]` lives in `buildSynthesisPrompt()` in [`src/ai/prompts.ts`](../src/ai/prompts.ts), not in the YAML — kept there to avoid duplication with the synthesis cue. Synthesis assembles, groups, frames — it does not rewrite. If the archive does not contain a fact, the final document cannot mention it. Capture must be exhaustive.

When `classification === 'both'`, captured sections come in pairs per node (one business, one technical). Each angle becomes its own peer entry in `present_result.sections[]` — never nested as `#### Technical` subheadings.

### Inline mode bundles the synthesis cue into the active brief

Inline mode collapses the Active capture turn and the Synthesis turn into a single agent-loop turn (see [`ARCHITECTURE.md`](ARCHITECTURE.md#inline-vs-sm-execution)). Practically, the system prompt at the active-phase start ships every YAML key the AI needs for both calls:

- The **active-stage** keys (`business_capture` / `technical_capture` / `structural_summary`) gate by classification and focus-node-bodied as in SM mode.
- The **synthesis-stage** keys (`summary`, `title`, `intro`, `closing`, `highlights`, `notes`) ride alongside in the same brief — same `resolveStagePrompt` gate, same classification + slot-count rules.
- The **synthesis assembly contract** from `buildSynthesisPrompt()` is embedded verbatim in `buildModeBlock(isInline=true)` (single source of truth — the synthesis-phase prompt and the inline brief reuse the same builder).

Result: after the consent gate is approved, the AI receives one prompt with the full SM instruction set (verdicts, prune, label, sections, routing) and the full synthesis contract. It calls `submit_findings` (one batched call across all scope nodes) and then `lineage_present_result` back-to-back in the same turn, ordered by the `synthesis_reminder` cue carried in the `submit_findings` tool_result. SM mode is unchanged: the synthesis contract ships at the synthesis-phase boundary after the agenda drains, because the SM agenda is many hops long and shipping synthesis upfront would burn tokens with every hop wipe.

CT mode is always SM (column tracing forces SM regardless of scope size), so the inline bundling does not apply to CT.

## Template gate — what fires when

The AI declares the mission classification at `start_exploration` via the **required** `classification` parameter (`business` | `technical` | `both`). The Zod schema in [`src/ai/tools.ts`](../src/ai/tools.ts) is `z.enum([...])` — missing or invalid values are hard-rejected at the boundary; there is no engine fallback. The tool-param description in [`package.json`](../package.json) biases the AI toward `business` when user intent is ambiguous (lineage / origin / impact / column-trace are `business` even when a column is named); `technical` is only for explicit performance / index / tuning asks; `both` is only for explicit "both angles" asks. The locked value is shown in the `confirm_sm_start` gate as `**Analysis:** <label>` so you can see what will be captured before approving.

Active-phase and synthesis-phase templates are routed by two stacked maps in [`src/ai/templateRenderer.ts`](../src/ai/templateRenderer.ts):

1. **`STAGE_BY_KEY`** routes each YAML key to one phase (`active` | `synthesis`). It is the authoritative phase router — a `stages:` field in YAML is informational and ignored on conflict.
2. **`CLASSIFICATION_GATED`** subsequently filters active-phase keys by classification value. Keys absent from this map fire on every classification.

Together these implement the per-template gate:

| Template | Phase | Classification gate |
|---|---|---|
| `business_capture` | active | `business`, `both` |
| `technical_capture` | active | `technical`, `both` |
| `structural_summary` | active | (no classification gate; fires only when focus node is non-bodied — a table) |
| `summary`, `title`, `intro`, `highlights`, `notes` | synthesis | (always) |
| `closing` | synthesis | (always, but only when `slotCount >= 5`) |

Net effect per active hop, given the locked classification:

| Mission | Focus | Templates that ship | Sections per `submit_findings` |
|---|---|---|---|
| `business` | procedure / function / view | `business_capture` only | **1** (business) |
| `business` | table / external | `structural_summary` only | **1** (structural) |
| `technical` | procedure / function / view | `technical_capture` only | **1** (technical) |
| `technical` | table / external | `structural_summary` only | **1** (structural) |
| `both` | procedure / function / view | `business_capture` + `technical_capture` | **2** peer |
| `both` | table / external | `structural_summary` only | **1** (structural) |

`structural_summary` fires only when the focus node is non-bodied (a table — no DDL). At those hops it replaces `business_capture` / `technical_capture` entirely; those two keys are gated out via the `focusIsNonBodied` flag passed from `lineageParticipant.ts` to `resolveStagePrompt`. On all other hops (view, procedure, function focus) `structural_summary` is gated out and the normal capture templates fire. The `focusIsNonBodied` flag is computed from the current focus node type using `SCRIPT_TYPES`.

The contract is locked mechanically at the tool handler boundary: each `submit_findings` call must carry exactly the `sections[]` shape implied by the locked classification. Mismatches reject with `classification_lock_violation` (e.g., a `business`-mission slot carrying a `technical` angle, or a `both` slot missing one angle). At synthesis, `present_result.sections[]` carries one peer entry per captured angle per node — the two angles never nest as `#### Technical` subheadings; they are independent peer sections.

`closing` is additionally gated on archive size (`slotCount >= 5`) — small graphs skip it to save prompt tokens.

### Column trace mode

Column trace is activated when `start_exploration` is called with `targetColumns`. CT forces SM regardless of scope size.

**Per-hop binary gate — map or prune**

On every CT hop, the AI makes one binary decision per tracked column:
- **Map** → fill `column_flow` (declare upstream contributors + role) and route upstream. Use `verdict=analyze` or `verdict=pass`.
- **Prune** → `verdict=prune`. Omit `column_flow`. Use when the node has no interaction with any tracked column.

There is no third path. `column_flow` is the **PRIMARY deliverable**. The engine rejects every non-prune verdict without `column_flow` (`column_flow_required`). Outside CT the field is accepted but ignored.

**SUPPORTING obligation — `sections[].text`**
`business_capture` / `technical_capture` templates fire exactly as in BB mode. The AI writes `sections[].text` explaining the business/technical context — WHY the column flows this way. This is secondary to `column_flow`, which declares WHERE it comes from. `sections[]` is not a substitute for `column_flow`.

**`column_flow` shape per entry:**
- `out_col` — column being produced. For procedure focus: the column name in the target table (same as `writes_to.col`).
- `writes_to?` — for writer procedures: `{ node, col }` naming the table column being written. Resolves edge direction: `from_node=proc, to_node=table` rather than `to_node=focusId`.
- `contributors[]` — upstream sources: `{ from_node, from_col, role }`.

**`role` values:** `source` (terminal — no further upstream), `rename`, `formula`, `case`, `coalesce`, `join_value`, `aggregate`, `filter_only` (excluded from edge accumulation — WHERE/JOIN-ON predicate only, not data output).

Terminal source (`role="source"`, `contributors:[]`) applies to: stored base column, magic number/literal, system function (e.g. `GETDATE()`). Empty `contributors` is not an error. Execution parameters (`@StartDate`, `@Mode`, etc.) are never column lineage sources — they belong in `sections[].text` only.

Validated edges accumulate in `ColumnAspect.edges[]` and are exposed via `SmResult.columnAspect`. Branch termination is structural — a branch is closed when its last edge carries `role="source"`. No completion flag is used.

Column-level validation on `route_requests` — the AI cannot route to a non-existent column.

**Column validation gates (smBase.ts).** `out_col` existence is checked only when the focus node has column metadata (`size > 0`); procedures have no output-column metadata so the check skips automatically. `from_col` validation is split by contributor type: procedure contributors are validated against their inbound source node columns (one-to-one rule — the column entering the SP must exist on at least one of its data sources); tables, views, and functions are validated directly against their own column schemas. `getNodeColumns` returns `node.columns` only — execution parameters are not included. `validateNeighborIds` lowercases input IDs before checking internal engine sets (which use lowercase keys).

**Upstream column inspection.** Before declaring `from_col` in `contributors`, the AI can call `lineage_get_neighbor_columns` to inspect upstream column schemas — avoids guessing column names on nodes not yet visited.

**Per-hop injection.** `buildColumnAspectPrompt` (stable prefix) establishes the PRIMARY/SUPPORTING hierarchy before templates render — one canonical surface. `buildCurrentTaskBlock` appends a `<column_trace>` XML block with the binary map-or-prune decision gate and, when prior edges exist, a `<lineage_questions>` block labeled as PRIMARY follow-up (more important than the AI's own sub_question).

**Gate.** `scopeSummaryRenderer` shows `Column-Trace — columns: [X, Y]` in the consent gate so the user sees which columns are traced before approving.

**Synthesis.** When the agenda drains, `buildCtSynthesisBlock` renders the accumulated edge chain and appends it to the synthesis reminder. `present_result` is anchored to the traced path. CT overrides the standard badge_label grouping — sections group by chain role (origin / writers / terminal source) instead.

**Follow-up column traces from `completed` phase.** When the user asks a follow-up column question after a completed trace, the AI calls `start_exploration` with the same origin node and new `targetColumns`. If the origin matches the prior result (`sess.resultGraph.originNodeId`), `toolProvider.ts` auto-routes to the supplement path: `supplementAgenda(visitedIds)` re-queues all previously visited nodes in SM, `setColumnTargets(targetColumns)` updates the engine's column-trace context, and the session re-enters `exploring` without a gate or archive wipe. Different-origin follow-ups still trigger a fresh start with gate confirmation.

## Key inventory — purpose & maintenance

### Synthesis — fields the AI writes from scratch

The AI writes these per-field instructions; the engine builds the rendered document from `title + intro + sections[] + closing` via `orderAndAssemble()`.

| Key | Purpose | Edit this when |
|-----|---------|----------------|
| `summary` | One-line graph-card teaser (~120 chars). Shown on the AI view card. | Tightening or loosening the card-line tone; changing the max-character target. |
| `title` | The `# …` document heading (≤ 80 chars) naming the analysis subject and key finding. | Changing how the title balances subject vs. finding; banning step counts. |
| `intro` | 2–4 sentence narrative opener before the sections. | Changing tone, what the intro is allowed to mention (e.g. ban schema dumps), or how it anchors to the user's question. |
| `closing` | Optional `---` divider + cross-cutting through-line / risk. Gated on archive size ≥ 5. | Changing the threshold (in `templateRenderer.ts`) or what cross-cutting issues warrant it. |
| `highlights` | 2–3 critical-node glows on the graph (Lineage or Diagnostic scheme). | Changing how aggressively to highlight or the colour scheme. |
| `notes` | Per-node graph captions — one-line, what the node does specifically in this flow. | Changing caption length or style (e.g. always lead with the formula vs. the role). |

**No template for `sections[]` here.** The lift-verbatim + group-siblings + label-by-role rule is owned by `buildSynthesisPrompt()` in [`src/ai/prompts.ts`](../src/ai/prompts.ts). Editing that function is the single source of truth for how synthesis assembles the per-node captured bodies into the final report.

**No template for `description`.** The description blob shown in the overlay is engine output, built deterministically by `orderAndAssemble()` from `title + intro + sections[] + closing`. There is no AI-writeable `description` field — adding one would conflict with the deterministic assembly.

### Active — per-hop capture into the unbounded archive

| Key | Purpose | Edit this when |
|-----|---------|----------------|
| `business_capture` | The body of the section the AI submits with `angle: 'business'` per hop (one entry in `submit_findings.sections[]`): business meaning, formulas, column renames, ⚠️ invariants, question-relevance evidence. Fires when classification ∈ {business, both}. | Adding a per-hop business-content requirement (e.g. "always list affected consumers"). Each capture template is independent — no cross-references to other capture templates. |
| `technical_capture` | What the AI writes for the technical angle: verbatim SQL, loading pattern, joins, antipatterns, distribution hints. | Adding a per-hop technical-content requirement (e.g. "always note hash-distribution column"). |
| `structural_summary` | Reduced active-phase template fired only when the user's starting point is a non-bodied node (a table). Replaces `business_capture` / `technical_capture` for that one hop with a Purpose / Columns / Upstream / Downstream / Grain skeleton. | Changing the table-origin slot shape — e.g. adding an FK / index sub-section. Don't put transform formulas here; those belong in the procedure slots. |

## Maintenance rules

- **Capture must cover what synthesis lifts.** `business_capture` and `technical_capture` write the bodies that `buildSynthesisPrompt()` instructs the AI to lift verbatim into `present_result.sections[]`. If the capture instruction does not require a fact, synthesis cannot mention it — there is no second pass.
- **Edit the `instruction:` field, not the examples.** Only `instruction` is injected into the prompt. The example fields exist for the human reader.
- **Avoid character ceilings on archive fields.** The archive is unbounded; capping section text per slot pushes the model to pre-compress, which starves synthesis for detail. Describe quality criteria ("cover every business rule and SQL evidence point"), not character counts. Per the design rule: AI does grouping/order, system does numbers.
- **Verdict names are locked.** `analyze` / `pass` / `prune` are enforced by a Zod enum on `submit_findings.verdict`. Only the YAML descriptions can change, not the names.
- **Don't hand-edit the stage routing.** `STAGE_BY_KEY` and `CLASSIFICATION_GATED` in [`src/ai/templateRenderer.ts`](../src/ai/templateRenderer.ts) are the authoritative routing. Adding a new active-phase capture template requires a YAML entry plus a `STAGE_BY_KEY` registration; if it is classification-specific, also add it to `CLASSIFICATION_GATED`.

## How to verify a YAML edit

1. Reload the VS Code window (Command Palette → **Developer: Reload Window**) so the overlay is reread.
2. Run an exploration that exercises the key you changed.
3. Open `View → Output → Data Lineage Viz` and set the channel log level to **Debug** (gear icon → Set Log Level → Debug).
4. Look for `[AI] [Hop N]` lines emitted for each successful `submit_findings` — they show character counts written into the archive (`detail=…`, `summary=…`). A drop on a hop you just tightened means the AI captured less; a jump means you broadened.
5. The synthesised document is in the chat panel; the structured view is in the AI view card. Compare against an earlier run if you want a delta.
