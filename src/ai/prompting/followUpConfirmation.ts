/**
 * Completed/follow-up prompt helpers.
 *
 * Keep prompt text in `src/ai/prompting/*`; participant code should only decide
 * when to inject these blocks.
 */

export type FollowUpConfirmationPhase = 'discover' | 'exploring' | 'completed';

const AFFIRMATION_RE = /^(?:yes|yep|yeah|ok(?:ay)?|sure|do it|yes do it|please do|proceed|go ahead|apply it|make it so)[\s.!]*$/i;
const NODE_ID_RE = /`?(\[[^\]\r\n]+\]\.\[[^\]\r\n]+\])`?/g;

const ROLE_KEYWORDS = [
  'source',
  'transform',
  'target',
  'good',
  'warn',
  'fail',
] as const;

type HighlightRole = typeof ROLE_KEYWORDS[number];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function isShortAffirmation(prompt: string): boolean {
  return AFFIRMATION_RE.test(prompt.trim());
}

export function extractNodeIdsFromMarkdown(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(NODE_ID_RE)) {
    if (match[1]) ids.push(match[1]);
  }
  return unique(ids);
}

function inferHighlightRole(text: string): HighlightRole | null {
  const lower = text.toLowerCase();
  for (const role of ROLE_KEYWORDS) {
    if (lower.includes(`\`${role}\``) || lower.includes(`'${role}'`) || lower.includes(`"${role}"`)) return role;
    if (lower.includes(`${role} label`) || lower.includes(`label ${role}`)) return role;
  }
  return null;
}

function looksLikePresentationEdit(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('label') ||
    lower.includes('highlight') ||
    lower.includes('color') ||
    lower.includes('badge') ||
    lower.includes('note') ||
    lower.includes('graph')
  );
}

/**
 * Builds an instruction block that preserves a clarified graph-edit intent when
 * the user answers with only a short confirmation.
 */
export function buildConfirmedGraphPresentationEditInstruction(
  userPrompt: string,
  priorAssistantText: string,
  phase: FollowUpConfirmationPhase,
): string | null {
  if (!isShortAffirmation(userPrompt)) return null;
  if (!looksLikePresentationEdit(priorAssistantText)) return null;

  const role = inferHighlightRole(priorAssistantText);
  const nodeIds = extractNodeIdsFromMarkdown(priorAssistantText);
  if (!role || nodeIds.length === 0) return null;

  const availabilityLine = phase === 'exploring'
    ? '- Active agenda note: if only `lineage_submit_findings` is available now, finish the current focus and carry this edit into the first `lineage_present_result` call after the agenda drains.'
    : '- Route now with `lineage_present_result`; do not call `lineage_start_exploration` for this presentation-only edit.';

  return [
    '## Confirmed Follow-Up Graph Edit',
    'The user confirmed the previous presentation-only graph edit. Apply that same resolved intent; do not reinterpret the short confirmation as a new trace.',
    `- confirmed role: ${role}`,
    `- confirmed node_ids: ${nodeIds.join(', ')}`,
    availabilityLine,
    `- Use \`is_update:true\`; include these ids in \`add_node_ids\` if they are not already visible, and set \`highlight_groups\` with \`color:"${role}"\` for these ids.`,
    '- Keep existing report text and section grouping unless the tool requires a corrected `sections[]` payload for validation.',
  ].join('\n');
}
