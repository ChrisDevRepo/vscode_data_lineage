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

  /**
   * Section-shape contract — points at the YAML capture templates as the
   * single source of truth for body content. The capture instructions are
   * injected separately by `templateRenderer.resolveStagePrompt(..., 'active', classification)`.
   */
  sectionsShape: [
    '## Section Submission',
    'Submit `sections[]` with one entry per fired `*_capture` template (see "Capture rules" injected above):',
    '- `business` classification → 1 entry with `angle: "business"`',
    '- `technical` classification → 1 entry with `angle: "technical"`',
    '- `both` classification → 2 entries (one of each angle)',
    'Each entry: `{ angle, text }`. Body content is governed by the angle\'s capture template above; this block only specifies the submission shape.',
    '`summary` — one line, ~100–300 chars, plain-prose digest of the whole node (across all captured angles).',
  ].join('\n'),

  /** Metadata protocol — badge_label drives final-document section labels. */
  badgeAndNote: [
    '## Metadata Protocol',
    '1. BADGE: `badge_label` is a 2-4 word semantic ROLE label (≤30 chars). Examples: "Source", "Transform", "Staging", "Output", "Validation", "Aggregation", "AC Reallocation", "EV Calculation", "Pipeline Seeder", "Reference Remap". The label captures the node\'s ROLE in the pipeline.',
    '   - SELECTIVITY: Skip `badge_label` for passthrough nodes (SELECT *, simple staging, lookup joins). They are mentioned in section text without their own badge.',
    '   - GROUPING: Nodes that serve the SAME role take the SAME label. Five EV Case procedures all use `badge_label: "EV Calculation"`; three regional loaders all use `"Regional Upsert"`. Synthesis groups same-label nodes into one section, so a label that is shared across siblings produces a clean grouped section, while a unique-per-node verbose label produces a fragmented section-per-node output. Prefer the shared role over the per-node detail — the differing detail belongs in the section body.',
    '   - Use ROLE words ("Reallocation", "Calculation", "Upsert", "Source"); the body of the section carries implementation detail (window function, recursive CTE, etc.) and the engine adds the node-type icon — those do not need to be in the label.',
    '2. NOTE: `note_caption` (≤200 chars) — cross-hop REASONING delta. `summary` already captures WHAT the node does; `note_caption` carries the new insight or open question for future hops.',
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
    BLOCK.sectionsShape,
    '',
    BLOCK.badgeAndNote,
    '',
    BLOCK.routing
  );

  // Inline ships full DDL up front and toolPolicy hides `lineage_get_neighbor_columns`, so the pruning protocol is dead weight there.
  if (!isInline) {
    sections.push('', BLOCK.pruningProtocol);
  }

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
 * guidance). Re-asserts depth, math syntax, and per-node SQL-evidence requirements that
 * the model otherwise drops under pressure. Restored from baseline1's proven shape.
 *
 * @param question - The user's original question, re-injected to anchor synthesis on intent.
 */
export function buildSynthesisReminder(question: string): string {
  return [
    '## Synthesis Reminder — re-read before calling `lineage_present_result`',
    `- User question: "${question}"`,
    '- `sections[]` is REQUIRED — the captured per-node bodies belong here, not in `intro`. Lift each `detail_slots[i].sections[j].text` verbatim into a peer entry.',
    '- GROUP along two orthogonal axes: (1) keep each captured slot\'s `angle` separate — a business section and a technical section remain individual entries; under `classification = both` this yields two parallel streams. (2) Within a single angle, nodes that share `badge_label` become one section (badge → `label`, every grouped node id → `node_ids[]`).',
    '- Every badged node deserves business meaning AND SQL evidence (predicate, formula, join key); a label without evidence is incomplete.',
    '- Carry every formula in LaTeX math syntax (`$expr$` inline, `$$expr$$` block) and every ⚠️ risk callout from capture into the assembled section. Math captured as LaTeX renders as math; math turned into prose stays prose.',
    '- Write at the depth the captures already provide. Compression here drops information the user paid hops for.',
    '- Anchor the `intro` to the user question and the locked Mission type; one paragraph, no headings.',
  ].join('\n');
}
