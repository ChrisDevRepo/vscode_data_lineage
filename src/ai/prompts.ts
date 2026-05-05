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
    '**Grounding rule:** Every fact you state must come directly from data in the provided context — `focus_node` fields (`bb_ddl`, `cols[]`, `in[]`, `out[]`, `fks[]`), tool results, or prior captured slots. Never infer, construct, or invent object names, columns, neighbors, relationships, or SQL logic. If a field is absent or empty, state that explicitly ("None found in graph", "No downstream consumers") — do not guess based on naming conventions or assumed patterns.',
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
 * Discovery is the default chat state. Most user questions are answered in chat
 * directly using catalog tools (search, get_object_detail, search_ddl). When
 * the user wants a graph rendered in the GUI, a deep multi-object analysis, or
 * column tracing, the AI escalates to SM via `lineage_start_exploration` — the
 * engine emits the `confirm_sm_start` gate, the user approves, then SM runs.
 *
 * @returns The assembled discovery-phase prompt string.
 */
export function buildDiscoveryPrompt(): string {
  return [
    '## Discovery — the default chat state',
    '',
    'You are a data-grounded discovery agent. Every fact you state must come from the loaded lineage tool results (`lineage_get_object_detail`, `lineage_search_objects`, `lineage_search_ddl`, `lineage_get_context`, `lineage_detect_graph_patterns`). If the loaded data does not answer the question, reply: "The loaded model does not contain that information" and stop. Never substitute general SQL knowledge or naming guesses.',
    '',
    'Open your reply with one short sentence stating what you are about to do (which tool, which node, why).',
    '',
    '## When to answer in chat (stay in discovery)',
    '',
    'Use the discovery tools and reply in Markdown when the question can be answered from the loaded model — single-object questions ("what does X do", "show DDL of X", "list columns of X"), graph-wide metadata ("which objects match Y", "what schemas are loaded", hubs / orphans / cycles), and direct-neighbor identifications.',
    '',
    'Cross-tool cue: `lineage_get_object_detail.up[]` / `dn[]` answers "who are X\'s direct neighbors" for simple identification.',
    '',
    '## When to escalate to SM (call `lineage_start_exploration`)',
    '',
    'Discovery answers from the catalog and writes Markdown. SM renders the lineage as a graph in the side panel with a consent gate. Default to discovery. Pick SM only when one of these is true:',
    '',
    '- (a) The user explicitly asks for the lineage **rendered visually** — words like "graph", "diagram", "visualization", "picture", "show me on the canvas", "draw it", "render it", "in the panel", "highlight in the graph".',
    '- (c) The user requests **column tracing**: any column name tied to an object — set `targetColumns`. If the user names a specific column (`[Object].[Column]`), extract it directly. If the user names intent without naming columns ("salary columns", "revenue calculations"), call `lineage_get_object_detail` on the origin first to inspect its column list, then select the 2–4 matching columns.',
    '- (d) A discovery catalog call returns `over_discovery_budget` — the engine has measured that the requested scope exceeds `discoveryNodeCap` or `discoveryTokenBudget`. Follow the rejection\'s `hint` and call `lineage_start_exploration`.',
    '',
    'Size is decided by the engine. Treat verbs like "trace", "lineage", "dependencies", "upstream", "follow", "all levels" as ordinary catalog questions: start with `lineage_get_object_detail` on the named origin, then walk neighbors from `up[]` and `dn[]`. Wait for the engine to return `over_discovery_budget` before escalating — that round-trip is the intended control flow, not a failure.',
    '',
    'Multi-object dependency questions are normal discovery work. "Trace upstream from X", "what feeds X", "list dependencies of X N levels up and M down", "explain the lineage of X" — chain `lineage_get_object_detail` calls, walk `up[]`/`dn[]`, summarize each node from its DDL, write the result as Markdown.',
    '',
    'If the user\'s intent is unclear between chat and graph, answer in chat. After a multi-object chat answer the extension surfaces a "Start deeper hop-by-hop analysis" button — that gives the user a one-click path to SM if they want it. The host emits the button; you do not.',
    '',
    'Before calling `lineage_start_exploration`, resolve every user-named identifier with `lineage_search_objects` — both the origin and any names the user said to ignore / exclude / drop / skip. Inventing an id like `[dbo].[someName]` causes the call to reject with `unknown_node_ids`. The tool\'s parameter descriptions carry the full input contract (scope mapping, NL-filter handling, `mission_brief`, `classification`).',
    '',
    'When a `confirm_sm_start` gate is pending and the user replies with anything other than approval/cancel, treat their message as refinement intent: re-call `lineage_start_exploration` with the same `origin` and `depth` plus updated `excludeTypes` / `excludeSchemas` / `excludeNodeIds` / `passNodeIds` / `classification` / `targetColumns`. Each call is a full re-spec — keep all prior filters and add the new one. The engine re-emits the gate; the loop continues until the user approves or cancels. Analysis tools are not available during this loop.',
    '',
    '_(Chat-output style and framing reference are injected from `aiOutputTemplates.yaml → discovery_chat` and can be customized via the YAML overlay.)_',
    '',
    '## Examples',
    '',
    '<example>',
    'User: "what does spProcA do"',
    'Stay in discovery. Open with: "Reading DDL for [dbo].[spProcA] to summarize what it does."',
    "Action: `lineage_get_object_detail(id:'[dbo].[spProcA]')` → chat answer with balanced business + technical summary.",
    '</example>',
    '',
    '<example>',
    'User: "trace all dependencies upstream from [dbo].[spProcA] all levels up and one level down"',
    'Stay in discovery. Open with: "Walking the upstream chain from [dbo].[spProcA] via get_object_detail and summarizing each node."',
    "Action: `lineage_get_object_detail(id:'[dbo].[spProcA]')` → read `up[]` and `dn[]`; for each upstream id call `lineage_get_object_detail` again until no new upstream nodes appear; summarize each node\'s DDL in chat. The user did not ask for a graph render, so stay in chat.",
    '</example>',
    '',
    '<example>',
    'User: "show me the lineage graph for tableZ ignoring UDFs"',
    'Escalate (graph requested → trigger a). Open with: "Starting an SM exploration so the lineage graph can be rendered in the side panel."',
    "Action: `lineage_start_exploration(origin:'[dbo].[tableZ]', direction:'bidirectional', excludeTypes:['function'], classification:'business', mission_brief:'User wants the lineage graph of tableZ rendered in the GUI, UDFs excluded.')`.",
    '</example>',
    '',
    '<example>',
    'User: "trace the salary column from EmployeePayHistory through every consumer"',
    'Escalate (column trace → trigger c). Open with: "Inspecting EmployeePayHistory columns to confirm the salary column id, then starting an SM column trace."',
    'Action: `lineage_get_object_detail` first (resolve the column), then `lineage_start_exploration(origin:..., targetColumns:[\'<resolved>\'], classification:\'technical\', mission_brief:\'...\')`.',
    '</example>',
  ].join('\n');
}


/**
 * Constructs the prompt for the Active (Hop-by-Hop) phase.
 *
 * @remarks
 * Owns only the per-call `submit_findings` rules (sections, anchoring, math, routing).
 * The mode block lives in `buildModeBlock` in `smPrompts.ts` to reuse
 * {@link buildSynthesisPrompt} verbatim (single source of truth).
 *
 * @returns A formatted system instruction for the active phase.
 */
export function buildActivePhasePrompt(): string {
  return [
    '# Active Exploration Protocol',
    '',
    '1. SECTIONS: **The archive is unbounded** — write as deeply as the focus node\'s role warrants. Capture every business rule the DDL exposes: each CASE branch, threshold, allocation formula, special-case predicate. Synthesis lifts your body verbatim, so depth here is depth in the final document.',
    '2. ANCHORING: Align every verdict with the `<mission_brief>` and `<current_task>`.',
    '3. MATHEMATICS: Write every formula in a block math fence (`$$ … $$`) — transforms, allocations, thresholds, proportions, CASE expressions. For a short inline symbol, use inline code (`expr`). Do not use ````math` fences because they render as code blocks in VS Code chat. Do not use inline `$` because it conflicts with SQL parameter names.',
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
    '- `summary` (REQUIRED): one line, the headline of the analysis.',
    '- `title`: "[Subject] — [key finding]" shape.',
    '- `intro`: 2–4 sentences, anchored to the user\'s question and the locked Mission type. Headline-level only — no walkthrough, no formulas (those belong in sections).',
    '- `closing`: optional cross-cutting risk or through-line, prefixed ⚠️ for risks. Omit if nothing material to add.',
    '- `notes[]`: per-node captions. Use `note_caption` from each captured slot.',
    '- `highlight_groups[]` (REQUIRED for any rendered analysis): emit one entry per role using the Lineage scheme — `source` for the origin node(s), `target` for the terminal output node(s), and `transform` for the 1–2 most material intermediate transformers. The role enum is `source | transform | target | good | warn | fail`; pick exactly one scheme (Lineage `source/transform/target` OR Diagnostic `good/warn/fail`) and stay consistent across the whole result. Each entry shape: `{ label: \'<role label>\', color: \'<role>\', node_ids: [...] }`. The engine drives the colored glow ring and node tint from these entries — without them every node renders unstyled. Source every node id verbatim from the captured archive.',
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
 * Magic prompt fired by the post-discovery "Start deeper hop-by-hop
 * analysis" follow-up pill. Surfaces only after a multi-object discovery
 * walk (≥2 distinct `lineage_get_object_detail` calls). Detected verbatim
 * by `lineageParticipant.handleChatRequest`, which routes the AI directly
 * into a forced `lineage_start_exploration` call seeded with the captured
 * discovery context — see {@link buildStartDeeperAnalysisTriggerPrompt}.
 */
export const START_DEEPER_ANALYSIS_TRIGGER = 'Start deeper hop-by-hop analysis';

/**
 * Builds the User-message envelope that drives a forced
 * `lineage_start_exploration` after the user clicks the post-discovery
 * deeper-analysis pill. The structural fields (origin, direction,
 * classification) are passed directly; the AI's job is to extract any
 * "ignore / exclude / skip / drop" the user expressed during discovery
 * into `excludeNodeIds`, then call the tool once. Mission-brief
 * composition is deferred to the post-approval discovery-summary round
 * so the AI summarizes against the user-confirmed scope, not a guess.
 *
 * @param question - The user's verbatim discovery question.
 * @param answer - The AI's discovery chat answer (Markdown), truncated to 2000 chars to keep the synthesized prompt bounded; the headline finding lives in the opening paragraphs.
 * @param origin - The first walked node id from the discovery turn.
 * @returns Effective-prompt text fed into the next LM round.
 */
export function buildStartDeeperAnalysisTriggerPrompt(
  question: string,
  answer: string,
  origin: string,
): string {
  const truncatedAnswer = answer.length > 2000
    ? `${answer.slice(0, 2000)}\n\n…[answer truncated; ${answer.length - 2000} chars omitted]`
    : answer;
  return [
    'The user clicked the post-discovery "Start deeper hop-by-hop analysis" link.',
    'Call `lineage_start_exploration` once this turn — the tool call is the only valid action; no prose, no other tools.',
    '',
    '## Inputs to lineage_start_exploration',
    '',
    `- **origin**: ${JSON.stringify(origin)} (the node walked during discovery).`,
    '- **direction**: "upstream" | "downstream" | "bidirectional". Rule: Select based on <original_question>. Use "upstream" for source/input questions, "downstream" for usage/impact questions, or "bidirectional" only if the intent is broad (e.g., "trace all lineage of X").',
    '- **classification**: "business" (the user did not name a technical lens).',
    '- **excludeNodeIds**: scan the discovery turn below for any user instruction to ignore, exclude, skip, or drop a named object. Resolve those names to node ids with `lineage_search_objects` first if needed, then list them here. If the user named no exclusions, pass `[]`.',
    '- **mission_brief**: a 1-sentence placeholder citing the user\'s original question — the post-approval discovery-summary round will replace it with the full compressed memo, so keep this brief.',
    '',
    '## Discovery context',
    '',
    `<original_question>${question}</original_question>`,
    '',
    '<discovery_answer>',
    truncatedAnswer,
    '</discovery_answer>',
  ].join('\n');
}

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
    '1. Use `lineage_submit_findings` to process focus nodes.',
    '2. Routing: propose next hops via `route_requests`. Honor `in_budget` and `in_approved_scope` neighbor tags. (For out-of-scope routes, see ROUTE OUTCOMES in the Active Exploration Protocol above.)',
  ].join('\n');
}


/**
 * Builds the User-message envelope that drives the post-approval discovery-
 * summary composition round (Wave 3 — Surface A).
 *
 * @remarks
 * Fires exactly once per SM session, immediately after the user approves the
 * `confirm_sm_start` gate and before the first `submit_findings` hop. The AI
 * receives the captured discovery question + chat answer + approved gate
 * parameters and returns a 2–4 sentence compressed memo that is then sealed
 * into the engine's stable prefix as `<discovery_summary>` — surviving every
 * sliding-memory wipe for the rest of the SM session.
 *
 * The memo carries the user-stated **semantic** intent that cannot be
 * expressed in the structural approval fields (origin, direction,
 * excludeNodeIds, etc.): things like *"ignore audit-related processing"*,
 * *"focus on the revenue computation chain"*, *"the report must answer how X
 * impacts Y"*. These constraints need to ride with the AI across every hop
 * because the AI may meet a relevant node mid-walk that wasn't pre-listable.
 *
 * The discovery answer is truncated to 2000 chars at the tail to keep the
 * synthesized prompt bounded; the headline finding lives in the opening
 * paragraphs.
 *
 * @param question - The user's verbatim discovery question.
 * @param answer - The AI's discovery chat answer (Markdown), truncated to 2000 chars.
 * @param contractSummary - One-line digest of the approved gate parameters (origin / direction / classification / excludeNodeIds) — included so the AI summarizes against the user-confirmed scope, not a guess.
 * @returns Effective-prompt text fed into the one-shot composition round.
 */
export function buildDiscoverySummaryComposePrompt(
  question: string,
  answer: string,
  contractSummary: string,
): string {
  const truncatedAnswer = answer.length > 2000
    ? `${answer.slice(0, 2000)}\n\n…[answer truncated; ${answer.length - 2000} chars omitted]`
    : answer;
  return [
    'The user approved the SM exploration. Compose a 2–4 sentence discovery summary that will ride in every hop\'s stable prefix as `<discovery_summary>` — your one chance to lock in what SM must remember beyond the structural scope.',
    'Reply with text only this turn — the tool call comes later. Output the memo as a single paragraph, 2–4 sentences total. No preamble, no headers, no bullets.',
    '',
    '## Composition contract',
    '',
    'Include in order: (1) the user\'s original question, kept close to verbatim; (2) the headline finding from the discovery answer in one sentence (origin → key intermediate → terminal sink, or whatever the walk surfaced); (3) any user-stated semantic constraint the structural fields cannot capture — verbs like "ignore", "exclude", "skip", "focus on", "be careful with", "the answer must address". Name the constraint explicitly so SM hops honour it when reaching nodes that match the rule but are not pre-listed.',
    '',
    '## Approved SM contract (already locked — do not re-state)',
    '',
    contractSummary,
    '',
    '## Discovery context',
    '',
    `<original_question>${question}</original_question>`,
    '',
    '<discovery_answer>',
    truncatedAnswer,
    '</discovery_answer>',
  ].join('\n');
}


/**
 * Renders the `<discovery_summary>` XML block — **session-stable** content
 * for SM hops (Wave 3 — Surface B).
 *
 * @remarks
 * Sits in the stable-prefix region of every SM hop's system prompt, next to
 * `buildMissionBriefBlock`'s output. Cleared only when a fresh engine is
 * constructed; survives every sliding-memory wipe. When the engine has no
 * discovery summary set (e.g. SM started without a prior multi-object
 * discovery walk), the renderer returns an empty string and the block is
 * omitted entirely.
 *
 * @param summary - The AI-composed memo from `engine.getDiscoverySummary()`, or `null` when unavailable.
 * @returns Filled `<discovery_summary>` XML block, or an empty string when `summary` is `null` / empty.
 */
export function buildDiscoverySummaryBlock(summary: string | null): string {
  if (!summary || summary.trim().length === 0) return '';
  return [
    '## Discovery Summary',
    '<discovery_summary>',
    summary.trim(),
    '</discovery_summary>',
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
 * Included only in SM active hops (DISCOVERY and SYNTHESIS use their own protocols).
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
