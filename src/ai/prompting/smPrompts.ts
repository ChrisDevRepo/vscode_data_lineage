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

  /** Metadata protocol — badge_label drives final-document section labels. */
  badgeAndNote: [
    '## Metadata Protocol',
    '1. BADGE: `badge_label` is a short semantic ROLE label — prefer 1-2 words; longer phrases acceptable only when no shorter form fits the role precisely. Use ROLE words: "Source", "Transform", "Staging", "Output", "Validation", "Aggregation", "Revenue Calc", "Price Adjustment", "Territory Load".',
    '   - SELECTIVITY: Skip `badge_label` for passthrough nodes (SELECT *, simple staging, lookup joins). They are mentioned in section text without their own badge.',
    '   - SHARED ROLE: Nodes with the same role use the same label (for example `"Price Adjustment"`). Keep differences in section body text, not label text.',
    '   ❌ Step-count labels ("Step 1", "Step A", "Transform Step") — sections are auto-numbered; role labels only.',
    '2. NOTE: `note_caption` — quick user-facing preview sentence for this node. Keep it short and plain-language; put deep reasoning in `sections[].text`.',
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
    '- `sections[]` is REQUIRED — select nodes that directly answer the user question; omit nodes orthogonal to it. Write `text` for every section: if the question names specific identifiers, focus on detail that answers the question (formulas, column transformations, SQL predicates, data flows, join keys, source tables); if broad, draw from the full captured detail. You own the text — write it.',
    '- GROUP along two orthogonal axes: (1) keep each captured slot\'s `angle` separate — a business section and a technical section remain individual entries; under `classification = both` this yields two parallel streams. (2) Within a single angle, nodes that share `badge_label` become one section (badge → `label`, every grouped node id → `node_ids[]`).',
    '- Every badged node deserves business meaning AND SQL evidence (predicate, formula, join key); a label without evidence is incomplete.',
    '- Carry every formula (block math fence `$$ … $$` from the captured body) and every ⚠️ risk callout into the assembled section unchanged. Math blocks render natively in the result panel; prose does not.',
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
 * Overrides the standard badge_label grouping — in CT mode sections[] group by
 * column chain role (origin / writers / terminal source) instead.
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
  lines.push('');
  lines.push('Structure present_result using this chain (CT override — use chain role, not badge_label, for grouping):');
  lines.push('- summary: one sentence naming origin column → traced path → terminal source');
  lines.push('- intro: anchor to the column chain — name start node, key writers/transforms, terminal source');
  lines.push('- sections[]: group by chain role: origin node | writer/transform nodes | terminal source node');
  lines.push('- highlight_groups: source=terminal nodes, target=origin, transform=writer nodes');
  return lines.join('\n');
}

