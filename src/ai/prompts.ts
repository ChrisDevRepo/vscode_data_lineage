/**
 * AI prompt builders for the `@lineage` chat participant.
 *
 * Each exported function returns a complete prompt string injected at a
 * specific point in the chat loop. Navigation-mode prompts live in
 * `smPrompts.ts` (Universal Markdown blocks).
 */

import type { DeferredQuestion } from './smTypes';


/**
 * Single-source contract describing how the AI must treat neighbors that fall
 * outside the session's approved schemas or depth cap.
 *
 * @remarks
 * Referenced from every prompt block that discusses routing (active-phase tool
 * usage, SM mode routing). Keeping the text in one place prevents wording
 * drift across model families and preserves the stable prompt prefix for
 * Anthropic prompt caching.
 *
 * The contract:
 * 1. Out-of-scope routing is *encouraged* when mission-relevant — the engine defers it.
 * 2. Deferred routes are surfaced post-synthesis as an inline UI affordance.
 * 3. Per-route disposition is reported back via `route_outcomes[]`.
 * 4. The detail analysis references only `accepted: true` nodes; deferred nodes are
 *    surfaced exclusively via the post-synthesis follow-up pill — do not enumerate
 *    them in the report.
 */
export const OUT_OF_SCOPE_CONTRACT: string =
  'Out-of-scope routes (schema or depth beyond the approved border) are encouraged when mission-relevant. The engine defers them and surfaces them to the user post-synthesis via the follow-up pill. Each `submit_findings` tool result reports `route_outcomes[]`; reference only nodes with `accepted: true` inside your captured `sections[]`. Do not enumerate deferred nodes in the report — the follow-up pill handles that surface.';


/**
 * Constructs the base system prompt used to govern AI behavior across all phases.
 *
 * @remarks
 * Contains the role definition, injected app context (platform, schemas, node counts),
 * and core grounding rules. LaTeX is intentionally absent — it is only relevant during
 * active exploration where math expressions appear in SQL transform analysis.
 *
 * @param phase - Current session phase; surfaces as the "Current phase: …" line so the AI knows which protocol applies before the phase-specific block is appended.
 * @param dbPlatform - Human-readable database platform string from the loaded model.
 * @param filterSchemas - Schema names currently active in the user's filter.
 * @param totalSchemaCount - Total number of schemas in the loaded model.
 * @param visibleNodes - Number of nodes visible under the active filter.
 * @param totalNodes - Total number of nodes in the loaded model.
 * @returns The assembled base system prompt string.
 */
export function buildGeneralSystemPrompt(
  phase: 'discover' | 'active' | 'synthesis' | 'completed',
  dbPlatform: string,
  filterSchemas: string[],
  totalSchemaCount: number,
  visibleNodes: number,
  totalNodes: number,
): string {
  const isFiltered = filterSchemas.length > 0 && filterSchemas.length < totalSchemaCount;
  const schemasLine = isFiltered
    ? `- Schemas: ${filterSchemas.join(', ')} (${filterSchemas.length} of ${totalSchemaCount} schemas)`
    : `- Schemas: All (${totalSchemaCount} schemas)`;
  const phaseLabel = { discover: 'DISCOVERY', active: 'ACTIVE EXPLORATION', synthesis: 'SYNTHESIS', completed: 'FOLLOW-UP' }[phase];

  return [
    '# Data Lineage Assistant',
    '',
    'You are the @lineage assistant inside the Data Lineage Viz extension for Visual Studio Code.',
    'The extension loads a SQL database object dependency graph — tables, views, stored procedures,',
    'and functions — and lets developers and data engineers explore it through chat.',
    '',
    `Current phase: ${phaseLabel}.`,
    '',
    '**Grounding rule:** Use only object IDs, columns, and relationships returned by tool calls. Never infer, construct, or invent identifiers.',
    '',
    '## Context',
    `- Platform: ${dbPlatform}`,
    schemasLine,
    `- Visible objects: ${visibleNodes} of ${totalNodes}`,
  ].join('\n');
}


/**
 * Constructs the prompt for the Discovery/Idle phase.
 *
 * @remarks
 * Two blocks: Class D vs Class S routing (with tiebreaker + worked examples),
 * and a one-line response-format constraint. Tool parameter routing and
 * filter-boundary semantics live in each tool's modelDescription — not here.
 *
 * @returns The assembled discovery-phase prompt string.
 */
export function buildDiscoveryPrompt(): string {
  return [
    '## Routing — classify the question first',
    '',
    "Every question lands in exactly one class. Classify first, then use only that class's tools.",
    '',
    '### Class D — Direct (chat answer)',
    'Use ONLY when the question concerns **one named object in isolation** OR **graph-wide metadata**. Signals — one object name + any of: "what does X do", "show DDL of X", "list columns of X", "find objects named/matching Y", "which objects reference pattern P", "does X exist", "count of X in schema S", "what schemas are loaded", hubs / orphans / cycles / longest paths.',
    '',
    'Pick the tool from the available discovery set based on its own description. Cross-tool cue: `lineage_get_object_detail.up[]` / `dn[]` answers "who are X\'s direct neighbors" for simple identification. **CRITICAL:** Do NOT use Class D to narrate a "flow", "lineage", "pipeline", or "join path" across those neighbors — even if you have the DDL, those are Class S tasks. Reply as chat text.',
    '',
    '### Class S — State machine (call `lineage_start_exploration`)',
    'Use when the question asks for **analysis, narrative, or visualization of a relationship** spanning two or more connected objects.',
    '',
    'Signals — verbs "analyze / explain / walk through / trace / track / follow / document / compare"; nouns "lineage / dependencies / graph / relationship / impact / blast radius / pipeline / flow / path / join path"; scope qualifiers "direct neighbours / one hop up / upstream only / downstream of X / between A and B"; NL filters that only make sense over a scope ("ignore UDFs", "only tables", "exclude schema X", name-based exclusions); any column name tied to an object (set `targetColumns`).',
    '',
    '**Column Trace selection:** if the user names a specific column (`[Object].[Column]` or "the X column"), extract it directly as `targetColumns`. If the user names intent without naming columns ("salary columns", "revenue calculations"), call `lineage_get_object_detail` on the origin first to inspect its column list, then select the 2–4 columns that match the intent. Pass all selected columns to `lineage_start_exploration` as `targetColumns`.',
    '',
    '**Rule:** If the user asks for a "lineage graph", "annotated trace", or to "explain the joins/pipeline" of an object, you MUST use Class S. Do not short-circuit to Class D prose just because you found the neighbors in a detail lookup.',
    '',
    'Resolve every user-named identifier — both the origin and any names the user said to ignore / exclude / drop / skip — with `lineage_search_objects` BEFORE calling `lineage_start_exploration`. The model has many schemas; user-shorthand names ("RECON", "EXCP2") often live in a non-default schema. Inventing an id like `[dbo].[recon]` causes `lineage_start_exploration` to reject with `unknown_node_ids`. If multiple candidates match, ask the user to pick. Then call `lineage_start_exploration` — its parameter descriptions carry the full contract (scope mapping, NL-filter handling, `mission_brief` composition, classification values).',
    '',
    'The engine emits a `confirm_sm_start` consent gate on every exploration so the user can review scope (nodes, schemas, excluded types, mode) before analysis runs. Present it to the user; that is expected control flow, not an error to retry around.',
    '',
    'When a `confirm_sm_start` gate is pending and the user replies with anything other than approval/cancel, treat their message as refinement intent (scope, mode, classification, or column tracing): re-call `lineage_start_exploration` with the same `origin` and `depth` plus updated `excludeTypes` / `excludeSchemas` / `excludeNodeIds` / `passNodeIds` / `forceMode` / `classification` / `targetColumns`. Each call is a full re-spec — keep all prior filters and add the new one. The engine re-emits the gate; the loop continues until the user approves or cancels. Analysis tools are not available during this loop.',
    '',
    '### Tiebreaker',
    'When a question could plausibly fit either class, prefer Class S. Shallow multi-object metadata summaries are the primary failure mode on this extension.',
    '',
    '### Examples',
    '',
    '<example>',
    'User: "what does spProcA do"',
    'Class: D',
    "Action: `lineage_get_object_detail(id:'[dbo].[spProcA]')` → chat answer.",
    '</example>',
    '',
    '<example>',
    'User: "analyze the tableZ pipeline with its direct neighbours, ignore UDFs and views"',
    'Class: S',
    "Action: `lineage_start_exploration(origin:'[dbo].[tableZ]', depth:1, direction:'bidirectional', depth_enforcement:'strict', excludeTypes:['function','view'], excludeSchemas:['staging'], classification:'business', mission_brief:'User wants the business logic of tableZ with its direct neighbours only. Scope: depth 1, bidirectional. NL filter excludes UDFs, views, and the staging schema (excludeTypes + excludeSchemas set structurally).')`.",
    '</example>',
    '',
    '## Response format',
    '',
    'Markdown only. Match response length to the question.',
  ].join('\n');
}


/**
 * Constructs the prompt for the Active (Hop-by-Hop or Full Run) phase.
 *
 * @remarks
 * Dynamically switches instructions based on whether the engine is in True Inline mode
 * or Sliding Memory mode, while sharing the core heuristic rules for node analysis.
 *
 * Scope: this builder owns only the per-call `submit_findings` rules (sections,
 * anchoring, math, routing). The two-call inline turn flow ("after
 * submit_findings, call present_result") and the synthesis assembly contract
 * for inline live in `buildModeBlock` in `smPrompts.ts` — kept there to stay
 * adjacent to the inline batch protocol and to reuse {@link buildSynthesisPrompt}
 * verbatim (single source of truth).
 *
 * @param isInline - Whether the engine is delivering the entire graph context at once.
 * @returns A formatted system instruction for the active phase.
 */
export function buildActivePhasePrompt(isInline: boolean): string {
  const mode = isInline
    ? 'TRUE INLINE: Analyze all nodes holistically in a single turn.'
    : 'SLIDING MEMORY: Analyze nodes sequentially as presented.';

  return [
    '# Active Exploration Protocol',
    `Mode: ${mode}`,
    '',
    '1. SECTIONS: Submit `sections[]` with one entry per fired `*_capture` template for the locked classification — `business` → 1 business section; `technical` → 1 technical section; `both` → 2 sections (one of each). **The archive is unbounded** — write as deeply as the focus node\'s role warrants. Capture every business rule the DDL exposes: each CASE branch, threshold, allocation formula, special-case predicate. Synthesis lifts your body verbatim, so depth here is depth in the final document.',
    '2. ANCHORING: Align every verdict with the `<mission_brief>` and `<current_task>`.',
    '3. MATHEMATICS: Wrap every formula in LaTeX math delimiters — $expr$ inline, $$expr$$ block — transforms, allocations, thresholds, proportions, CASE expressions. Never use backticks for formulas. Correct: $\\text{Ratio} = \\frac{A}{B}$. Wrong: `\\text{Ratio} = \\frac{A}{B}`. Math delimited this way reaches the final document; math in backticks or plain prose does not.',
    '4. ROUTE_REQUESTS: Source every `nodeId` verbatim from a prior tool result — `next_hop` / `neighbors[]` from a previous `submit_findings`, a `lineage_get_neighbor_columns` lookup, or a `lineage_search_objects` result. Reconstructed ids from question text fail validation. On `route_validation_failed`, the rejection envelope returns `route_target_candidates` (up to 3 fuzzy matches per unresolved id) — pick a candidate verbatim or call `lineage_search_objects` to find the right id, then re-submit.',
    `5. ROUTE OUTCOMES: ${OUT_OF_SCOPE_CONTRACT}`,
  ].join('\n');
}


/**
 * Constructs the synthesis-phase cue.
 *
 * @remarks
 * Owns the full lift+group+label contract for `present_result.sections[]`.
 * The active-phase capture rules already wrote each slot body; this cue tells
 * the model how to assemble, group, label, and frame those bodies — and where
 * the boundary between AI input and engine output lies.
 *
 * Consolidated here (rather than via a YAML template) to avoid drift between
 * the synthesis cue and the section-assembly rule. The engine-built fields
 * (description, badge numbering, object link headers) are explicitly named so
 * the model never tries to write them.
 *
 * @returns A string containing the synthesis-phase cue.
 */
export function buildSynthesisPrompt(): string {
  return [
    '# Synthesis Protocol',
    'The archive is closed. Each slot in the last `tool_result.detail_slots[]` carries',
    '`slot.sections: [{ angle }]` — one entry per fired `*_capture` template at capture time.',
    '',
    'Your job: call `lineage_present_result` with `summary`, `title`, `intro`, **`sections[]`**, and optional `closing` / `notes` / `highlight_groups`. The engine assembles the rendered document (section numbering, badge chips, object link headers, verbatim section bodies) deterministically from your structural decisions. `intro` is a 2–4 sentence headline, not the whole report.',
    '',
    '## sections[] — REQUIRED',
    'Group along TWO orthogonal axes:',
    '1. **Angle** — keep `"business"` and `"technical"` slots in separate sections. Under `classification = both` you get two parallel section streams; under a single-angle classification you get one stream.',
    '2. **Badge** — within a single angle, slots that share a `badge_label` become ONE section (use the badge as the section `label`; list every grouped node id in `node_ids[]`). Slots with distinct labels each get their own section.',
    '',
    'Result: under `both`, two badge-grouped streams = `business_section_count + technical_section_count` final entries. Under single-angle classification, one stream.',
    '',
    'For each section:',
    '- `label`: the shared `badge_label` from the captures (pick the shortest accurate one if the captures gave verbose per-node variants).',
    '- `angle`: `"business"` or `"technical"` — which capture angle this section represents.',
    '- `node_ids[]`: every grouped slot id within this angle.',
    '- `text`: write the section body. Draw from the captured detail in `detail_slots[]` for each `node_ids[]` entry — you own the text.',
    '',
    'Pass / Prune slots: mention in one line inside a `### Passthrough / Pruned` subsection of the relevant section — add this subsection as plain text in `closing`, not as a separate section.',
    '',
    '## Other parts',
    '- `summary` (REQUIRED): one line, ≤300 chars, the headline of the analysis.',
    '- `title`: ≤80 chars, "[Subject] — [key finding]" shape.',
    '- `intro`: 2–4 sentences, anchored to the user\'s question and the locked Mission type. Headline-level only — no walkthrough, no formulas (those belong in sections).',
    '- `closing`: optional cross-cutting risk or through-line, prefixed ⚠️ for risks. Omit if nothing material to add.',
    '- `notes[]`: per-node captions (≤200 chars). Use `note_caption` from each captured slot.',
    '- `highlight_groups[]`: optional color glow on 2-3 critical nodes.',
    '',
    'Use `suggested_sections` from the completion result as a starting skeleton when present. Deferred-questions, if present, are objects skipped during BFS — surface them once at the end if material.',
  ].join('\n');
}


/**
 * Constructs the prompt for the Follow-Up phase (post-synthesis refinement).
 *
 * @remarks
 * Fires when `sess.phase.kind === 'completed'` on a subsequent user turn. The archive rides
 * into context via VS Code's history replay (prior tool_result is compacted and replayed);
 * no new read tool is needed. Tells the model to refine the existing answer — text edits,
 * prunes, deferred-question supplements — without starting a fresh exploration.
 *
 * @returns A string containing the follow-up-phase protocol.
 */
export function buildFollowUpPrompt(): string {
  return [
    '# Follow-Up Protocol',
    'The exploration is complete. The user\'s question, the archive (per-node captured',
    'sections), and the rendered result graph are all in your context above. You can',
    'quote from the archive, browse the catalog, or refine the visualization without',
    'starting over.',
    '',
    'Refinement paths:',
    '- Text changes, relabels, section reorders → re-call `lineage_present_result` with',
    '  the modified `sections[]`, `highlights`, or `notes`. No new analysis is needed.',
    '- Prune a node from the visualization → re-render via `lineage_present_result`',
    '  with the node removed from `nodes[]`. The archive slot is preserved.',
    '- Add a node from `deferred_questions` → `lineage_start_exploration` with the',
    '  `supplement` flag (see tool description) for a targeted pass; the result merges',
    '  into the archive; then re-render.',
    '- Catalog lookups for any object → `lineage_get_object_detail` or',
    '  `lineage_search_ddl`; cross-graph search → `lineage_search_objects`.',
    '',
    'Genuinely new traces (new origin, new direction, new scope) → tell the user in',
    'one sentence to start a fresh question.',
  ].join('\n');
}


/**
 * Transforms raw user input into a structured lineage tracing request.
 *
 * @param userInput - The entity or relationship the user wants to trace.
 * @returns A formatted prompt for the `/trace` command.
 */
export function buildTracePrompt(userInput: string): string {
  return `Trace the data lineage for: ${userInput}.`;
}

/**
 * User-facing label for the follow-up recommendation pill.
 * This string is also used as the trigger for internal prompt expansion.
 */
export const RECOMMEND_FOLLOWUPS_TRIGGER = 'Follow-up: Explore related objects…';

/**
 * Magic prompt string fired by the "Show full description" follow-up chip.
 *
 * @remarks
 * Detected verbatim by `lineageParticipant.handleChatRequest`, which short-circuits
 * the LM round-trip and writes `sess.lastPresentResultDescription` directly into
 * chat — replaying the rendered description without re-invoking the model.
 */
export const SHOW_DESCRIPTION_TRIGGER = 'Show the full description';

/**
 * Builds the chat-input pre-fill used when the user clicks the post-synthesis
 * "Explore related objects" button.
 *
 * @remarks
 * Rather than forcing the user to manually edit a raw list of deferred nodes,
 * this prompt instructs the AI to summarize the out-of-scope discoveries and
 * suggest 2-3 specific, actionable follow-up queries based on the graph structure.
 * The raw deferred list is passed in an XML block for the AI's context.
 *
 * @param entries - Validated deferred-question entries from the engine.
 * @returns The multiline prompt string to pre-fill into the chat input.
 */
export function buildDeferredQuestionsPrompt(entries: ReadonlyArray<DeferredQuestion>): string {
  const header = `Based on the graph we just explored, we found some related objects that were skipped because they were out of scope. Please summarize these skipped objects and, for the most mission-relevant ones, explain WHY I should analyze them (what specific value do they add to the story we just mapped?). Recommend 2-3 specific follow-up questions I could ask, using your knowledge of the BFS archive to justify the reasoning.`;
  const lines = entries.map((d) => {
    const schema = d.schema ? ` [schema: ${d.schema}]` : '';
    const from = ` (from ${d.fromFocusNodeId}, reason: ${d.reason})`;
    return `- ${d.nodeId}${schema}${from}`;
  });
  return `${header}\n\n<skipped_objects>\n${lines.join('\n')}\n</skipped_objects>`;
}

/** 
 * Transforms raw user input into a structured model search request.
 * 
 * @param userInput - The search term or regex provided by the user.
 * @returns A formatted prompt for the `/search` command.
 */
export function buildSearchPrompt(userInput: string): string {
  return `Search for database objects matching: ${userInput}.`;
}


/** 
 * Constructs a "Stop Gate" message when an AI action requires explicit user confirmation.
 * 
 * @remarks
 * Injected as a User message to pause the autonomous tool loop when a `action_required` 
 * state is detected by the extension host.
 * 
 * @param gates - List of reasons/conditions that blocked the execution.
 * @returns A strict instruction string for the AI to cease tool calls.
 */
export function buildActionRequiredGate(gates: string[]): string {
  return `STOP: ${gates.join(' | ')} — Address this with the user before proceeding with further tool calls.`;
}

/** 
 * Error hint provided to the AI if it attempts to call tools while a gate is pending.
 */
export const ACTION_REQUIRED_PENDING_HINT =
  'Present the previous action_required message to the user and wait for their response before calling tools.';


/**
 * Renders the CT stable-prefix anchor — injected into the active-phase system prompt when
 * `targetColumns` are set.
 *
 * @remarks
 * Establishes the PRIMARY (`column_flow`) / SUPPORTING (`sections[]`) hierarchy before any
 * capture template renders, and explicitly disambiguates the two fields so the misleading
 * capture-rules header ("submit these as sections[]") does not confuse the model into putting
 * column_flow entries into sections[]. One canonical surface for the CT field hierarchy.
 *
 * @param targetColumns - The columns being traced, as confirmed at gate-approval.
 * @returns Stable-prefix markdown block anchoring the CT session contract.
 */
export function buildColumnAspectPrompt(targetColumns: string[]): string {
  // Stable-prefix anchor: establishes PRIMARY/SUPPORTING hierarchy and disambiguates fields
  // before any capture template renders. One canonical surface for the hierarchy statement.
  return [
    '# Column Trace: active',
    `Target columns: [${targetColumns.join(', ')}]`,
    '',
    'PRIMARY job this hop: fill the `column_flow` field — structural provenance for each active column.',
    'SUPPORTING job: fill `sections[].text` — business/technical context explaining WHY the column flows this way.',
    '',
    'Fields are separate: `column_flow` ≠ `sections[]`.',
    'The capture-rules header below applies to sections[] only (business_capture / technical_capture).',
    '`column_trace_capture` → fills the `column_flow` field, not sections[].',
  ].join('\n');
}


/**
 * Constructs the Tool Usage block for the active phase.
 *
 * @returns A string containing the mechanical `submit_findings` routing and pruning constraints.
 */
export function buildToolUsageBlock(): string {
  return [
    '## Tool Constraints',
    '',
    '1. Use `lineage_submit_findings` to process focus nodes. Submit `sections[]` per the locked classification (one entry per fired `*_capture`); each section body is full-depth.',
    '2. Routing: propose next hops via `route_requests`. Honor `in_budget` and `in_approved_scope` neighbor tags. (For out-of-scope routes, see ROUTE OUTCOMES in the Active Exploration Protocol above.)',
  ].join('\n');
}


/**
 * Renders the `<mission_brief>` XML block — **session-stable** content.
 *
 * @remarks
 * Mission brief is set once at `start_exploration` and never changes during a
 * session. Placing it in the stable prefix lets the service-side prompt cache
 * cover it across every hop of the active/synthesis phase.
 *
 * @param brief - The AI-composed mission statement; may be empty before the first `start_exploration`.
 * @param question - The user's original question, used as fallback text when `brief` is absent.
 * @returns Filled mission-brief XML block, or an empty string when both `brief` and `question` are absent.
 */
export function buildMissionBriefBlock(brief: string, question: string): string {
  const missionText = brief || question;
  if (!missionText) return '';
  return [
    '## Mission Context',
    '<mission_brief>',
    missionText,
    '</mission_brief>',
  ].join('\n');
}

/**
 * Renders the `<current_task>` XML block — **per-hop dynamic** content.
 *
 * @remarks
 * Current task is the sub-question assigned to the focus node of the present
 * hop. It changes every hop in SM mode, so it lives in the dynamic suffix of
 * the system prompt, not in the cacheable stable prefix.
 *
 * The input string arrives pipe-concatenated (funnel appends each routed
 * question with ` | `) with the leading segment tagged `Root Question: <q>`.
 * This renderer splits those segments into structured XML so the AI can
 * distinguish the invariant root question from the sub-question to answer
 * THIS hop — removing ambiguity about which segment is active.
 *
 * When CT is active, a `<column_trace>` block is appended with the binary
 * map-or-prune decision gate and a tip to call `lineage_get_neighbor_columns`
 * for upstream column inspection. When prior-hop edges exist, a `<lineage_questions>`
 * block follows labelled as PRIMARY follow-up (more important than the AI's own sub_question).
 *
 * @param currentTask - Pipe-concatenated questions from the engine agenda.
 * @param columnTraceColumns - Active CT target columns for this hop; omit when CT is inactive.
 * @param columnLineageQuestions - Engine-generated lineage sub-questions from the prior hop's edges (CT only).
 * @returns Structured `<current_task>` XML block, or an empty string if `currentTask` is absent.
 */
export function buildCurrentTaskBlock(
  currentTask: string,
  columnTraceColumns?: string[],
  columnLineageQuestions?: string[],
): string {
  if (!currentTask) return '';
  const parts = currentTask.split(/\s*\|\s*/).map(p => p.trim()).filter(Boolean);
  const rootMatch = parts[0]?.match(/^Root Question:\s*(.*)$/i);
  const rootQuestion = rootMatch ? rootMatch[1].trim() : null;
  const tail = rootMatch ? parts.slice(1) : parts;
  const subQuestion = tail.length > 0 ? tail[tail.length - 1] : '';
  const preceding = tail.length > 1 ? tail.slice(0, -1) : [];
  const lines = ['<current_task>'];
  if (rootQuestion) lines.push(`  <root_question>${rootQuestion}</root_question>`);
  if (preceding.length > 0) lines.push(`  <preceding_questions>\n    - ${preceding.join('\n    - ')}\n  </preceding_questions>`);
  if (subQuestion) lines.push(`  <sub_question>${subQuestion}</sub_question>`);
  if (columnTraceColumns && columnTraceColumns.length > 0) {
    lines.push(
      `  <column_trace>`,
      `    Active columns: [${columnTraceColumns.join(', ')}]`,
      `    Per column — binary decision:`,
      `      → Interacts with this node: fill column_flow (out_col + contributors + role). Route upstream.`,
      `      → Does not interact:        verdict=prune. Omit column_flow.`,
      `    To inspect upstream column schemas before declaring contributors: call lineage_get_neighbor_columns.`,
      `    Writer procedures: out_col = column name in the target table (same as writes_to.col). Set writes_to. Role: formula/case/etc for computed expressions; rename for direct pass-through.`,
      `  </column_trace>`,
    );
  }
  if (columnLineageQuestions && columnLineageQuestions.length > 0) {
    lines.push(
      `  <lineage_questions>`,
      `    PRIMARY follow-up — column chain continuation (more important than your own sub_question):`,
      ...columnLineageQuestions.map(q => `    - ${q}`),
      `  </lineage_questions>`,
    );
  }
  lines.push('</current_task>');
  return lines.join('\n');
}


/**
 * Renders the `<short_term_memory>` XML block and the per-hop progress line for SM active hops.
 *
 * @param stm - Sliding window of the last 3 node summaries.
 * @param hop - Current 1-based hop index.
 * @param total - Total nodes in scope.
 * @returns A string containing the working-memory block.
 */
export function buildMemoryBlock(
  stm: Array<{ nodeId: string; summary: string }>,
  _hop: number,
  _total: number,
): string {
  const stmText = stm.length > 0
    ? stm.map(s => `- ${s.nodeId}: ${s.summary}`).join('\n')
    : 'No nodes visited yet.';
  return [
    '<short_term_memory>',
    stmText,
    '</short_term_memory>',
  ].join('\n');
}


/**
 * Renders the `<mission_state>` band — focus + progress informational fields.
 *
 * @remarks
 * Engine-orchestration fields (`engine_status`, `expected_reply`, `legal_replies`,
 * `session_ends_when`, `free_text`) were removed: they are mechanically enforced
 * via `LanguageModelChatToolMode.Required` and `toolPolicy`, so restating them in
 * prose is dead weight (per CLAUDE.md *"Per-hop prompts are rendered, not configured"*).
 *
 * Included only in SM active hops (inline-BB is one-shot; DISCOVERY and SYNTHESIS
 * use their own protocols).
 *
 * @param hop - Current 1-based hop index.
 * @param total - Total nodes in the BFS scope.
 * @param agendaRemaining - Nodes still awaiting analysis.
 * @param focusNodeId - The node the AI must analyse this hop — surfaced in prose so the AI can match tool-result JSON, especially on hop 1 when no prior tool_result exists.
 * @returns A string containing the `<mission_state>` block.
 */
export function buildMissionStateBlock(
  hop: number,
  total: number,
  agendaRemaining: number,
  focusNodeId: string | null,
): string {
  const lines = ['<mission_state>'];
  if (focusNodeId) lines.push(`  focus_node_id: ${focusNodeId}`);
  lines.push(
    `  hop: ${hop} / ${total}`,
    `  agenda_remaining: ${agendaRemaining}`,
    '</mission_state>',
  );
  return lines.join('\n');
}
