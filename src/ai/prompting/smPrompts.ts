/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Following a hybrid Markdown + XML strategy: Markdown headers provide structural context
 * for GPT/Gemini, while XML tags protect high-risk dynamic data for precision in reasoning models.
 */

import { z } from 'zod';
import { CHAT_MARKDOWN_FORMAT } from './prompts';
import { buildColumnAspectPrompt } from '../prompting/prompts';
import type { ColumnEdge, DeferredQuestion, SmResult } from '../sm/smTypes';


/**
 * Shared route-question requirement (DRY across BB and CT).
 *
 * @remarks
 * The per-hop sub-question drives capture depth. Its structural A→B part is
 * engine-derivable (CT auto-generates it via `getColumnLineageQuestions`); the analytical
 * part — what business/technical logic a node applies — is NOT derivable from metadata and
 * must be authored by the AI and carried hop-to-hop. This bullet is the single source for
 * that requirement, rendered in both the BB and CT decision contracts. In CT it feeds the
 * capture narration only; `column_flow[].upstream_columns` stays structural (see the CT-safety
 * bullet in {@link BLOCK.hopDecisionContractCt}) so it stays the sole structural channel for column
 * precision and the column-precision regression cannot re-enter.
 */
const ANALYTICAL_ROUTE_QUESTION =
  '- Beyond the structural mapping, each route question must carry the analytical question the engine cannot derive from structure: what business/technical logic the routed node applies (rules, transformations, thresholds, guards, lifecycle, and material data-quality risks) to produce the traced value — not only which columns or sources feed it. This analytical question persists hop-to-hop and drives the depth of the next hop\'s capture.';


/**
 * Re-anchor suffix appended when a passthrough-inherited sub-question lands on a bodied focus.
 *
 * @remarks
 * Wording for the engine's non-bodied contraction (`enqueueHop` forwards the authored question
 * verbatim; this suffix is the one addition). The inherited text describes the passthrough table,
 * so the suffix names that provenance and points the question at the new focus. BB adds a
 * business-logic nudge — an inherited provenance framing otherwise thins BB capture depth by
 * making the focus re-answer column provenance instead of its own rules. CT keeps the plain
 * re-anchor: its depth comes from the per-column `<lineage_questions>`, and a nudge would pull
 * the column-trace worker off precise column grounding. The wording is a tuned lever — changes
 * go through prompt-change; the forwarding mechanics stay engine-owned.
 *
 * @param passthroughId - The non-bodied node the question was inherited through.
 * @param focusId - The bodied neighbor the question re-anchors onto.
 * @param mode - The gate-locked session mode (`bb` xor `ct`).
 * @returns The suffix to append to the forwarded question (leading newline included).
 */
export function buildPassthroughReAnchor(passthroughId: string, focusId: string, mode: 'bb' | 'ct'): string {
  return mode === 'ct'
    ? `\n(Inherited through passthrough ${passthroughId}; re-anchor this question to ${focusId}.)`
    : `\n(Inherited through passthrough ${passthroughId}; re-anchor this question to ${focusId}. ${focusId} applies its own logic — capture the rules, calculations, and thresholds it uses to produce these values, not only which columns feed the downstream node.)`;
}


const BLOCK = {
  /** Node classification protocol. */
  verdictCategories: [
    '## Verdict Protocol — every focus node is one of three states',
    '- analyze: The node applies business logic on the data path — a calculation, condition, status transition, or audit decision. Analyze it in depth and feature it in the answer. (Applies to logic-bearing bodied nodes; a non-bodied table focus follows the engine path — structural-summary, still kept.)',
    '- passthrough: The node is on the data path but applies no logic — a SELECT * or synonym, or a raw source / bridge / target table. Keep it in the lineage and link it by flow role (Source / Transform / Target); give it a one-line summary, not deep analysis. The trace continues *through* it — its neighbors carry the same question forward. A pure-data table is the canonical passthrough: there is no logic to analyze, yet it is usually the Source or Target the answer is about — always keep it.',
    '- prune: The node is not part of this lineage answer — remove it. It is the only verdict that removes a node. Use it for an adjacent node off the answer path, or a sink the question does not ask about (see the capture guidance on logging/audit/retention sinks).',
  ].join('\n'),
  verdictCategoriesCt: [
    '## Verdict Protocol — every focus node is one of three states',
    '- analyze: The node transforms a tracked column or is its terminal source. Fill column_flow.',
    '- passthrough: The column flows through unchanged — no logic here. Keep the node and continue the trace: fill column_flow with the real upstream_columns, or upstream_columns:[] when the column is produced here with no upstream real column. A raw source / bridge / target table is the canonical passthrough — always keep it.',
    '- prune: The focus node is not part of this column trace — remove it. It is the only verdict that removes a node.',
    '- If it is not a key transform and not off-trace, use `passthrough`; the node stays in the graph. The engine, not you, decides when the walk is done (it ends only when every scoped node has been visited).',
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
    '- `badge_label`: optional hop-time grouping hint only; it is synthesis evidence, not rendered directly. Final graph labels and node captions are authored only in `lineage_present_result`.',
  ].join('\n'),

  /** Canonical hop-local routing/pruning contract (single source, no duplicates across surfaces). */
  hopDecisionContract: [
    '## Neighbor Decision Contract (Current Hop Only)',
    'BB is node-first: decide the focus node and each current-hop neighbor from the current task and current evidence.',
    'Use mission/task metadata as source of truth; treat history prose as context only.',
    '- Actionable set this hop = current `focus_node` + current-hop `neighbors[]` from tool results.',
    '- History (`short_term_memory`, prior hop IDs, archived slots) is past context only; route/prune from current-hop evidence.',
    '- Emit explicit `verdict` for the focus node every hop.',
    '- Resolve every ID in `<required_neighbors>` through `route_requests`.',
    '- For each other current-hop neighbor:',
    '  - Route it when mission-relevant, using a concrete verification question. The engine defers routes outside the approved schema/depth scope.',
    '  - Retain it when it is already inside the approved exploration scope by omitting it from both action arrays; if later scheduled as focus, use its focus verdict.',
    '  - Add it to `prune_neighbors` only when it is outside the approved exploration scope and current evidence proves it is off the answer path.',
    '- Leave the origin and previously visited or removed nodes unchanged; submit each neighbor in at most one action array.',
    '- Generic route prompts like "analyze this node" are invalid; each route question must name what to verify and what mission decision it resolves.',
    ANALYTICAL_ROUTE_QUESTION,
    '- Derive neighbor roles purely from the provided DDL whenever possible (e.g., explicit SELECT columns, WHERE clauses).',
    '- Use `lineage_get_neighbor_columns({ids:["..."]})` exclusively for opaque DDL (e.g., `SELECT *`, dynamic SQL, or ambiguous JOINs) where you cannot determine the neighbor\'s role from the DDL alone.',
    '- Tool boundary in active phase: use only `lineage_submit_findings` and `lineage_get_neighbor_columns`.',
  ].join('\n'),
  hopDecisionContractCt: [
    '## Neighbor Decision Contract (Current Hop Only)',
    'CT is column-first: declare only real upstream columns needed to continue the active column chain.',
    'Use mission/task metadata as source of truth; treat history prose as context only.',
    '- Actionable set this hop = current `focus_node` + current-hop `neighbors[]` from tool results.',
    '- History (`short_term_memory`, prior hop IDs, archived slots) is past context only; route from current-hop evidence.',
    '- Emit explicit `verdict` for the focus node every hop (`analyze`, `passthrough`, or `prune` if the node is off the answer path).',
    '- Put only real upstream table/view/procedure node+column refs in `column_flow[].upstream_columns`; the engine carries those columns to the next hop.',
    '- For neighbors in CT, the engine already carries the column A→B continuation; add `route_requests` to carry the analytical question forward when the node applies logic worth capturing.',
    '- Generic route prompts like "analyze this node" are invalid; each route question must name what to verify and what mission decision it resolves.',
    ANALYTICAL_ROUTE_QUESTION,
    '- The engine already supplies the column A→B continuation (`<lineage_questions>`); keep `column_flow[].upstream_columns` precise and structural, and answer the analytical question in your capture narration (`sections[].text`) — never invent columns to satisfy it.',
    '- If a mission-relevant route is out of approved scope (schema/depth), still route it: engine defers it for post-synthesis follow-up.',
    '- Derive column origins purely from the provided DDL whenever possible (e.g., explicit SELECT columns).',
    '- Use `lineage_get_neighbor_columns({ids:["..."]})` exclusively for opaque DDL (e.g., `SELECT *`, dynamic SQL, or ambiguous JOINs) where the column names are hidden.',
    '- Tool boundary in active phase: use only `lineage_submit_findings` and `lineage_get_neighbor_columns`.',
  ].join('\n'),
} as const;


/**
 * Builds the static active-phase SM protocol block.
 *
 * @remarks
 * This is the canonical SM-mode protocol builder used by active-phase prompt
 * composition. It consolidates verdict/category guidance, section-shape
 * submission, routing/pruning, and optional CT anchor text. Supplying target
 * columns enables the CT protocol; classification defaults to `business`.
 *
 * @returns The assembled static SM protocol string.
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
 * Anchored on the user question at the highest-attention slot (long-context models attend
 * most strongly to the window edges). Re-asserts depth, formula carry-through, and per-node SQL-evidence
 * requirements that the model otherwise drops under pressure.
 *
 * @param question - The user's original question, re-injected to anchor synthesis on intent.
 */
function buildSynthesisReminder(question: string): string {
  return [
    '## Synthesis Reminder — re-read before calling `lineage_present_result`',
    `- User question: "${question}"`,
    '- `sections[]` is REQUIRED — create final graph/detail links from the full result. Use `detail_slots[]` for analyzed-node detail, `node_states[]` for lifecycle facts, and the "Column Trace Chain" block for CT provenance. Write `text` for every section.',
    '- `notes[]` — decoration follows documentation: link only nodes worth a badge in `sections[].node_ids[]`, and give each linked node one grounded caption. A highlighted node must be explained by a section link or a note; nodes left out of both preview surfaces stay bare.',
    '- `highlight_groups[]` is REQUIRED — include at least one selective group using the Lineage palette. For zero-trace or single-node results, use a `target` group on the origin/result node.',
    '- GROUP question-first: choose sections that best answer the question. `section.label` is final authority for report grouping/links; hop `badge_label` values are helper hints only. Keep business/technical split only when it improves clarity.',
    '- Every linked node needs grounded evidence; choose business-first evidence in `business` mode, and add SQL-level evidence only when needed to clarify impact. In `technical`/`both`, include technical evidence as relevant.',
    '- Formula/evidence policy: if captured business evidence contains formulas or explicit calculations for mission-critical nodes, keep them in section text. Compress prose, not evidence classes (rule triggers, thresholds, formulas, lifecycle effects, audit meaning).',
    '- Formula rendering: write every formula as LaTeX `$$…$$` block math (e.g. `$$ NetAmountA = QtyA \\times PriceA $$`). Use `\\times`, `\\text{}`, `\\operatorname{COALESCE}`; avoid backticks, inline code, plain prose, unicode math symbols, and bare single `$` (collides with @params and dollar amounts).',
    '- ⚠️ callout policy: include risk callouts only for significant decision-impacting issues grounded in captured evidence.',
    '- For specific questions: answer directly; depth follows from the question. For broad questions: draw from the full captured detail. In both cases, write the text for every section.',
    '- Anchor the `intro` to the user question and the locked Mission type; one paragraph, no headings.',
    `${CHAT_MARKDOWN_FORMAT} Match length to the question. Tool calls and tool results remain structured data.`,
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
 * @param ctPrunedNodeIds - Focus nodes pruned via `verdict=prune` in CT mode (recorded in `ctPrunedNodeIds`); off-trace nodes excluded by scope filter are not listed here.
 * @returns Formatted markdown block anchoring synthesis to the column chain.
 */
/** Source/transform/target highlight buckets derived from graph position. */
interface FlowRoleGroups {
  /** Terminal data origins: reached nodes data only flows out of. */
  source: string[];
  /** The queried origin node — the answer anchor. */
  target: string[];
  /** Every other reached node on the path. */
  transform: string[];
}

/**
 * Derives source/transform/target highlight buckets from graph position — the single computation
 * BB and CT synthesis both use, so the two modes bucket identically (no per-mode clone).
 *
 * @remarks
 * `source` = a reached node data only flows OUT of (never a flow target within the trace, and — CT
 * only, via `hopNodes` — never itself a focus, since the `writes_to` redirect makes writer procs
 * appear as `from` only). `target` = the queried origin (upstream/bidirectional convention: data
 * lands at the origin), matching the highlights template; CT already uses only this convention.
 * `transform` = every other reached node.
 *
 * @param originNodeId - The queried origin (becomes the sole `target`).
 * @param edges - Normalized flow edges (`from` → `to`, data-flow direction).
 * @param hopNodes - CT-only focus-node set excluded from the terminal-source set.
 * @param writtenNodes - CT-only nodes with an incoming node-level edge from within the traced chain.
 */
function computeFlowRoleGroups(
  originNodeId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
  hopNodes?: ReadonlySet<string>,
  writtenNodes?: ReadonlySet<string>,
): FlowRoleGroups {
  const toNodes = new Set(edges.map(e => e.to));
  const reached = new Set<string>([originNodeId]);
  for (const e of edges) { reached.add(e.from); reached.add(e.to); }
  const source = [...new Set(edges.map(e => e.from))]
    .filter(n => n !== originNodeId && !toNodes.has(n) && !hopNodes?.has(n) && !writtenNodes?.has(n));
  const sourceSet = new Set(source);
  const transform = [...reached].filter(n => n !== originNodeId && !sourceSet.has(n));
  return { source, target: [originNodeId], transform };
}

/**
 * Renders the shared `highlight_groups` guidance lines from computed {@link FlowRoleGroups}.
 *
 * @remarks
 * Enumerates only mechanical facts (target, terminal-source candidates) — transform is
 * deliberately NOT enumerated: models transcribe enumerated lists verbatim, which defeats the
 * question-relative importance judgment the highlights template assigns to the AI.
 */
function buildFlowRoleHighlightLines(groups: FlowRoleGroups): string[] {
  return [
    'Engine-computed graph facts for highlight_groups (mechanical candidates only — final coloring is your question-relative judgment per the highlights template):',
    `- highlight_groups.target — the queried origin node: ${groups.target.join(', ')}`,
    `- highlight_groups.source candidates — terminal data-origin nodes the trace reached (base feeds never written to within the trace); color the ones whose DATA feeds the answer, leave filter-only lookups bare: ${groups.source.join(', ') || '(none)'}`,
    "- highlight_groups.transform — not enumerated: choose the important transformations yourself — nodes that CREATE or CHANGE the answer's values (formula, condition, classification, status transition). Carry-through nodes (renames, SELECT * bridges, movement procs, plain storage tables, row filters) stay uncolored — they are still rendered, and are captioned in notes[].",
  ];
}

/**
 * BB-mode counterpart to {@link buildCtSynthesisBlock}: grounds the `highlight_groups` buckets in the
 * traced node edges so BB source-bucketing is a transcription, not a guess (matches CT's fidelity).
 *
 * @param originNodeId - The queried origin (the `target` node).
 * @param edges - Node-level lineage edges `[from, to, kind]` from `SmResult.edges`.
 */
export function buildBbSynthesisBlock(originNodeId: string, edges: ReadonlyArray<[string, string, string]>): string {
  const groups = computeFlowRoleGroups(originNodeId, edges.map(([from, to]) => ({ from, to })));
  return [
    '## Flow-Role Highlights',
    ...buildFlowRoleHighlightLines(groups),
  ].join('\n');
}

/**
 * Renders the CT-specific synthesis evidence block from validated column edges.
 *
 * @param originNodeId - The queried origin node that should be treated as the answer target.
 * @param edges - Validated column-flow edges accumulated by the engine.
 * @param ctPrunedNodeIds - CT focus nodes that were explicitly pruned as off-trace.
 * @param nodeEdges - Node-level flow edges used to distinguish written intermediates from base feeds.
 * @returns Markdown instructions/evidence for the final `lineage_present_result` turn.
 */
export function buildCtSynthesisBlock(
  originNodeId: string,
  edges: ColumnEdge[],
  ctPrunedNodeIds?: string[],
  nodeEdges: ReadonlyArray<[string, string, string]> = [],
): string {
  const lines = ['## Column Trace Chain'];
  if (edges.length === 0) {
    lines.push('No edges recorded — verify column_flow was submitted at each hop.');
    lines.push('Structure present_result as a zero-trace answer: explain that no column-flow edge was proven, link the origin/result node in sections[], and include highlight_groups.target for that origin/result node.');
    return lines.join('\n');
  }
  for (const e of edges) {
    lines.push(`  ${e.from_node}.${e.from_col} → ${e.to_node}.${e.to_col} (hop ${e.hop})`);
  }
  if (ctPrunedNodeIds && ctPrunedNodeIds.length > 0) {
    lines.push('');
    lines.push(`Excluded branches (no column edges): ${ctPrunedNodeIds.join(', ')}`);
    lines.push('- Keep excluded branches out of the column chain narrative and sections[].');
  }
  const ctNodeIds = new Set<string>([originNodeId]);
  for (const edge of edges) {
    ctNodeIds.add(edge.hop_node);
    ctNodeIds.add(edge.from_node);
    ctNodeIds.add(edge.to_node);
  }
  const writtenCtNodes = new Set(nodeEdges
    .filter(([from, to]) => ctNodeIds.has(from) && ctNodeIds.has(to))
    .map(([, to]) => to));
  // hop_node excludes redirected writer procs; writtenCtNodes excludes their writes_to targets.
  const groups = computeFlowRoleGroups(
    originNodeId,
    edges.map(e => ({ from: e.from_node, to: e.to_node })),
    new Set(edges.map(e => e.hop_node)),
    writtenCtNodes,
  );
  lines.push('');
  lines.push('Structure present_result using this CT chain:');
  lines.push('- summary: one sentence naming origin column → traced path → terminal source');
  lines.push('- intro: anchor to the column chain — name start node, key writers/transforms, terminal source');
  lines.push('- sections[]: group by the answer, not by every hop. Use short final labels and link nodes needed for the answer, including passthrough tables when they are source/target/bridge nodes in the column chain.');
  lines.push('- Keep passthrough or tangential nodes compact unless they carry, persist, or terminate the traced column.');
  lines.push(...buildFlowRoleHighlightLines(groups));
  lines.push('  — terminal source = the deepest data origin in this trace; can be a table without a detail slot');
  return lines.join('\n');
}

/**
 * Per-node writer/reader graph facts — `writtenBy` = the `from` ends of edges INTO the node,
 * `readBy` = the `to` ends of edges FROM it. Both lists lowercased and id-sorted.
 */
interface NodeFlowFacts {
  /** Node ids that write INTO this node (`from` ends of inbound edges), sorted, lowercased. */
  writtenBy: string[];
  /** Node ids this node is read BY (`to` ends of outbound edges), sorted, lowercased. */
  readBy: string[];
}

/**
 * The single producer of per-node writer/reader flow facts for synthesis passthrough grounding
 * ({@link buildPassthroughFlowFacts}) so every caller reads byte-identical, deterministically-sorted
 * facts (no per-caller re-derivation).
 *
 * @remarks
 * Facts only: writers/readers come purely from the node-level edge list. A node with no inbound or
 * outbound edge simply has no map entry (callers render it as `(none)` via
 * {@link renderFlowFactsFragment}). Ids are lowercased and neighbor lists id-sorted for determinism.
 *
 * @param edges - Node-level `[from, to, kind]` flow edges from {@link SmResult.edges}.
 */
function computeNodeFlowFacts(edges: ReadonlyArray<[string, string, string]>): Map<string, NodeFlowFacts> {
  const lc = (s: string): string => s.toLowerCase();
  const addNeighbor = (m: Map<string, Set<string>>, key: string, value: string): void => {
    let set = m.get(key);
    if (!set) { set = new Set<string>(); m.set(key, set); }
    set.add(value);
  };
  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    addNeighbor(writers, lc(to), lc(from));
    addNeighbor(readers, lc(from), lc(to));
  }
  const sortList = (set: Set<string> | undefined): string[] =>
    set ? [...set].sort((a, b) => a.localeCompare(b)) : [];
  const facts = new Map<string, NodeFlowFacts>();
  for (const id of new Set<string>([...writers.keys(), ...readers.keys()])) {
    facts.set(id, { writtenBy: sortList(writers.get(id)), readBy: sortList(readers.get(id)) });
  }
  return facts;
}

/**
 * Renders one node's flow facts as the shared `written by …; read by …` fragment. An absent entry
 * or empty list renders `(none)` — the byte-exact form the passthrough digest and note captions share.
 */
function renderFlowFactsFragment(facts: NodeFlowFacts | undefined): string {
  const list = (arr: string[] | undefined): string => (arr && arr.length > 0 ? arr.join(', ') : '(none)');
  return `written by ${list(facts?.writtenBy)}; read by ${list(facts?.readBy)}`;
}

/**
 * Renders engine flow facts for KEPT (non-pruned) nodes that received no detail slot — the terse
 * `node_states` entry is their only trace in the archive, so without grounded graph facts the
 * model has nothing to state about them and drops them from sections/highlights/notes.
 *
 * @remarks
 * Facts only: writers/readers are derived purely from {@link SmResult.edges} (`written by` = the
 * `from` ends of edges INTO the node; `read by` = the `to` ends of edges FROM it); type is read
 * from {@link SmResult.fullNodes}, action from `node_states`. The base set is `fullNodes`, which
 * `getResult` already restricts to reachable, non-pruned nodes and — in CT — to the column-flow
 * scope, so pruned nodes never appear here (belt-and-suspenders: an explicit `prune` action is
 * also filtered). Deterministic: nodes and neighbor lists sort by id, ids lowercased.
 *
 * @param result - Completed SM result: `fullNodes` the rendered kept set, `detail_slots` the
 * analyzed subset, `edges` the node-level `[from, to, kind]` flow, `node_states` the actions.
 * @returns A markdown bullet list of writer/reader facts, or an empty string when every kept node is slotted.
 */
export function buildPassthroughFlowFacts(result: SmResult): string {
  const lc = (s: string): string => s.toLowerCase();
  const slottedIds = new Set(result.detail_slots.map(s => lc(s.nodeId)));
  const prunedIds = new Set(result.node_states.filter(s => s.action === 'prune').map(s => lc(s.nodeId)));
  const actionById = new Map(result.node_states.map(s => [lc(s.nodeId), s.action]));
  const flowFacts = computeNodeFlowFacts(result.edges);

  const qualifying = result.fullNodes
    .map(n => ({ id: lc(n.id), type: n.t }))
    .filter(n => !slottedIds.has(n.id) && !prunedIds.has(n.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (qualifying.length === 0) return '';

  const lines = qualifying.map(n => {
    const descriptor = [n.type, actionById.get(n.id)].filter(Boolean).join(', ');
    const prefix = descriptor ? ` — ${descriptor}` : '';
    return `- ${n.id}${prefix}: ${renderFlowFactsFragment(flowFacts.get(n.id))}`;
  });

  return [
    'Kept passthrough nodes (engine flow facts). Self-check before calling `lineage_present_result`: every id listed below must appear in `sections[].node_ids`, `highlight_groups[].node_ids`, or `notes[].node_id` — an uncovered kept node is the same class of gap as an unaccounted column, and the only way to drop one from the view is a prune verdict. A value-carrying store, staging table, or bridge that has no detail slot still earns one grounded, uncolored `notes[].node_id` caption built from its writer/reader facts:',
    ...lines,
  ].join('\n');
}


/**
 * The tool-result envelope delivered to synthesis when SM exploration completes — "the last tool
 * result" the synthesis system prompt reads.
 *
 * @remarks
 * Single source of truth for the synthesis evidence surface. The live
 * `lineage_submit_findings` completion branch and the host-graph synthesis node both call this
 * builder. {@link synthesis_reminder} carries the user-question anchor plus, in CT, the
 * rendered flow-role block — the only place the model is told which nodes are terminal sources;
 * those are not reconstructable from the raw archive fields. The block is the CT column chain when
 * column edges exist, else the BB node-edge flow-role buckets — both via the shared
 * {@link computeFlowRoleGroups}. Off-trace nodes (no edges) are excluded by the scope filter. The
 * reminder then also carries the {@link buildPassthroughFlowFacts} digest — grounded writer/reader
 * facts for kept nodes with no detail slot, which otherwise have no semantic content to document.
 */
interface SmCompletionEnvelope {
  readonly ok: true;
  readonly done: true;
  readonly result: {
    readonly status: SmResult['status'];
    readonly originNodeId: string;
    readonly scope: { readonly nodes: number; readonly edges: number };
    readonly suggested_sections: SmResult['suggested_sections'];
    readonly node_states: SmResult['node_states'];
    readonly detail_slots: SmResult['detail_slots'];
  };
  readonly deferred_questions: ReadonlyArray<DeferredQuestion>;
  readonly synthesis_reminder: string;
}

/**
 * Runtime guard for {@link SmCompletionEnvelope} — the synthesis evidence surface handed to the
 * model. Validates the envelope STRUCTURE (the fields synthesis depends on) at the boundary; leaf
 * element shapes are permissive (value enums are already enforced at the submit boundary), so this
 * catches real drift — a renamed/removed `detail_slots`/`node_states`/`result` field — without
 * re-litigating per-leaf vocabulary. Enforced via {@link buildSmCompletionEnvelope}.
 */
const SmCompletionEnvelopeSchema = z.object({
  ok: z.literal(true),
  done: z.literal(true),
  result: z.object({
    status: z.literal('complete'),
    originNodeId: z.string(),
    scope: z.object({ nodes: z.number(), edges: z.number() }).strict(),
    suggested_sections: z.array(z.object({ label: z.string(), node_ids: z.array(z.string()) }).passthrough()).optional(),
    node_states: z.array(z.object({ nodeId: z.string(), action: z.string() }).passthrough()),
    detail_slots: z.array(z.object({
      nodeId: z.string(), schema: z.string(), name: z.string(), type: z.string(),
      sections: z.array(z.object({ angle: z.string(), text: z.string() }).passthrough()),
      summary: z.string(),
    }).passthrough()),
  }).strict(),
  deferred_questions: z.array(z.object({ nodeId: z.string(), question: z.string() }).passthrough()),
  synthesis_reminder: z.string(),
}).strict();

/**
 * Assembles the {@link SmCompletionEnvelope} from a completed engine result.
 *
 * @remarks
 * The CT chain block ({@link buildCtSynthesisBlock}) is appended only when column edges were recorded;
 * it carries the terminal-source facts CT synthesis depends on. Off-trace nodes are excluded upstream
 * by the CT scope filter; `ctPrunedNodeIds` lists focus nodes pruned via `verdict=prune` in CT.
 *
 * @param result - The completed `engine.getResult()` archive (full `detail_slots` across all hops).
 * @param userQuestion - The verbatim mission question anchoring the synthesis reminder.
 * @param deferred - BFS-skipped questions, surfaced once at the end if material.
 */
export function buildSmCompletionEnvelope(
  result: SmResult,
  userQuestion: string,
  deferred: ReadonlyArray<DeferredQuestion>,
): SmCompletionEnvelope {
  const flowBlock = result.columnAspect && result.columnAspect.edges.length > 0
    ? '\n' + buildCtSynthesisBlock(result.originNodeId, result.columnAspect.edges, result.ctPrunedNodeIds, result.edges)
    : result.edges.length > 0
      ? '\n' + buildBbSynthesisBlock(result.originNodeId, result.edges)
      : '';
  const passthroughFacts = buildPassthroughFlowFacts(result);
  const passthroughBlock = passthroughFacts ? '\n' + passthroughFacts : '';
  const envelope: SmCompletionEnvelope = {
    ok: true,
    done: true,
    result: {
      status: result.status,
      originNodeId: result.originNodeId,
      scope: { nodes: result.fullNodes.length, edges: result.edges.length },
      suggested_sections: result.suggested_sections,
      node_states: result.node_states,
      detail_slots: result.detail_slots,
    },
    deferred_questions: deferred,
    synthesis_reminder: buildSynthesisReminder(userQuestion) + flowBlock + passthroughBlock,
  };
  // Hard-fail on shape drift: surface an upstream bug loudly, not as silently-degraded model input.
  SmCompletionEnvelopeSchema.parse(envelope);
  return envelope;
}
