/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Following a hybrid Markdown + XML strategy: Markdown headers provide structural context
 * for GPT/Gemini, while XML tags protect high-risk dynamic data for Claude precision.
 */

import { buildColumnAspectPrompt, buildSynthesisPrompt } from './prompts';
import type { ColumnEdge } from './smTypes';


const BLOCK = {
  /** Node classification protocol. */
  verdictCategories: [
    '## Verdict Protocol',
    '- analyze: Node has logic/formulas relevant to the mission. Use for stored procedures writing mission-critical data.',
    '- pass: Node is pure wire (SELECT *, synonym). No transformation. (Use analyze if ANY logic exists.)',
    '- prune: Utility node (logging/error), or downstream consumer that is topologically adjacent but does not contribute to the stated question.',
    '- prune_neighbors: When the DDL of the current focus node reveals adjacent tables that are filter-only (used in a JOIN ON or IN subquery, with no columns selected from them that contribute to the mission), add those table ids to `prune_neighbors` in the same submit_findings. Example: a calendar table joined only to filter by fiscal year; a region lookup joined only to restrict which rows are imported.',
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
      'Body content is governed by the capture template above; this block specifies only the submission shape.',
      '`summary` — one short sentence digest of the whole node.',
    ].join('\n');
  },

  /** Metadata protocol — badge_label drives final-document section labels. */
  badgeAndNote: [
    '## Metadata Protocol',
    '1. BADGE: `badge_label` is a short semantic ROLE label — prefer 1-2 words; longer phrases acceptable only when no shorter form fits the role precisely. Use ROLE words: "Source", "Transform", "Staging", "Output", "Validation", "Aggregation", "Revenue Calc", "Price Adjustment", "Territory Load".',
    '   - SELECTIVITY: Skip `badge_label` for passthrough nodes (SELECT *, simple staging, lookup joins). They are mentioned in section text without their own badge.',
    '   - SHARED ROLE: Nodes serving the same role take the same label. Five discount procedures all use `"Price Adjustment"`; three territory loaders all use `"Territory Load"`. The differing detail belongs in the section body, not the label.',
    '   ❌ Step-count labels ("Step 1", "Step A", "Transform Step") — sections are auto-numbered; role labels only.',
    '2. NOTE: `note_caption` (≤200 chars) — cross-hop REASONING delta. `summary` captures WHAT the node does; `note_caption` carries the new insight or open question for future hops.',
  ].join('\n'),

  /** Strategic routing protocol — full text for inline mode (AI drives the agenda one-shot). */
  routingInline: [
    '## Routing Strategy',
    '1. AUTO-ADD: Route neighbors only if critical to the <mission_brief>. Respect user depth and schema boundaries.',
    '2. AUTO-PRUNE: Use `prune_neighbors` to eliminate irrelevant table/view/function branches (logging, demographics) found in DDL. See Pruning Protocol below for procedures.',
    '3. ANCHORING: Relevance is judged against the mission, not the sub-question.',
    '4. OUT-OF-SCOPE ROUTES: See ROUTE OUTCOMES in the Active Exploration Protocol above.',
  ].join('\n'),

  /** Trimmed routing line for SM — engine selects the next focus node; AI judges it against the mission brief. */
  routingSm: [
    '## Routing',
    'Engine selects the next focus node from the agenda. For each focus node: if its function falls outside the `<mission_brief>` — not only logging/error utilities, but any node that does not contribute to the user\'s stated question — emit `verdict: "prune"`. Only add a neighbor via `route_requests` if it directly contributes to answering the user\'s stated question — topological adjacency is not sufficient justification. A downstream consumer of a source table is not itself a source. Source the id verbatim from the tool result. Otherwise emit `route_requests: []`.',
  ].join('\n'),

  /**
   * Inline pruning protocol — full DDL is already in context; no tool call needed.
   *
   * @remarks
   * In True Inline mode the entire scope DDL is delivered upfront via the
   * `start_exploration` result. The AI reads DDL directly to assess relevance;
   * `lineage_get_neighbor_columns` is not in the inline_bb tool set.
   */
  pruningProtocolInline: [
    '## Pruning — When to Prune',
    'Prune nodes that do not contribute to the `<mission_brief>`.',
    '- **Structural neighbors**: Read the DDL and schema context already provided to assess relevance — full scope DDL is in the `start_exploration` result, no tool call needed.',
    '- **Procedures**: Read the procedure DDL in scope to verify its relevance before pruning.',
  ].join('\n'),

  /**
   * SM pruning protocol — lightweight metadata via `lineage_get_neighbor_columns`.
   *
   * @remarks
   * In Sliding Memory mode only the focus node's DDL is delivered per hop.
   * `lineage_get_neighbor_columns` is available (sm_bb / sm_ct tool sets) and
   * provides structural metadata for direct neighbors without requiring a full hop.
   * Procedures are the exception — their logic is only accessible at the hop.
   */
  pruningProtocolSm: [
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

  /**
   * Inline turn flow — the unified two-call sequence inside one agent loop.
   *
   * @remarks
   * Inline collapses Phase 2 (Active capture) and Phase 3 (Synthesis) into one
   * AI turn. The system prompt for inline ships every instruction the AI needs
   * for both calls upfront — no second-turn prompt swap. This block names the
   * sequence so the AI does not stop after `submit_findings`.
   */
  inlineTurnFlow: [
    '## Inline Turn Flow — one turn, two tool calls',
    'After the consent gate is approved, you receive every instruction needed for both Active capture and Synthesis in this one prompt. Execute them in sequence inside this single turn:',
    '1. **`lineage_submit_findings`** — one call, batched across all scope nodes (per the Inline Batch Protocol below).',
    '2. **`lineage_present_result`** — call immediately after `submit_findings` succeeds. The tool_result for `submit_findings` carries a `synthesis_reminder` cue with the user question; obey it. Do not wait for a new turn.',
    'Both tools are available in the active stage. The Synthesis Contract section near the end of this prompt governs the `present_result` payload shape.',
  ].join('\n'),
} as const;


/**
 * Builds the navigation prompt delivered at the active-phase start.
 *
 * @remarks
 * The engine presents nodes, the model analyzes them, the engine advances the agenda.
 * If `targetColumns` are provided, the Column Aspect instructions are appended.
 *
 * Inline mode bundles every instruction the AI needs for both Active capture
 * and Synthesis into one upfront brief: turn flow, batch protocol, verdicts,
 * sections, badges, routing, pruning, and the {@link buildSynthesisPrompt}
 * contract for the trailing `present_result` call. SM mode emits only the
 * per-hop scope; synthesis instructions ship at the synthesis-phase boundary
 * because the SM agenda drains across many hops.
 *
 * @param isInline - Whether the engine is delivering the entire graph context at once.
 * @param targetColumns - Optional columns being tracked (activates Column Aspect).
 * @param classification - Locked classification from gate-approval; renders the section-submission shape per locked angle.
 * @returns A formatted string containing classification rules, per-hop workflow, and routing guidance.
 */
export function buildModeBlock(
  isInline: boolean = false,
  targetColumns?: string[],
  classification: 'business' | 'technical' | 'both' = 'business',
): string {
  const isColumnAspectActive = !!(targetColumns && targetColumns.length > 0);
  const sections: string[] = [];

  const mode = isInline ? 'TRUE INLINE' : 'SLIDING MEMORY';
  sections.push(`# Exploration Mode: ${mode}`);

  if (isInline) {
    sections.push('', BLOCK.inlineTurnFlow, '', BLOCK.batchCompletionContract);
  }

  sections.push(
    '',
    BLOCK.verdictCategories,
    '',
    BLOCK.buildSectionsShape(classification),
    '',
    BLOCK.badgeAndNote,
    '',
    isInline ? BLOCK.routingInline : BLOCK.routingSm
  );

  // Inline has full DDL upfront — prune from context (pruningProtocolInline, no tool call).
  // SM uses get_neighbor_columns for lightweight metadata inspection (pruningProtocolSm).
  sections.push('', isInline ? BLOCK.pruningProtocolInline : BLOCK.pruningProtocolSm);

  if (isColumnAspectActive) {
    sections.push('', buildColumnAspectPrompt(targetColumns!));
  }

  // Inline bundles synthesis contract here to avoid a second-turn prompt swap; buildSynthesisPrompt() is the single source of truth.
  if (isInline) {
    sections.push('', '# Synthesis Contract — for the trailing `present_result` call', '', buildSynthesisPrompt());
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
    '- Carry every formula (math code fence from the captured body) and every ⚠️ risk callout into the assembled section unchanged. Math fences render in the result panel; prose does not.',
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
