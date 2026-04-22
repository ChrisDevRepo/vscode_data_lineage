/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Framing matches the VS Code chat-participant convention: the state machine is a tool the
 * model calls; the model is a domain responder, not a persistent agent. Keep the prompts
 * focused on the task (analyze the focus node, write the archive, route neighbors) — the
 * engine handles completion, cascade-prune, and memory delivery.
 */

import { buildColumnAspectPrompt } from './prompts';


const BLOCK = {
  /** Step 1 — every hop starts with DDL/column analysis. */
  readDdl:
    'Read the focus node DDL/columns carefully.',

  /** Node classification shared across all modes. */
  verdictCategories:
    'NODE CLASSIFICATION (three categories):\n' +
    '- analyze: node has ANY business logic, transforms, formulas, CASE/WHERE/JOIN, or computed columns → full analysis + badge_label. If a stored procedure modifies data, it is ALWAYS analyze-worthy — even if its connection to the mission is indirect.\n' +
    '- pass (= data passthrough, NOT "skip"): pure wire — data flows through with ZERO transformation. SELECT *, identity view, synonym. If the node has ANY logic, use analyze.\n' +
    '- prune: node is a utility function (logging, error handling, type conversion) or has zero data relationship to the mission → removed from graph.',

  /** Step 2 — write the detail archive. Engine invariants only; CAPTURE rules live in YAML. */
  writeFindings:
    'Write `detail_analysis` for the focus node.\n' +
    'CRITICAL invariants (non-negotiable):\n' +
    '  • The archive is the SOLE evidence at synthesis. It is UNBOUNDED.\n' +
    '  • NO NEW FACTS at synthesis — if you don\'t capture it here, it is gone.\n' +
    '  • `mission_brief` (delivered every hop) anchors every relevance decision.\n' +
    'Aim ≥ 800 chars per analyzed node; a thin slot produces a thin synthesis. Self-contained — written to answer the user\'s question.\n' +
    'The Capture rules above (Business angle / Technical angle) list what to capture per node. When both angles apply, capture both.\n' +
    'Also write a specific one-line `summary`. Specific > short.\n' +
    '- pass → `summary` only: what passes through, from where to where.\n' +
    '- prune → brief `summary` only.',

  /** Badge + note metadata drive the graph UI. */
  badgeAndNote:
    'badge_label (2-4 words, ≤30 chars): semantic ROLE label, e.g. "Source", "Transform", "Staging", "Output", "Validation", "Aggregation". Pick labels that capture the node\'s role in the pipeline — each distinct stage gets a distinct label.\n' +
    'SELECTIVITY: Only assign badge_label to nodes with distinct functional roles. Passthrough nodes (SELECT *, simple staging, lookup joins) — skip badge_label, they will be mentioned in section text.\n' +
    'GROUPING: Nodes that serve the same role should get the same badge_label (e.g. two source tables → both "Source").\n' +
    'note_caption (≤200 chars): cross-hop REASONING — what this hop taught you that future hops need. `summary` already captures WHAT the node does; do not restate it. Use note_caption for the delta or for still-open questions.',

  /** Self-ask — the sub-question is a lens; the mission brief (or user question) is the anchor. */
  selfAsk:
    'The `current_task` field narrows this hop\'s attention. Anchor every verdict and every detail slot on the `mission_brief` (AI-authored at session start, delivered every hop) — or `working_memory.user_question` if no brief is set. Relevance is judged against the mission, not the sub-question. If the mission names NL filters (e.g. "ignore UDFs and views", "only tables in schema X"), honor them: verdict any neighbor that violates the filter as `prune`, don\'t analyze it, don\'t expand the agenda into it — but if it is a meaningful dependency for the mission, list it in `route_requests` with a sub-question so the engine defers it as a user follow-up. If answering the sub-question produces material that does not serve the mission, omit it.',

  /** Route grounding — shared. */
  routing:
    'ROUTING: every entry in `route_requests` carries a focused sub-question — anything from a single yes/no ("Does this procedure apply the rule the parent referenced?") to a multi-part investigation ("Which columns X, Y, Z flow through this procedure, how are they transformed, and what conditions filter them?"). Frame the sub-question at the depth the next hop needs to make progress — do not truncate a multi-part investigation into a thin single question. Read neighbor metadata and justify each choice; blind routing is a reasoning failure.\n' +
    'AGENDA SHAPING: You control the engine\'s BFS agenda. Use `route_requests` to auto-add required neighbors. Use `prune_neighbors` (array of node IDs) to aggressively eliminate irrelevant neighbors discovered while reading a View or Procedure\'s SQL. Pruning a node automatically cascade-prunes its unvisited descendants, saving tokens and hops.\n' +
    'APPROVED SCOPE: `working_memory.approved_border` carries the schemas and depth cap locked at session start. Each neighbor is tagged `in_budget` and `in_approved_scope`. Prefer in-border routes. When a focus node references something out of the border that matters for the question, include it in `route_requests` with its sub-question — the engine defers it to a post-session review list so the user can approve scope extension as a single end-of-session decision. `working_memory.deferred_count` shows the running tally.\n' +
    'WORKING MEMORY SIGNALS: `depth_budget` is the user-declared depth; `depth_cap` is the engine ceiling (strict = budget, soft = budget+1, silent = budget+2, plus user-approved extensions). `verdict_counts` shows the running A/P/Pr tally — many analyze and zero prunes usually means genuine utility/helper nodes were missed (those take `prune`). `recent_rejections` lists the last five deferred or blocked routes already surfaced by the engine.',

  /** Verdict a neighbor — CT modes. */
  verdictNeighbors:
    'Verdict neighbors via `route_requests` (adds to agenda), `prune_neighbors` (removes from agenda), or leave unchanged (engine skips). Cascade-prune happens when you verdict a focus node as prune or explicitly list it in `prune_neighbors`.',

  /** Loop contract — applies to every mode. */
  completionContract:
    'The engine drives the loop. Every hop, call `submit_findings` for the presented focus node with `verdict: analyze | pass | prune`. The engine stops presenting when the agenda drains — you shape the agenda: `verdict: "prune"` cascade-prunes the node and its unvisited descendants. Route only neighbors the main user question needs.\n' +
    'Utility / logging / helper nodes (generic math helpers, log writers, identity UDFs) take `verdict: "prune"` — removes the subtree quickly.',

  /** Batch contract for True Inline mode. */
  batchCompletionContract:
    'You have received the entire graph context at once. Call `submit_findings` with an ARRAY of findings for all presented nodes in a single turn. For each node, provide its verdict and analysis. You can also request new routes (expansions) in the same turn. The engine will process the entire batch and either finalize the exploration or pause if a user-confirmation gate is triggered.',
} as const;


/**
 * Builds the navigation prompt delivered at the active-phase start.
 *
 * @remarks
 * The engine presents nodes, the model analyzes them, the engine advances the agenda.
 * If `targetColumns` are provided, the Column Aspect instructions are appended.
 *
 * @param isInline - Whether the engine is delivering the entire graph context at once.
 * @param targetColumns - Optional columns being tracked (activates Column Aspect).
 * @returns A markdown string containing classification rules, per-hop workflow, and routing guidance.
 */
export function buildNavigationPrompt(isInline: boolean = false, targetColumns?: string[]): string {
  const isColumnAspectActive = !!(targetColumns && targetColumns.length > 0);
  const sections: string[] = [];

  if (isInline) {
    sections.push(
      'EXPLORATION MODE: True Inline (Full Graph provided). Analyze the entire scope in a single batch. You have access to all nodes and their DDL upfront.',
      '',
      BLOCK.batchCompletionContract
    );
  } else {
    sections.push(
      'EXPLORATION MODE: Sliding Memory (Isolated Node Analysis). The engine presents nodes one at a time. Use `working_memory.short_term_memory` (incremental loading) to ground your immediate reasoning.',
      '',
      BLOCK.completionContract
    );
  }

  sections.push(
    '',
    BLOCK.verdictCategories,
    '',
    'For each node:',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    '4. Add neighbors to `route_requests` with a specific sub-question when you want to investigate them.',
    '',
    BLOCK.selfAsk,
    BLOCK.routing
  );

  if (isColumnAspectActive) {
    sections.push('', buildColumnAspectPrompt(targetColumns!));
  }

  return sections.join('\n');
}


import { CLASSIFICATION_LABEL, type ClassificationValue } from './classification';

/**
 * Builds the synthesis reminder appended as the last key of the completion tool_result JSON.
 *
 * @remarks
 * Main's 0.9.8 pattern: instructions at end of context improve compliance ~30% (Anthropic
 * long-context guidance). The reminder re-asserts depth and grounding at the highest-attention
 * slot — the last key of the JSON that carries the archive + skeleton. Pairs with the
 * completion envelope preservation in `lineageParticipant.ts` / `toolProvider.ts`.
 *
 * When `classification` is `technical` or `both`, the Technical-subsection
 * instruction is appended as an extra bullet so the AI emits a `#### Technical`
 * block per section.
 *
 * @param question - The user's original question, used to re-anchor synthesis on intent.
 * @param classification - Resolved mission type; drives technical-subsection emission.
 * @param technicalSubsectionInstruction - Full YAML `technical_subsection.instruction` text.
 * Required when classification is `technical` or `both`; ignored when `business`.
 * @returns A short reminder string injected as `synthesis_reminder` in the completion result.
 */
export function buildSynthesisReminder(
  question: string,
  classification?: ClassificationValue,
  technicalSubsectionInstruction?: string,
): string {
  const lines = [
    'SYNTHESIS REMINDER — re-read before generating present_result:',
    `- User question: "${question}"`,
    '- Your detail slots are draft section text — assemble into present_result sections.',
    '- Every badged node: 3+ sentences with business meaning + SQL evidence.',
    '- Present at full depth — do not compress or re-summarize.',
    '- Deferred questions (out-of-approved-scope routes) surface as a "Detailed explanation" chip beneath the chat — focus your writing on the analyzed nodes only; do not list deferred questions in present_result or chat prose.',
    '- Before writing present_result: scan each slot. If any reads like a technical listing (column types, raw SQL) instead of business narrative, call get_object_detail to re-read its DDL.',
  ];

  if ((classification === 'technical' || classification === 'both') && technicalSubsectionInstruction?.trim()) {
    lines.push(
      `- When you render each section, also include a \"#### Technical\" subsection with: ${technicalSubsectionInstruction.trim()}`,
    );
  }

  return lines.join('\n');
}
