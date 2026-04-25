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
    '4. OUT-OF-SCOPE ROUTES: See ROUTE OUTCOMES in the Active Exploration Protocol above.',
  ].join('\n'),

  /**
   * Two-kind pruning protocol: structural neighbors (direct inspection) vs. procedures (hop-based).
   *
   * @remarks
   * Structural neighbors (tables, views, functions) expose their column schema and foreign keys
   * through `lineage_get_neighbor_columns` without requiring a dedicated hop. Procedures
   * keep their logic within a DDL body that is only accessible when the node is in focus.
   */
  pruningProtocol: [
    '## Pruning — When to Prune',
    'Prune nodes that do not contribute to the `<mission_brief>`.',
    '- **Structural neighbors**: For tables, views, or functions, call `lineage_get_neighbor_columns({ids:["..."]})` to inspect the schema and foreign keys before deciding to prune. This tool provides metadata for direct neighbors of the focus node.',
    '- **Procedures**: Since DDL is only visible at the hop, route to the procedure with a specific question (e.g., `question="Prune candidate — [reason]"`) to verify its relevance before pruning.',
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


/**
 * Builds the synthesis reminder appended as the last key of the completion tool_result JSON.
 *
 * @remarks
 * One-line cue at the highest-attention slot (Anthropic long-context guidance).
 * The user question, archive, and synthesis output templates are all already in
 * the envelope — this reminder reasserts only the gestalt rule.
 */
export function buildSynthesisReminder(): string {
  return '## Synthesis Reminder — Lift slots, assemble + group, anchor intro + closing.';
}
