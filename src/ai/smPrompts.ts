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

import type { SmMode } from './smTypes';


const BLOCK = {
  /** Step 1 — every hop starts with DDL/column analysis. */
  readDdl:
    'Read the focus node DDL/columns carefully.',

  /** Node classification shared across all modes. */
  verdictCategories:
    'NODE CLASSIFICATION (three categories):\n' +
    '- analyze (BB) / trace (CT): node has ANY business logic, transforms, formulas, CASE/WHERE/JOIN, or computed columns → full analysis + badge_label. If a stored procedure modifies data, it is ALWAYS analyze-worthy — even if its connection to the mission is indirect.\n' +
    '- pass (= data passthrough, NOT "skip"): pure wire — data flows through with ZERO transformation. SELECT *, identity view, synonym. If the node has ANY logic, use analyze.\n' +
    '- prune (BB) / prune (CT): node is a utility function (logging, error handling, type conversion) or has zero data relationship to the mission → removed from graph.',

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
    'APPROVED SCOPE: `working_memory.approved_border` carries the schemas and depth cap locked at session start. Each neighbor is tagged `in_budget` and `in_approved_scope`. Prefer in-border routes. When a focus node references something out of the border that matters for the question, include it in `route_requests` with its sub-question — the engine defers it to a post-session review list so the user can approve scope extension as a single end-of-session decision. `working_memory.deferred_count` shows the running tally.\n' +
    'WORKING MEMORY SIGNALS: `depth_budget` is the user-declared depth; `depth_cap` is the engine ceiling (strict = budget, soft = budget+1, silent = budget+2, plus user-approved extensions). `verdict_counts` shows the running A/P/Pr tally — many analyze and zero prunes usually means genuine utility/helper nodes were missed (those take `prune`). `recent_rejections` lists the last five deferred or blocked routes already surfaced by the engine.',

  /** Verdict a neighbor — CT modes. */
  verdictNeighbors:
    'Verdict neighbors via `route_requests` (adds to agenda) or leave unchanged (engine skips). Cascade-prune happens when you verdict a focus node as prune.',

  /** Column tracking — CT only. */
  columnTracking:
    'COLUMN TRACKING: for each `route_requests` entry, `columns` must be the names AS THEY APPEAR in the neighbor, not the output alias in the current node.\n' +
    'Read the current node DDL to find the source column reference: `SELECT neighbor.SourceCol AS OutputAlias` → trace SourceCol into that neighbor.\n' +
    'Track renames across hops — each hop may use a different name for the same data.\n' +
    'SELECTIVITY: trace only columns pertinent to the question. When uncertain whether a column carries value to the target: trace. When a column only controls selection: omit.',

  /** Column lineage rule — CT column mode. */
  columnLineageRule:
    'COLUMN LINEAGE RULE: read the SELECT expression that produces the target column in the DDL. Trace every column reference in that expression — formula operands, COALESCE options, CASE WHEN result values (THEN/ELSE), JOIN value columns. Omit columns that appear only in row-selection clauses (WHERE conditions, JOIN ON keys, HAVING filters) — they route which row is chosen, not what the value is. Multi-input formulas: trace ALL inputs.',

  /** Table node guidance — CT modes. */
  tableNodes:
    'TABLE NODES: tables store data, not transform it. Two cases:\n' +
    '- PHYSICAL SOURCE (terminal): the traced column is a physical column on this table AND no in-DB upstream writer (INSERT/UPDATE/MERGE SP or view) populates it from other objects in scope → verdict = `analyze` (badge_label "Source"). Document the column definition (data type, nullable, constraints) in detail_analysis. This is the terminus of the chain — do not add route_requests.\n' +
    '- INTERMEDIATE TABLE: an in-DB stored procedure or ETL view loads the traced column into this table → verdict = `pass`, and ALWAYS add the writer SP/view to route_requests with the column name as it appears in the writer\'s source. Do not stop here — the chain continues through the writer.',

  /** Loop contract — applies to every mode. */
  completionContract:
    'The engine drives the loop. Every hop, call `submit_findings` for the presented focus node with `verdict: analyze | pass | prune`. The engine stops presenting when the agenda drains — you shape the agenda: `verdict: "prune"` cascade-prunes the node and its unvisited descendants. Route only neighbors the main user question needs.\n' +
    'Utility / logging / helper nodes (generic math helpers, log writers, identity UDFs) take `verdict: "prune"` — removes the subtree quickly.',
} as const;


/**
 * Builds the mode-scoped navigation prompt delivered at the active-phase start.
 *
 * @remarks
 * Replaces the MemGPT-style "autonomous agent" framing with 0.9.8's task framing:
 * the engine presents nodes, the model analyzes them, the engine advances the agenda.
 *
 * @param mode - The exploration mode (`blackboard` or `column_trace`).
 * @returns A markdown string containing classification rules, per-hop workflow, and routing guidance.
 */
export function buildNavigationPrompt(mode: SmMode): string {
  if (mode === 'column_trace') {
    return [
      'COLUMN TRACE MODE: the state machine presents nodes one at a time. Analyze each node and trace specific columns across it.',
      '',
      BLOCK.completionContract,
      '',
      BLOCK.verdictCategories,
      '',
      'For each node:',
      `1. ${BLOCK.readDdl}`,
      `2. ${BLOCK.writeFindings}`,
      `3. ${BLOCK.badgeAndNote}`,
      `4. ${BLOCK.verdictNeighbors}`,
      '',
      BLOCK.columnTracking,
      BLOCK.columnLineageRule,
      BLOCK.tableNodes,
      BLOCK.selfAsk,
      BLOCK.routing,
    ].join('\n');
  }

  // blackboard (default)
  return [
    'EXPLORATION MODE: Sliding Memory (Isolated Node Analysis). The engine presents nodes one at a time. Use `working_memory.short_term_memory` (incremental loading) to ground your immediate reasoning. You do not have access to the global graph or the full BFS agenda.',
    '',
    BLOCK.completionContract,
    '',
    BLOCK.verdictCategories,
    '',
    'For each node:',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    '4. Add neighbors to `route_requests` with a specific sub-question when you want to investigate them. Cascade-prune happens when you verdict the focus node as `prune` — use it deliberately for helpers and utilities only.',
    '',
    BLOCK.selfAsk,
    BLOCK.routing,
  ].join('\n');
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
