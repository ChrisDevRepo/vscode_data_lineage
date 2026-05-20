# AI Prompting And Templates - Full Crosscheck Guide

This document is the code-accurate reference for prompt behavior in this repository.
It covers all prompt surfaces (not only YAML), LM tools, commands, table/graph output contracts, and verification tests.

## Scope and source of truth

Prompt behavior is split across these files:

- `assets/aiOutputTemplates.yaml` - editable template instructions.
- `src/ai/prompting/prompts.ts` - base/system prompts + phase protocol entrypoint.
- `src/ai/prompting/smPrompts.ts` - active-phase SM protocol + synthesis reminders.
- `src/ai/prompting/templateRenderer.ts` - authoritative template routing and gating.
- `src/ai/tools/tools.ts` + `src/ai/tools/toolProvider.ts` - schema enforcement and deterministic assembly.
- `package.json` - LM tool schema/model descriptions and chat command metadata.

Important correction: YAML is not the only authoritative surface. YAML controls template instructions, but phase prompts and mechanical enforcement are code-owned.

## TS assembly map (post-reorg)

Prompt assembly is now phase-first in TS:

- `buildGeneralSystemPrompt(...)` - shared system baseline.
- `buildPhasePrompt(phase)` - canonical static protocol per phase (`discover` / `active` / `synthesis` / `completed`).
- `buildSmProtocol(...)` - active-phase SM-only static guidance (verdicts, section-shape, routing/pruning contracts, CT anchor). BB and CT variants are separated here; CT variant removes all AI pruning vocabulary — engine handles pruning via `column_flow` absence.
- `resolveStagePrompt(...)` - YAML template injection and gating.
- Dynamic active-only blocks:
  - `buildCurrentTaskBlock(...)`
  - `buildMissionStateBlock(...)`
  - `buildMemoryBlock(...)`

In `lineageParticipant`, stable assembly is:

1. general system prompt
2. phase protocol
3. SM protocol (active only)
4. YAML stage block
5. mission/discovery summary metadata blocks

Dynamic assembly is appended only during active hops.

Active-phase context rule: in strict sliding-memory mode, `<short_term_memory>` is the only narrative carry-over channel (last 3 summaries). Prior-hop tool payloads are not broadly replayed in active requests; only minimal protocol continuity data is preserved, with canonical-field de-dup (`<mission_state>` owns hop/focus state, `<mission_brief>` owns mission intent, replay owns only current-hop evidence).

## Active hop decision contract (canonical)

Routing/pruning policy is canonicalized in `buildSmProtocol()` (`src/ai/prompting/smPrompts.ts`) under **Neighbor Decision Contract (Current Hop Only)**.

- Actionable IDs are current-hop `neighbors[]` + current `focus_node`.
- History (`short_term_memory`, prior hops, archive) is reference-only.
- Active-phase `prompts.ts` now points to this contract instead of duplicating route/prune policy text.
- Out-of-scope but mission-relevant routes are still deferred and preserved for post-synthesis follow-up.
- Lifecycle state is code-owned, not prompt-inferred. The only persisted node actions are `analyze`, `pass`, and `prune`; table passthrough is represented as `pass` with an engine reason, not as a fourth action.

Reviewer artifact:
- A local reviewer compilation may be generated under `tmp/` for prompt reviews (commands/tools inventory + one 1:1 active-hop prompt example from trace).
- It is a trace snapshot and may lag behind current prompt code; source-of-truth is the code-owned prompt surfaces in `src/ai/prompting/*` plus template routing in `templateRenderer.ts`.

## AI vs engine ownership

| Owner | Writes/builds | Where enforced |
|---|---|---|
| AI | `submit_findings.sections[]` (`business`/`technical` angle text), `summary`, `title`, `intro`, `sections[]`, `closing`, `notes[]`, `highlight_groups[]` | `prompts.ts`, `smPrompts.ts`, tool schemas |
| Engine | Deterministic markdown assembly, section numbering (`## N`), badge chips, object link headers, validation and rejection envelopes | `orderAndAssemble()` + `validatePresentResult()` in `src/ai/tools/tools.ts` |

Important correction: in synthesis, final `sections[]` fields are AI-authored. The engine assembles structure deterministically, but does not auto-create missing section text, node links, labels, or captions.

## Template routing (authoritative)

`templateRenderer.ts` gates templates by stage + classification + CT mode + focus type.

### STAGE_BY_KEY

- discover: `discovery_chat`, `general`
- active: `business_capture`, `technical_capture`, `structural_summary`, `column_trace_capture`
- synthesis: `summary`, `title`, `intro`, `closing`, `highlights`, `notes`, `general`, `loading_pattern`

### CLASSIFICATION_GATED

- `business_capture` -> `business`, `both`
- `technical_capture` -> `technical`, `both`
- `loading_pattern` -> `technical`, `both`

### CT_MODE_GATED

- `column_trace_capture` fires only when `targetColumns` is active.

### Other mechanical gates

- `closing` only fires when `slotCount >= 5`.
- `structural_summary` fires on any non-bodied focus hop (table/external), not only the starting hop.
- On non-bodied hops, `business_capture` and `technical_capture` are gated out.

## Complete YAML key inventory

### Discovery

- `discovery_chat`: direct-answer discovery formatting and grounding.

### Active capture

- `business_capture`
- `technical_capture`
- `structural_summary`
- `column_trace_capture` (CT mode only)

Business-capture contract (business mode) is now explicitly `what / why / how`:
- What business outcome changes.
- Why the rule exists (decision objective) when evidenced in current DDL.
- How the rule executes (conditions, thresholds, formulas).
- Upstream assumptions and downstream effects when evidenced.
- Lifecycle/audit meaning and only material, decision-impacting risks.

### Synthesis output

- `summary`
- `title`
- `intro`
- `closing`
- `highlights`
- `notes`
- `loading_pattern` (technical/both only)

### Cross-phase style layer

- `general` (discover + synthesis)

## Start/submit/present mechanical contracts

### `lineage_start_exploration`

- `classification` is required enum: `business | technical | both`.
- Supports refine loop and post-synthesis supplement path (`supplement.nodeIds`).
- `targetColumns` activates CT mode.

### `lineage_submit_findings`

- Single tool, mode-dispatched schema:
  - BB contract: allows `verdict=prune` and `prune_neighbors`.
  - CT contract: allows only `verdict=analyze|pass`, requires `column_flow`, rejects BB-only fields.
- `sections[]` count/angles are locked by classification (`submitFindingsRules.ts`).
- For CT, AI always provides `column_flow` field. Non-empty → node in chain (validation runs). `column_flow: []` (explicit empty) → engine auto-prunes silently. Missing `column_flow` field rejects at boundary (`ct_field_required`). `verdict=prune` rejects at boundary (`ct_verdict_forbidden`). `prune_neighbors` rejects at boundary (`bb_field_forbidden_in_ct`).
- CT prompts contain no pruning vocabulary — AI is not taught to prune in CT; engine derives all pruning from `column_flow` content.
- CT neighbor decisions: `route_requests` for contributors; non-contributors simply omit routes (engine auto-prunes from empty `column_flow`). `prune_neighbors` remains a BB-only AI command.
- BB and CT both populate `node_states[]` through the same engine lifecycle path. BB prune comes from `verdict:"prune"` or `prune_neighbors[]`; CT prune comes from `column_flow: []` or no active columns; table passthrough comes from non-bodied contraction.
- Atomic commit contract: if validation fails (for example `route_validation_failed`), no hop state is persisted from that call. The model must correct inputs and resubmit.
- Rejection hints are **mode-pure**: built from the gate-locked mode (`columnAspect`) + a structural `InvalidRouteKind`, never from message text. A BB session's hints never mention `column_flow`/contributors.
- **Rejections are structured guiding orders, not "failed".** Each content error returns a machine `error` code (`out_col_not_on_node` / `contributor_col_not_on_source` / `route_columns_not_on_target`, or `route_validation_failed` for mixed kinds), a **verb-led imperative `hint`** with the legitimate alternative built in (e.g. "Set from_col to a column the source provides, or remove the contributor"), and `detail.available_columns` (the valid set as grounding data, not a pick-menu). Positive framing only — no "do not".
- **Unresolvable references are non-fatal.** A route target or column contributor that resolves to no model node is recorded (surfaced via `recent_rejections` and, for routes, `route_outcomes` `reason: unresolved`) and skipped — the hop proceeds. This removes the casing-retry/budget-burn stall.

### `lineage_present_result`

- AI submits structured parts; engine assembles deterministic description.
- Validation enforces summary/name/sections/highlights and markdown fence integrity.
- No AI-writeable `description` input field.
- Follow-up relabel/regroup requests must update final `sections[]` (`label` / `node_ids`), because badge chips are derived from sections.
- Final `sections[].label` is the authoritative short graph/detail pointer and maps 1:1 to `sections[].text`.
- Final `sections[].node_ids[]` is optional and AI-owned: a section label may link many nodes, a node may have zero labels, and a node may appear in at most one section.
- `notes[]` are optional AI-authored per-node captions shown below the graph and do not create or rename section badges.
- Synthesis must consider all three final evidence surfaces: `detail_slots[]` for analyzed narrative, `node_states[]` for pass/prune/analyze lifecycle, and `columnAspect.edges[]` for CT provenance. A pass-state table may need a label, caption, or source highlight even when it has no detail slot.
- In CT mode, `present_result` validation rejects missing visible terminal source tables from the final section/highlight surface so the root column source is not silently omitted.

## Tool policy by phase

Defined in `src/ai/tools/toolPolicy.ts` and tested in `tests/unit/toolPolicy.test.ts`.

- discover: `lineage_get_context`, `lineage_search_objects`, `lineage_get_scope_bundle`, `lineage_search_ddl`, `lineage_get_object_detail`, `lineage_detect_graph_patterns`, `lineage_start_exploration`
- active (`sm_bb` or `sm_ct`): `lineage_submit_findings`, `lineage_get_neighbor_columns`
- synthesis: `lineage_present_result`
- completed: `lineage_present_result`, `lineage_get_object_detail`, `lineage_search_ddl`, `lineage_search_objects`, `lineage_start_exploration`

### Completed-phase replay contract

- Completed/follow-up turns run with a compact replay envelope (minimal trailing tool pair), not broad full-history replay.
- Replayed tool-call envelopes carry `replay_compacted: true` and `trace_replay: true` markers so diagnostics can distinguish replay context from fresh model intent.
- Replayed `lineage_present_result` history payloads are compacted to summary metadata (`view_name`, `node_count`, `graph_source`) once SM is complete.
- Follow-up turns inject a compact “current rendered result snapshot” (title/summary/section map + bounded description excerpt) so edits can be made without replaying full prior payloads.
- If the follow-up recommendation pill is clicked with zero deferred objects, the participant now injects a fallback prompt that asks for at least two concrete, same-topic follow-up questions grounded in the current rendered result (instead of returning internal Route A/Route B protocol prose).
- Deferred follow-up guidance now distinguishes:
  - mandatory-now per skipped object (`add_now` or `keep_pruned_now`),
  - optional-later questions only for non-mandatory future investigation.

## Discovery escalation contract

- Discovery is default. Single-object asks use `lineage_get_object_detail`. Graph-scope asks use `lineage_get_scope_bundle` with explicit finite depth.
- Escalate to `lineage_start_exploration` only when:
  - explicit visual graph/render request,
  - explicit column trace request (`targetColumns`),
  - explicit post-discovery deeper-analysis intent,
  - `over_discovery_budget` from `lineage_get_scope_bundle`.
- Discovery scope budget guarding is enforced at `lineage_get_scope_bundle` when `include_ddl:true` using `discoveryNodeCap` + `discoveryTokenBudget`.
- `lineage_start_exploration` preflight remains a second safety net and must stay aligned with the scope contract rendered in `confirm_sm_start`.
- If intent is ambiguous between chat and graph, discovery answers in chat first; the post-discovery deeper-analysis follow-up remains the opt-in path to SM.

## Commands crosscheck

From `src/commands.ts` + `package.json`.

### Prompt/template relevant commands

- `dataLineageViz.createAiOutputTemplates`
- `dataLineageViz.aiResolveGate`
- `dataLineageViz.aiCreateView`
- `dataLineageViz.dumpSmState`
- `dataLineageViz.copyDebugInfo`

### Chat participant slash commands

- `/trace`
- `/search`

## Table and graph output contracts

- Graph badges are derived from section labels and numbered by assembly order.
- Description markdown is assembled as: `title` -> `intro` -> numbered `sections[]` -> `closing`.
- Object links are injected as `### Objects [name](#focus-node:id)` when node mapping exists.
- Nodes not discussed in the detail description do not need badges.
- Nodes without detail slots can still be discussed when lifecycle/provenance makes them central: examples include CT terminal source tables, target tables, and contracted pass-through tables.
- The follow-up "Show full description" chat replay sanitizes focus anchors to plain object names for readability; overlay rendering keeps interactive focus links.
- CT-only synthesis guidance (`buildCtSynthesisBlock`) groups by the traced-column answer and keeps pass-through nodes compact.

## Markdown normalization contract

- `src/components/aiDescriptionMarkdown.ts` normalization is **non-destructive**.
- Math rendering in preview is handled by `react-markdown` with `remark-math` + `rehype-katex`.
- Supported math syntaxes are inline `$...$`, block `$$...$$`, and fenced ` ```math `.
- Normalization must never remove, truncate, or silently rewrite business content.
- If rendering ambiguity exists (for example currency-like `$0$` vs inline math), preserving source text takes priority over formatting convenience.

## Test crosscheck matrix

Prompt/tool behavior is covered by these tests:

- `tests/unit/ai-tool-registration.test.ts` - manifest tools equal registered tools.
- `tests/unit/toolPolicy.test.ts` - phase tool allow-list.
- `tests/unit/start-exploration-schema.test.ts` - required classification and schema constraints.
- `tests/unit/classification.test.ts` - classification lock and session behavior.
- `tests/unit/column-flow-validation.test.ts` - CT field validation and roles.
- `tests/unit/navigation-engine*.test.ts` - SM routing, supplement, graph traversal behavior.
- `tests/unit/refine-loop.test.ts` - gate refine flow.
- `tests/unit/messageEnvelope.test.ts` - tool_use/tool_result invariants.

Graph/table extraction correctness and parser behavior are covered by:

- `tests/unit/graphBuilder.test.ts`
- `tests/unit/graphAnalysis.test.ts`
- `tests/unit/graph-analysis-aw.test.ts`
- `tests/unit/parser-edge-cases.test.ts`
- `tests/unit/tsql-complex.test.ts`
- `tests/unit/snapshot-aw-baseline.ts`

## YAML edit verification workflow

1. Run command palette: `Data Lineage: Create AI Output Templates` (if overlay file is not created yet).
2. Set `dataLineageViz.ai.outputTemplateFile` to your overlay path.
3. Reload window (`Developer: Reload Window`).
4. Run a scenario that exercises changed keys.
5. In `Output -> Data Lineage Viz` (Debug level), inspect `[AI] [Hop N]` detail/summary char metrics and rejection envelopes.
6. Verify final chat synthesis + graph chips/notes align with intended key behavior.

## Completion checklist

Use this checklist before claiming prompt-doc completeness:

- All 13 template keys are documented.
- Stage/classification/CT/non-bodied/slot-count gates are documented.
- Tool-phase policy is documented and matches tests.
- Commands and slash routes relevant to prompting are documented.
- Deterministic table/graph assembly ownership is documented.
- Verification tests and run commands are documented.
- TS phase-first assembly map is documented and matches `lineageParticipant`.
