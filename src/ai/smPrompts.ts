/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Following a hybrid Markdown + XML strategy: Markdown headers provide structural context
 * for GPT/Gemini, while XML tags protect high-risk dynamic data for Claude precision.
 */

import { buildColumnAspectPrompt } from './prompts';


const BLOCK = {
  /** Node classification protocol. */
  verdictCategories: [
    '## Verdict Protocol',
    '- analyze: Node has logic/formulas relevant to the mission. Use for stored procedures writing mission-critical data.',
    '- pass: Node is pure wire (SELECT *, synonym). No transformation. (Use analyze if ANY logic exists.)',
    '- prune: Utility node (logging/error) or irrelevant to the mission.',
  ].join('\n'),

  /** Analysis and archive protocol. */
  writeFindings: [
    '## Analysis Protocol',
    '',
    '**Grounding rule:** Use only object IDs, columns, and relationships returned by tool calls. Never infer, construct, or invent identifiers.',
    '',
    'For every node with verdict=`analyze`, structure `detail_analysis` with these sections (headings required):',
    '',
    '### Purpose',
    'One sentence naming the node\'s specific role — not "stores data" but "computes revenue at INSERT" or "historizes price changes into SCD rows".',
    '',
    '### Columns / logic',
    '- Column mappings: use a markdown table | from | to | rule | example |',
    '- Transform logic: numbered 1./2./3. steps, each with the SQL expression that drives it',
    '- Quote key SQL expressions in ```sql code fences (the expression, not the full statement)',
    '',
    '### Data risks / invariants',
    '1–2 sentences on anything that would surprise a reader — nullability traps, implicit coercions, ordering assumptions, idempotency concerns.',
    '',
    '`summary` — one line, ~100–300 chars, plain prose digest of Purpose.',
  ].join('\n'),

  /** Metadata protocol. */
  badgeAndNote: [
    '## Metadata Protocol',
    '1. BADGE: Assign `badge_label` (2-4 words) for functional roles (Source, Transform, Staging).',
    '2. NOTE: Write `note_caption` (≤200 chars) for cross-hop delta/reasoning.',
  ].join('\n'),

  /** Strategic routing protocol. */
  routing: [
    '## Routing Strategy',
    '1. AUTO-ADD: Route neighbors only if critical to the <mission_brief>. Respect user depth and schema boundaries.',
    '2. AUTO-PRUNE: Use `prune_neighbors` to eliminate irrelevant table/view/function branches (logging, demographics) found in DDL. See Pruning Protocol below for procedures.',
    '3. ANCHORING: Relevance is judged against the mission, not the sub-question.',
    '4. OUT-OF-SCOPE ROUTES: Routing mission-relevant neighbors outside the approved schemas or depth cap is encouraged. They are deferred and surfaced as post-synthesis follow-up offers. Check `route_outcomes[]` in each tool result to confirm which routes were accepted vs deferred.',
  ].join('\n'),

  /**
   * Two-kind pruning protocol: structural objects (column-check first) vs. procedures (route first).
   *
   * @remarks
   * Structural objects expose columns without a hop visit — `lineage_get_neighbor_columns` returns
   * `columns:[{n,t,...}]` for one or many neighbors in a single call, with no DDL. Procedures hide
   * all logic behind DDL that only arrives at hop time, so pre-pruning them is always premature.
   */
  pruningProtocol: [
    '## Pruning — When to Prune',
    'Prune irrelevant nodes. Relevance is judged against the `<mission_brief>`.',
    '- **table / view / function**: if columns are not explicit in the focus DDL, call `lineage_get_neighbor_columns({ids:["[dbo].[FactSales]"]})` first. Response includes `columns:[{n:"SalesAmount",...}]` and any foreign keys. Ids must be direct neighbors of the current focus.',
    '- **procedure**: columns are only visible at the hop. Route with `question="Prune candidate — [reason]"` to decide after reading the DDL.',
  ].join('\n'),

  /** Inline batch protocol. */
  batchCompletionContract: [
    '## Inline Batch Protocol',
    'Analyze the provided graph context holistically.',
    '1. BATCH SUBMISSION: Submit your findings as a JSON ARRAY of finding objects (one per node) in a single `submit_findings` turn.',
    '2. COMPLETION: If no further expansions (`route_requests`) are needed, set `"complete": true` inside your final finding object to finish the exploration.',
  ].join('\n'),
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
 * @returns A formatted string containing classification rules, per-hop workflow, and routing guidance.
 */
export function buildModeBlock(isInline: boolean = false, targetColumns?: string[]): string {
  const isColumnAspectActive = !!(targetColumns && targetColumns.length > 0);
  const sections: string[] = [];

  const mode = isInline ? 'TRUE INLINE' : 'SLIDING MEMORY';
  sections.push(`# Exploration Mode: ${mode}`);

  if (isInline) {
    sections.push('', BLOCK.batchCompletionContract);
  }

  sections.push(
    '',
    BLOCK.verdictCategories,
    '',
    BLOCK.writeFindings,
    BLOCK.badgeAndNote,
    '',
    BLOCK.routing,
    '',
    BLOCK.pruningProtocol
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
 * Follows Anthropic long-context guidance: instructions at the highest-attention slot
 * improve compliance.
 */
export function buildSynthesisReminder(
  question: string,
  classification?: ClassificationValue,
  technicalSubsectionInstruction?: string,
): string {
  const lines = [
    '## Synthesis Reminder',
    `- Question: "${question}"`,
    '- Target: High-fidelity `present_result` sections.',
    '- Requirement: 3+ sentences per badged node with SQL evidence.',
    '- Fallback: Cite missing nodes in chat prose, do not omit analyzed evidence.',
  ];

  if ((classification === 'technical' || classification === 'both') && technicalSubsectionInstruction?.trim()) {
    lines.push(
      `### Technical Instruction\n${technicalSubsectionInstruction.trim()}`,
    );
  }

  return lines.join('\n');
}
