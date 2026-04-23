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
    '- pass: Node is pure wire (SELECT *, synonym). No transformation. (Note: Use analyze if ANY logic exists).',
    '- prune: Utility node (logging/error) OR irrelevant to the mission. (Note: Missing target columns in Column Trace forces a prune).',
  ].join('\n'),

  /** Analysis and archive protocol. */
  writeFindings: [
    '## Analysis Protocol',
    '1. READ: Inspect focus node DDL/columns.',
    '2. CAPTURE: Write thorough `detail_analysis` (≥ 800 chars). Use business and technical angles.',
    '3. GROUNDING: Base findings only on provided DDL. No guessing.',
    '4. SUMMARIZE: Provide a concise one-line `summary`.',
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
  ].join('\n'),

  /**
   * Two-kind pruning protocol: structural objects (column-check first) vs. procedures (route first).
   *
   * @remarks
   * Structural objects expose columns without a hop visit — `lineage_get_object_detail` returns
   * `columns:[{n,t,...}]` immediately. Procedures hide all logic behind DDL that only arrives at
   * hop time, so pre-pruning them is always premature.
   */
  pruningProtocol: [
    '## Pruning — When to Prune',
    'Prune irrelevant nodes. Relevance is judged against the `<mission_brief>`.',
    '- **table / view / function**: if columns are not explicit in the focus DDL, call `lineage_get_object_detail({id:"dbo.FactSales"})` first. Response includes `columns:[{n:"SalesAmount",...}]`.',
    '- **procedure**: columns are only visible at the hop. Route with `question="Prune candidate — [reason]"` to decide after reading the DDL.',
  ].join('\n'),

  /** Inline batch protocol. */
  batchCompletionContract: 
    'Analyze the provided graph context holistically. Submit findings for all nodes in a single turn. You may request expansions (route_requests) in the same Turn.',
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
