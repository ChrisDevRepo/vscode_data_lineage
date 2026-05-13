/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Following a hybrid Markdown + XML strategy: Markdown headers provide structural context
 * for GPT/Gemini, while XML tags protect high-risk dynamic data for Claude precision.
 */

import { buildColumnAspectPrompt } from '../prompting/prompts';
import type { ColumnEdge } from '../sm/smTypes';


const BLOCK = {
  /** Node classification protocol. */
  verdictCategories: [
    '## Verdict Protocol',
    '- analyze: Node has logic/formulas relevant to the mission. Use for stored procedures writing mission-critical data.',
    '- pass: Node is pure wire (SELECT *, synonym). No transformation. (Use analyze if ANY logic exists.)',
    '- prune: Utility node (logging/error), or downstream consumer that is topologically adjacent but does not contribute to the stated question.',
    '- prune_neighbors: When the DDL of the current focus node reveals adjacent tables that are filter-only (used in a JOIN ON or IN subquery, with no columns selected from them that contribute to the mission), add those table ids to `prune_neighbors` in the same submit_findings. Example: a calendar table joined only to filter by fiscal year; a region lookup joined only to restrict which rows are imported.',
  ].join('\n'),
  verdictCategoriesCt: [
    '## Verdict Protocol',
    '- analyze: Node transforms or is the terminal source of a tracked column. Fill column_flow.',
    '- pass: Column flows through unchanged (SELECT *, rename, synonym). Fill column_flow naming the upstream contributor.',
  ].join('\n'),

  /**
   * Section-shape contract — points at the YAML capture templates as the
   * single source of truth for body content. The capture instructions are
   * injected separately by `templateRenderer.resolveStagePrompt(..., 'active', classification)`.
   *
   * Renders only the submission shape for the locked classification — no menu
   * of inactive branches. See {@link buildSectionsShape}.
   */
  buildSectionsShape: (classification: 'business' | 'technical' | 'both'): string => {
    const submitLine = classification === 'both'
      ? 'Submit `sections[]` with two entries: one `{ angle: "business", text: "<body>" }` and one `{ angle: "technical", text: "<body>" }`.'
      : `Submit \`sections[]\` with one entry: \`{ angle: "${classification}", text: "<body>" }\`.`;
    return [
      '## Section Submission',
      submitLine,
      'Canonical `sections[]` shape for active phase. If any nearby text conflicts, follow this block.',
      'Body content still comes from the capture template above.',
      '`summary` — one short sentence digest of the whole node.',
    ].join('\n');
  },

  /** Metadata protocol — active-hop helper metadata only. */
  badgeAndNote: [
    '## Current Hop Metadata',
    'Analyze the current `focus_node` for the current task only. Prior memory is context, not a final report plan.',
    '- `badge_label`: optional hop-time grouping hint only; it is not rendered directly. Use a short role phrase when it helps later synthesis, e.g. "Source", "Staging", "Revenue Calc", "Price Inputs".',
    '- `note_caption`: optional AI-authored node preview sentence. Use it when one sentence below this node would help users understand the current hop.',
  ].join('\n'),

  /** Canonical hop-local routing/pruning contract (single source, no duplicates across surfaces). */
  hopDecisionContract: [
    '## Neighbor Decision Contract (Current Hop Only)',
    'This contract is identical in SM BB and SM CT (CT only adds column tracking). Use mission/task metadata as source of truth; do not re-derive intent from history prose.',
    '- Actionable set this hop = current `focus_node` + current-hop `neighbors[]` from tool results.',
    '- History (`short_term_memory`, prior hop IDs, archived slots) is past context only — do not route/prune from it.',
    '- Emit explicit `verdict` for the focus node every hop.',
    '- Mandatory hop rule: each mission-relevant current-hop neighbor must be explicitly decided now.',
    '- For neighbors, make explicit decisions with current-hop IDs only:',
    '  - route mission-relevant neighbors via `route_requests` using concrete verification sub-questions.',
    '  - prune non-relevant neighbors via `prune_neighbors` when current-hop evidence proves out-of-scope.',
    '- Generic route prompts like "analyze this node" are invalid; each route question must name what to verify and what mission decision it resolves.',
    '- If a mission-relevant route is out of approved scope (schema/depth), still route it: engine defers it for post-synthesis follow-up.',
    '- Need structural evidence before pruning a neighbor? Call `lineage_get_neighbor_columns({ids:["..."]})` for current-hop direct neighbors.',
    '- Tool boundary in active phase: use only `lineage_submit_findings` and `lineage_get_neighbor_columns`.',
  ].join('\n'),
  hopDecisionContractCt: [
    '## Neighbor Decision Contract (Current Hop Only)',
    'CT is column-first: route only contributors needed to continue the active column chain.',
    '- Actionable set this hop = current `focus_node` + current-hop `neighbors[]` from tool results.',
    '- History (`short_term_memory`, prior hop IDs, archived slots) is past context only — do not route from it.',
    '- Emit explicit `verdict` for the focus node every hop (`analyze` or `pass`).',
    '- For neighbors in CT, make decisions with current-hop IDs only:',
    '  - route mission-relevant contributors via `route_requests` using concrete verification sub-questions.',
    '- Generic route prompts like "analyze this node" are invalid; each route question must name what to verify and what mission decision it resolves.',
    '- If a mission-relevant route is out of approved scope (schema/depth), still route it: engine defers it for post-synthesis follow-up.',
    '- Need structural evidence before routing a neighbor? Call `lineage_get_neighbor_columns({ids:["..."]})` for current-hop direct neighbors.',
    '- Tool boundary in active phase: use only `lineage_submit_findings` and `lineage_get_neighbor_columns`.',
  ].join('\n'),
} as const;


/**
 * Builds the navigation prompt delivered at the active-phase start.
 *
 * @remarks
 * The engine presents one focus node per hop, the model analyzes it, the engine
 * advances the agenda. If `targetColumns` are provided, the Column Aspect
 * instructions are appended. Synthesis instructions ship at the synthesis-phase
 * boundary because the agenda drains across many hops.
 *
 * @param targetColumns - Optional columns being tracked (activates Column Aspect).
 * @param classification - Locked classification from gate-approval; renders the section-submission shape per locked angle.
 * @returns A formatted string containing classification rules, per-hop workflow, and routing guidance.
 */
export function buildModeBlock(
  targetColumns?: string[],
  classification: 'business' | 'technical' | 'both' = 'business',
): string {
  return buildSmProtocol({ targetColumns, classification });
}

/**
 * Builds the static active-phase SM protocol block.
 *
 * @remarks
 * This is the canonical SM-mode protocol builder used by active-phase prompt
 * composition. It consolidates verdict/category guidance, section-shape
 * submission, routing/pruning, and optional CT anchor text.
 */
export function buildSmProtocol({
  targetColumns,
  classification = 'business',
}: {
  targetColumns?: string[];
  classification?: 'business' | 'technical' | 'both';
}): string {
  const isColumnAspectActive = !!(targetColumns && targetColumns.length > 0);
  const sections: string[] = [];

  sections.push('# Exploration Mode: SLIDING MEMORY');
  sections.push(
    '',
    isColumnAspectActive ? BLOCK.verdictCategoriesCt : BLOCK.verdictCategories,
    '',
    BLOCK.buildSectionsShape(classification),
    '',
    BLOCK.badgeAndNote,
    '',
    isColumnAspectActive ? BLOCK.hopDecisionContractCt : BLOCK.hopDecisionContract,
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
 * Anchored on the user question at the highest-attention slot (Anthropic long-context
 * guidance). Re-asserts depth, formula carry-through, and per-node SQL-evidence
 * requirements that the model otherwise drops under pressure.
 *
 * @param question - The user's original question, re-injected to anchor synthesis on intent.
 */
export function buildSynthesisReminder(question: string): string {
  return [
    '## Synthesis Reminder — re-read before calling `lineage_present_result`',
    `- User question: "${question}"`,
    '- `sections[]` is REQUIRED — create final graph/detail links from the full archive. Write `text` for every section: if the question names specific identifiers, focus on detail that answers the question (formulas, column transformations, SQL predicates, data flows, join keys, source tables); if broad, draw from the full captured detail. You own the text — write it.',
    '- GROUP question-first: choose sections that best answer the question. `section.label` is final authority for report grouping/links; hop `badge_label` values are helper hints only. Keep business/technical split only when it improves clarity.',
    '- Link only nodes discussed in the section body and needed to answer the question. A node may be unlabeled; a node should appear in at most one final section; many nodes may share one section label.',
    '- Every linked node needs grounded evidence; choose business-first evidence in `business` mode, and add SQL-level evidence only when needed to clarify impact. In `technical`/`both`, include technical evidence as relevant.',
    '- Carry formulas and ⚠️ callouts only when they materially help answer the user question. Do not force formula/risk inclusion when no significant issue is present.',
    '- For specific questions: answer directly; depth follows from the question. For broad questions: draw from the full captured detail. In both cases write the text — do not leave sections[] without text.',
    '- Anchor the `intro` to the user question and the locked Mission type; one paragraph, no headings.',
  ].join('\n');
}


/**
 * Renders the accumulated column lineage chain as a synthesis context block.
 *
 * @remarks
 * Appended to the synthesis reminder when CT was active and edges were recorded.
 * Presents the directed graph in a flat edge list so the AI can structure
 * `present_result` around the actual traced path rather than free-form prose.
 * Adds CT-only synthesis guidance: column traces group by the final answer,
 * using recorded column-flow edges as primary evidence.
 * Nodes that were visited but produced no edges are listed as excluded branches.
 *
 * @param edges - Validated edges from `ColumnAspect.edges`.
 * @param ctPrunedNodeIds - Visited nodes that contributed no column edges.
 * @returns Formatted markdown block anchoring synthesis to the column chain.
 */
export function buildCtSynthesisBlock(edges: ColumnEdge[], ctPrunedNodeIds?: string[]): string {
  const lines = ['## Column Trace Chain'];
  if (edges.length === 0) {
    lines.push('No edges recorded — verify column_flow was submitted at each hop.');
    return lines.join('\n');
  }
  for (const e of edges) {
    lines.push(`  ${e.from_node}.${e.from_col} → ${e.to_node}.${e.to_col} (${e.role}, hop ${e.hop})`);
  }
  if (ctPrunedNodeIds && ctPrunedNodeIds.length > 0) {
    lines.push('');
    lines.push(`Excluded branches (no column edges): ${ctPrunedNodeIds.join(', ')}`);
    lines.push('- Do not include excluded branches in the column chain narrative or sections[].');
  }
  // Compute terminal sources: appear as from_node but never as to_node in any CT edge.
  const toNodes = new Set(edges.map(e => e.to_node));
  const terminalSources = [...new Set(edges.map(e => e.from_node))].filter(n => !toNodes.has(n));

  lines.push('');
  lines.push('Structure present_result using this CT chain:');
  lines.push('- summary: one sentence naming origin column → traced path → terminal source');
  lines.push('- intro: anchor to the column chain — name start node, key writers/transforms, terminal source');
  lines.push('- sections[]: group by the answer, not by every hop. Use short final labels and link only nodes discussed in section text.');
  lines.push('- Keep pass-through or tangential nodes compact unless they change the traced column.');
  lines.push(`- highlight_groups.source: terminal source nodes (appear as from_node but never as to_node): ${terminalSources.join(', ') || '(none)'}`);
  lines.push('  — terminal source = the deepest data origin in this trace; can be any type when base table is out of scope');
  lines.push('- highlight_groups.target: origin node only');
  lines.push('- highlight_groups.transform: all remaining chain nodes (writers, views, procedures between source and target)');
  return lines.join('\n');
}
