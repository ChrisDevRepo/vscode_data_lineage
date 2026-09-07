/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Following a hybrid Markdown + XML strategy: Markdown headers provide structural context
 * for GPT/Gemini, while XML tags protect high-risk dynamic data for precision in reasoning models.
 */

import { buildColumnAspectPrompt } from '../prompting/prompts';
import type { ColumnEdge, DeferredQuestion, SmResult } from '../sm/smTypes';


/**
 * Shared route-question requirement (DRY across BB and CT).
 *
 * @remarks
 * The per-hop sub-question drives capture depth. Its structural A→B part is
 * engine-derivable (CT auto-generates it via `getColumnLineageQuestionsByNode`, the per-node
 * source of record); the analytical
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
 * One resolution rule for `<required_neighbors>`, composed by both hop decision contracts so the
 * rendered checklist can never drift from the guard the moment either wording changed. CT is BB
 * plus column tracking — a neighbor that carries none of the traced columns still restricts the row
 * set, and reading it is part of the trace, so CT resolves the same list.
 */
const REQUIRED_NEIGHBOR_RESOLUTION =
  '- Resolve every ID in `<required_neighbors>` through `route_requests` this hop; they are approved in-scope continuation nodes. Omitting a required ID is never an option.';

/**
 * The mode-neutral neighbor decision core, composed verbatim by BOTH hop contracts (same
 * instruction, same pruning, same routing in BB and CT — each contract adds only its own framing
 * line, its verdict wording, and its mode additions).
 */
const NEIGHBOR_DECISION_CORE = [
  'Use mission/task metadata as source of truth; treat history prose as context only.',
  '- Actionable set this hop = current `focus_node` + current-hop `neighbors[]` from tool results.',
  '- History (`short_term_memory`, prior hop IDs, archived slots) is past context only; route/prune from current-hop evidence.',
  REQUIRED_NEIGHBOR_RESOLUTION,
  '- Retain-by-omission applies only to neighbors that are not in `<required_neighbors>`; a required ID always gets an explicit decision.',
  '- For each other current-hop neighbor:',
  '  - Route it when mission-relevant, using a concrete verification question. The engine defers routes outside the approved schema/depth scope.',
  '  - Retain it when it is already inside the approved exploration scope by omitting it from both action arrays; if later scheduled as focus, use its focus verdict.',
  '  - Add it to `prune_neighbors` when current evidence proves it is off the answer path — outside the approved exploration scope, or inside it with nothing the answer needs. A neighbor that supplies no value but decides which rows the answer returns — a join, filter or predicate source — is not \"nothing the answer needs\": route or retain it. An executed prune must never orphan committed work; the engine refuses such a prune.',
  '- Leave the origin and previously visited or removed nodes unchanged — the origin anchors the lineage and stays out of `prune_neighbors`; submit each neighbor in at most one action array.',
  '- Generic route prompts like "analyze this node" are invalid; each route question must name what to verify and what mission decision it resolves.',
  ANALYTICAL_ROUTE_QUESTION,
] as const;


/**
 * Re-anchor suffix appended when a passthrough-inherited sub-question lands on a bodied focus.
 *
 * @remarks
 * Wording for the engine's non-bodied contraction (`enqueueHop` forwards the authored question
 * verbatim; this suffix is the one addition). The inherited text describes the passthrough table,
 * so the suffix names that provenance and points the question at the new focus. The
 * business-logic nudge is the shared text — an inherited provenance framing otherwise thins
 * capture depth by making the focus re-answer column provenance instead of its own rules, and CT
 * is BB plus columns, so CT reads the same nudge and adds its column clause to it. The wording is
 * a tuned lever — changes go through prompt-change; the forwarding mechanics stay engine-owned.
 *
 * @param passthroughId - The non-bodied node the question was inherited through.
 * @param focusId - The bodied neighbor the question re-anchors onto.
 * @param mode - The gate-locked session mode (`bb` xor `ct`).
 * @returns The suffix to append to the forwarded question (leading newline included).
 */
export function buildPassthroughReAnchor(passthroughId: string, focusId: string, mode: 'bb' | 'ct'): string {
  const reAnchor = `\n(Inherited through passthrough ${passthroughId}; re-anchor this question to ${focusId}. ${focusId} applies its own logic — capture the rules, calculations, and thresholds it uses to produce these values, not only which columns feed the downstream node.`;
  return mode === 'ct' ? `${reAnchor} Ground that in the traced column.)` : `${reAnchor})`;
}


/**
 * The one `lineage_get_neighbor_columns` trigger, exported for the tool catalog so the BB/CT
 * decision blocks and the `modelDescription` state it from this source alone. BB's role-opacity
 * test is what feeds route and prune, so CT carries it verbatim and appends its column-specific
 * case; narrowing CT to hidden column names alone dropped the role test CT still needs.
 */
export const NEIGHBOR_COLUMNS_TRIGGER = '- Use `lineage_get_neighbor_columns({ids:["..."]})` exclusively for opaque DDL (e.g., `SELECT *`, dynamic SQL, or ambiguous JOINs) where you cannot determine the neighbor\'s role from the DDL alone';

const PRUNE_VERDICT_TAIL = 'It is the only verdict that removes a node. Use it for an adjacent node off the answer path, or a sink the question does not ask about (see the capture guidance on logging/audit/retention sinks).'; // shared by BB + CT verdict blocks so CT prunes the same sinks BB does

/**
 * The one prune trigger, byte-shared by the BB and CT verdict blocks and mirrored into the
 * `submit_findings` schema description (`hopVerdictSchema`).
 *
 * @remarks
 * CT stated a value test here instead ("the traced value never passes through this focus node"),
 * which prunes a node that shapes which rows appear but carries no traced value — a node BB keeps.
 * Same question, two graphs. CT is BB plus columns: it may add to this trigger, never replace it.
 */
export const PRUNE_VERDICT_LEAD = 'The node is not part of this lineage answer — remove it.';

/** Passthrough lead and body, byte-shared by both verdict blocks; CT adds its column clauses. */
const PASSTHROUGH_VERDICT_LEAD = 'The node is on the data path but applies no logic — a SELECT * or synonym, or a raw source / bridge / target table.';
const PASSTHROUGH_VERDICT_BODY = 'Keep it in the lineage and link it by flow role (Source / Transform / Target); give it a one-line summary, not deep analysis. The trace continues *through* it — its neighbors carry the same question forward. A pure-data table is the canonical passthrough: there is no logic to analyze, yet it is usually the Source or Target the answer is about — always keep it.';

/**
 * The one verdict protocol. CT renders this text and appends {@link COLUMN_FLOW_VERDICT_RIDER};
 * it never restates a verdict in column vocabulary, because a second definition of `analyze` or
 * `passthrough` is a second graph for the same question.
 */
const VERDICT_CATEGORIES = [
  '## Verdict Protocol — every focus node is one of three states',
  '- analyze: The node applies business logic on the data path — a calculation, condition, status transition, or audit decision. Analyze it in depth and feature it in the answer. (Applies to logic-bearing bodied nodes; a non-bodied table focus follows the engine path — structural-summary, still kept.)',
  `- passthrough: ${PASSTHROUGH_VERDICT_LEAD} ${PASSTHROUGH_VERDICT_BODY}`,
  `- prune: ${PRUNE_VERDICT_LEAD} ${PRUNE_VERDICT_TAIL}`,
].join('\n');

/** The one sentence CT adds to {@link VERDICT_CATEGORIES}: the column aspect of any verdict. */
const COLUMN_FLOW_VERDICT_RIDER =
  '- Every verdict carries `column_flow`: the real upstream columns behind each tracked output, and `[]` when the value originates here or the node carries none.';

/**
 * The one hop decision contract, composed by both modes. CT renders it unchanged and appends
 * {@link COLUMN_DECISION_ADDENDUM} — the frame line, the verdict line, the neighbor core, the
 * derive-from-DDL rule and the tool boundary are the same instruction in both modes, so a CT
 * paraphrase of any of them is a second contract, not a column aspect.
 */
const HOP_DECISION_CONTRACT = [
  '## Neighbor Decision Contract (Current Hop Only)',
  'BB is node-first: decide the focus node and each current-hop neighbor from the current task and current evidence.',
  '- Emit explicit `verdict` for the focus node every hop.',
  ...NEIGHBOR_DECISION_CORE,
  '- Derive neighbor roles purely from the provided DDL whenever possible (e.g., explicit SELECT columns, WHERE clauses).',
  `${NEIGHBOR_COLUMNS_TRIGGER}.`,
  '- Tool boundary in active phase: use only `lineage_submit_findings` and `lineage_get_neighbor_columns`.',
] as const;

/**
 * The column aspect of the hop decision, appended to {@link HOP_DECISION_CONTRACT} in CT.
 *
 * @remarks
 * `column_flow[].upstream_columns` stays the sole structural channel for column precision (see
 * {@link ANALYTICAL_ROUTE_QUESTION}): it records the value path the engine continues, it opens no
 * route, and the analytical answer belongs in the capture narration — the column-precision
 * regression re-enters the moment a column is written there to satisfy a narrative.
 */
const COLUMN_DECISION_ADDENDUM = [
  'CT is column-first on top of those same decisions — these add the column aspect:',
  '- `column_flow[].upstream_columns` holds real upstream node+column refs only — the value path the engine carries to the next hop, derived from the DDL. It opens no route: name each contributor in `route_requests` too, and resolve hidden column names with `lineage_get_neighbor_columns`.',
  '- `<lineage_questions>` already carries the column A→B continuation; the analytical answer goes in `sections[].text`.',
] as const;

const BLOCK = {
  /** Node classification protocol. */
  verdictCategories: VERDICT_CATEGORIES,
  verdictCategoriesCt: [VERDICT_CATEGORIES, COLUMN_FLOW_VERDICT_RIDER].join('\n'),

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
  hopDecisionContract: HOP_DECISION_CONTRACT.join('\n'),
  hopDecisionContractCt: [...HOP_DECISION_CONTRACT, ...COLUMN_DECISION_ADDENDUM].join('\n'),
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
    sections.push('', buildColumnAspectPrompt(targetColumns));
  }

  return sections.join('\n');
}


/**
 * Builds the synthesis reminder appended as the last key of the completion tool_result JSON.
 *
 * @remarks
 * Anchored on the user question at the highest-attention slot (long-context models attend most
 * strongly to the window edges). It states the SKELETON of the document the model writes — which
 * field is which part, what each part carries, and in what order — not a checklist of rules to
 * obey. The engine facts that follow it (flow roles, edge direction, kept nodes with no detail
 * slot, captured `$$` blocks) are the content; this block is the shape they go into. The final
 * line is the document contract, not the chat contract: this render sits beside the graph, so its
 * length follows the captured evidence rather than the question's phrasing.
 *
 * @param question - The user's original question, re-injected to anchor synthesis on intent.
 */
function buildSynthesisReminder(question: string): string {
  return [
    '## The document beside the graph — the shape of `lineage_present_result`',
    `- User question: "${question}"`,
    '- `intro`: one paragraph anchored to the question and the locked Mission type, no headings.',
    '- `sections[]`: the body, in graph order — terminal sources, then each transform, then the origin and what reads it. `section.label` is the heading, `section.node_ids[]` links the nodes that section documents, and `section.text` carries, for each linked node, the rules it applies, the predicates that shape its rows, its `$$` formulas and its ⚠️ callouts, with the short SQL that grounds them — drawn from `detail_slots[]`, `node_states[]` and the engine facts below.',
    '- `notes[]`: the caption line under a node — one sentence on what it does in this flow.',
    '- `highlight_groups[]`: the Lineage palette over the flow roles below, at least a `target` group on the origin.',
    '- `summary`: one sentence naming the answer.',
    '- `result.scope.node_ids` is the id set this render accepts; `sections[].node_ids[]`, `notes[].node_id` and `highlight_groups[].node_ids[]` name ids from it, and any other object the evidence names is prose in `sections[].text`.',
    '- Formulas are LaTeX math: `$...$` inline, `$$…$$` for a standalone block (e.g. `$$ NetAmountA = QtyA \\times PriceA $$`), with `\\times`, `\\text{}`, `\\operatorname{COALESCE}`.',
    'This is the document beside the graph, not a chat reply: Markdown only, no arbitrary HTML, SQL in fenced ```sql blocks. Length follows the captured evidence, not the question — every kept node keeps its rules, predicates and formulas.',
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
 */
function computeFlowRoleGroups(
  originNodeId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
  hopNodes?: ReadonlySet<string>,
): FlowRoleGroups {
  const toNodes = new Set(edges.map(e => e.to));
  const reached = new Set<string>([originNodeId]);
  for (const e of edges) { reached.add(e.from); reached.add(e.to); }
  const source = [...new Set(edges.map(e => e.from))]
    .filter(n => n !== originNodeId && !toNodes.has(n) && !hopNodes?.has(n));
  const sourceSet = new Set(source);
  const transform = [...reached].filter(n => n !== originNodeId && !sourceSet.has(n));
  return { source, target: [originNodeId], transform };
}

/**
 * Buckets every traced node by its DIRECTED relation to the origin.
 *
 * @remarks
 * The `## Column Trace Chain` list renders in hop order, which is not direction order, so direction
 * cannot be inferred from a node's position in it — these buckets state it explicitly instead.
 * `sideBranch` is the bucket that matters: a node that reads a traced node but lies on no path to or
 * from the origin is neither upstream nor downstream, and calling it upstream inverts a real edge.
 *
 * @param originNodeId - The queried origin.
 * @param edges - Normalized flow edges (`from` → `to`, data-flow direction).
 */
function computeDirectionGroups(
  originNodeId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
): { upstream: string[]; downstream: string[]; sideBranch: string[] } {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const reached = new Set<string>([originNodeId]);
  for (const e of edges) {
    reached.add(e.from);
    reached.add(e.to);
    (forward.get(e.from) ?? forward.set(e.from, []).get(e.from)!).push(e.to);
    (backward.get(e.to) ?? backward.set(e.to, []).get(e.to)!).push(e.from);
  }
  const walk = (adjacency: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const stack = [originNodeId];
    while (stack.length > 0) {
      for (const next of adjacency.get(stack.pop()!) ?? []) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    seen.delete(originNodeId);
    return seen;
  };
  const downstream = walk(forward);
  const upstream = walk(backward);
  const sideBranch = [...reached]
    .filter(n => n !== originNodeId && !upstream.has(n) && !downstream.has(n));
  return { upstream: [...upstream].sort(), downstream: [...downstream].sort(), sideBranch: sideBranch.sort() };
}

/**
 * Renders the shared edge-direction lines from computed {@link computeDirectionGroups} buckets.
 *
 * @remarks
 * The single direction statement BB and CT synthesis both use, so the two modes state direction
 * identically — same rule as {@link computeFlowRoleGroups}, no per-mode clone.
 *
 * Takes the computed buckets rather than the edges: a caller that also reasons about a bucket reads
 * the same object these lines state, so the rendered claim and the caller's branch cannot disagree.
 *
 * @param originNodeId - The queried origin the buckets are relative to.
 * @param direction - Buckets from {@link computeDirectionGroups} for that origin.
 */
function buildDirectionLines(
  originNodeId: string,
  direction: ReturnType<typeof computeDirectionGroups>,
): string[] {
  return [
    `Edge direction relative to ${originNodeId} — engine-computed and authoritative. Any list above is in HOP order, which is NOT direction order; never infer direction from a node's position in it:`,
    `- upstream (data flows INTO the origin): ${direction.upstream.join(', ') || '(none)'}`,
    `- downstream (data flows OUT of the origin): ${direction.downstream.join(', ') || '(none)'}`,
    `- side branches — these READ a traced node and lie on NO path to or from the origin: ${direction.sideBranch.join(', ') || '(none)'}`,
    '- Never describe a side branch as upstream, as a source, or as feeding the origin; it consumes the same data the origin consumes.',
  ];
}

/**
 * Renders the shared `highlight_groups` guidance lines from computed {@link FlowRoleGroups}.
 *
 * @remarks
 * Enumerates only mechanical facts (target, terminal-source candidates) — transform is
 * deliberately NOT enumerated: models transcribe enumerated lists verbatim, which defeats the
 * question-relative importance judgment the highlights template assigns to the AI.
 *
 * Candidates are bounded by the presented set: `highlight_groups[].node_ids` rejects anything the
 * render does not carry, and the synthesis prompt makes linking a named terminal source mandatory,
 * so naming a border-cut source here would order a call `present_result` refuses.
 *
 * @param groups - Mechanically computed flow-role buckets.
 * @param presented - Ids the render carries; a bucket member outside it is dropped from the line.
 *   `null` from a caller that holds no render set, which then bounds nothing.
 */
function buildFlowRoleHighlightLines(groups: FlowRoleGroups, presented: ReadonlySet<string> | null): string[] {
  const linkable = (ids: readonly string[]): string[] => presented ? ids.filter(id => presented.has(id)) : [...ids];
  return [
    'Engine-computed graph facts for highlight_groups (mechanical candidates only — final coloring is your question-relative judgment per the highlights template):',
    `- highlight_groups.target — the queried origin node: ${linkable(groups.target).join(', ')}`,
    `- highlight_groups.source candidates — terminal data-origin nodes the trace reached (base feeds never written to within the trace); color the ones whose DATA feeds the answer, leave filter-only lookups bare: ${linkable(groups.source).join(', ') || '(none)'}`,
    "- highlight_groups.transform — not enumerated: choose the important transformations yourself — nodes that CREATE or CHANGE the answer's values (formula, condition, classification, status transition). Carry-through nodes (renames, SELECT * bridges, movement procs, plain storage tables, row filters) stay uncolored — they are still rendered, and are captioned in notes[].",
  ];
}

/**
 * BB-mode counterpart to {@link buildCtSynthesisBlock}: grounds the `highlight_groups` buckets in the
 * traced node edges so BB source-bucketing is a transcription, not a guess (matches CT's fidelity).
 *
 * @param originNodeId - The queried origin (the `target` node).
 * @param edges - Node-level lineage edges `[from, to, kind]` from `SmResult.edges`.
 * @param presentedNodeIds - Ids the render carries, bounding the enumerated candidates; omitted by
 *   a caller that holds no render set, which then bounds nothing.
 */
export function buildBbSynthesisBlock(
  originNodeId: string,
  edges: ReadonlyArray<[string, string, string]>,
  presentedNodeIds: ReadonlySet<string> | null = null,
): string {
  const flowEdges = edges.map(([from, to]) => ({ from, to }));
  const groups = computeFlowRoleGroups(originNodeId, flowEdges);
  return [
    '## Flow-Role Highlights',
    ...buildFlowRoleHighlightLines(groups, presentedNodeIds),
    '',
    ...buildDirectionLines(originNodeId, computeDirectionGroups(originNodeId, flowEdges)),
  ].join('\n');
}

/**
 * Renders the CT-specific synthesis evidence block from validated column edges.
 *
 * @param originNodeId - The queried origin node that should be treated as the answer target.
 * @param edges - Validated column-flow edges accumulated by the engine.
 * @param ctPrunedNodeIds - CT focus nodes that were explicitly pruned as off-trace.
 * @param nodeEdges - Node-level flow edges used to distinguish written intermediates from base feeds.
 * @param presentedNodeIds - Ids the render carries, bounding the enumerated highlight candidates;
 *   omitted by a caller that holds no render set, which then bounds nothing. The recorded edge list
 *   itself is never bounded — the trace is the evidence, and an endpoint outside the render is
 *   stated in prose.
 * @returns Markdown instructions/evidence for the final `lineage_present_result` turn.
 */
export function buildCtSynthesisBlock(
  originNodeId: string,
  edges: ColumnEdge[],
  ctPrunedNodeIds?: string[],
  nodeEdges: ReadonlyArray<[string, string, string]> = [],
  presentedNodeIds: ReadonlySet<string> | null = null,
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
  lines.push('');
  // Direction is read off the NODE edges, not the column edges: a column chain that routes a hop
  // through a writer proc records the proc only as a `to`, so origin-relative reachability breaks
  // there and real upstream sources render as side branches. The node edges carry the proc's write,
  // and using them is also what makes BB and CT state direction identically.
  const directionEdges = nodeEdges.length > 0
    ? nodeEdges.map(([from, to]) => ({ from, to }))
    : edges.map(e => ({ from: e.from_node, to: e.to_node }));
  const direction = computeDirectionGroups(originNodeId, directionEdges);
  lines.push(...buildDirectionLines(originNodeId, direction));
  if (ctPrunedNodeIds && ctPrunedNodeIds.length > 0) {
    lines.push('');
    lines.push(`Excluded branches (no column edges): ${ctPrunedNodeIds.join(', ')}`);
  }
  // Same edge source as the direction lines and as BB: node edges carry every reached node, so a
  // node with node edges and no column edge keeps its BB bucket. hop_node exclusion repairs the
  // writes_to artifact of the column projection and applies only when no node edges exist.
  const groups = computeFlowRoleGroups(originNodeId, directionEdges,
    nodeEdges.length > 0 ? undefined : new Set(edges.map(e => e.hop_node)));
  lines.push('');
  lines.push('## Flow-Role Highlights');
  lines.push('Structure present_result using this CT chain:');
  lines.push('- sections[]: group by the answer, not by every hop. Use short final labels and link nodes needed for the answer, including passthrough tables when they are source/target/bridge nodes in the column chain.');
  lines.push('- Link every node in the chain above; a node that does not carry, persist or terminate the traced column earns one line naming what it does to the rows — join, filter, predicate, set operation — because it decides which rows the answer returns.');
  // Gated on the same downstream bucket the direction lines above state: on a purely upstream trace
  // there is nothing downstream to name, and an unconditional invitation gets answered with an
  // object outside the trace.
  if (direction.downstream.length > 0) {
    lines.push('- The downstream nodes named above consume the traced column: give each one a line stating what changes there when it changes.');
  }
  lines.push('- terminal source = the furthest-upstream object this trace reached; it can be a table without a detail slot, and it is as far as this trace got — never call it the system of record.');
  lines.push(...buildFlowRoleHighlightLines(groups, presentedNodeIds));
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
 * `getResult` already restricts to reachable, non-pruned nodes in both modes, so pruned nodes never
 * appear here (belt-and-suspenders: an explicit `prune` action is also filtered). A CT dependency
 * that carries no value into the traced column is kept and unslotted, so it surfaces here and earns
 * its caption. Deterministic: nodes and neighbor lists sort by id, ids lowercased.
 *
 * A qualifying node with no `node_states` entry was never dispositioned — scope reachability alone
 * put it in the render — so it lists under its own heading with `notes[]` as the only surface;
 * section-linking it would state it as answer evidence it never earned.
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

  const renderLine = (n: { id: string; type: string }): string => {
    const descriptor = [n.type, actionById.get(n.id)].filter(Boolean).join(', ');
    const prefix = descriptor ? ` — ${descriptor}` : '';
    return `- ${n.id}${prefix}: ${renderFlowFactsFragment(flowFacts.get(n.id))}`;
  };
  const dispositioned = qualifying.filter(n => actionById.has(n.id));
  const undispositioned = qualifying.filter(n => !actionById.has(n.id));

  return [
    'Kept passthrough nodes (engine flow facts) — the kept nodes with no detail slot. Each one is a paragraph in the section its writer or reader documents — what it holds for this flow, the predicate it is read or written under, and the row grain it lands at, read off that writer\'s and reader\'s captured DML — and carries a `sections[].node_ids`, `highlight_groups[].node_ids` or `notes[].node_id` entry:',
    ...dispositioned.map(renderLine),
    ...(undispositioned.length > 0
      ? [
        'In scope but never dispositioned — no hop analyzed, routed to, contracted through or pruned these, so `notes[]` alone is their surface, not an answer section or a highlight group:',
        ...undispositioned.map(renderLine),
      ]
      : []),
  ].join('\n');
}


/**
 * One captured artifact in a detail slot: a `$$ … $$` block, a fenced block, or an inline
 * backticked span — matched left to right, so a delimiter nested inside an outer one is part of
 * that outer artifact and never a second entry. Group order is the render order: math, fence,
 * inline; whichever group matched names the form the hop captured.
 */
const CAPTURED_ARTIFACT = /\$\$([\s\S]*?)\$\$|```[^\n`]*\n?([\s\S]*?)```|`([^`\n]+)`/g;

/** An identifier immediately followed by `(` — the lexical mark of a call, hence of a computed value. */
const CALL_TOKEN = /\w\(/;

/** A whole DML/DDL statement: it performs an action, whatever it calls along the way. */
const STATEMENT_START = /^(?:insert|update|delete|merge|truncate|exec|execute|create|alter|drop|declare|select|with|if|begin|end)\b/i;

/** The opening word of a filter condition — it decides which rows survive, whatever it is nested in. */
const PREDICATE_START = /^(?:where|on|having|and|or|join)\b/i;

/**
 * Enumerates the value computations and filter conditions the hops captured — `$$ … $$` blocks plus
 * the SQL that computes a value or filters rows — each keyed by the node whose detail slot holds it,
 * in the same self-check shape {@link buildPassthroughFlowFacts} uses for kept node ids.
 *
 * @remarks
 * The carry rule already exists in prose ("never fields within a kept item", and "every backticked
 * SQL predicate … must reappear … verbatim", `buildPresentationDetailContract`), but every OTHER
 * mandatory-carry class at synthesis is enumerated as a checklist — kept node ids, undispositioned
 * ids, the column chain, terminal-source candidates — while formulas and predicates reach the model
 * only inside slot prose it must re-scan; this closes that gap the same way.
 *
 * A hop writes the same fact as `$$`, as a fenced line or as an inline span, so the delimiter it
 * reached for cannot decide what carries; the content does, under one lexical bound. A fenced line
 * or an inline span is enumerated when it computes a value or filters rows — it carries a
 * {@link CALL_TOKEN} or opens with a {@link PREDICATE_START} keyword, and is not a whole
 * {@link STATEMENT_START} statement. A fenced block is read line by line, because one body mixes
 * both classes.
 *
 * Enumeration only: this states evidence the engine already holds, sorted by capture order and
 * de-duplicated per node so the block is byte-stable across runs. Which blocks belong in the answer
 * stays the model's judgement — nothing here rejects, rewrites or compares a payload.
 *
 * @param result - Completed SM result; `detail_slots[].sections[].text` is the captured archive.
 * @returns A markdown checklist, or an empty string when no hop captured a formula.
 */
function buildCapturedFormulaFacts(result: SmResult): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  // Whitespace-collapsed so an artifact written across lines and the same one written inline are
  // one entry, not two — the de-duplication key and the rendered line share this form.
  const collapse = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');
  const isEnumerable = (artifact: string): boolean =>
    (CALL_TOKEN.test(artifact) || PREDICATE_START.test(artifact)) && !STATEMENT_START.test(artifact);
  for (const slot of result.detail_slots) {
    const nodeId = slot.nodeId.toLowerCase();
    const push = (formula: string, rendered: string): void => {
      const key = `${nodeId}\u0000${formula}`;
      if (formula.length === 0 || seen.has(key)) return;
      seen.add(key);
      lines.push(`- ${nodeId} — ${rendered}`);
    };
    for (const section of slot.sections) {
      for (const match of section.text.matchAll(CAPTURED_ARTIFACT)) {
        const [, math, fenced, inline] = match;
        if (math !== undefined) {
          const formula = collapse(math);
          push(formula, `$$ ${formula} $$`);
          continue;
        }
        if (fenced !== undefined) {
          for (const line of fenced.split('\n')) {
            const formula = collapse(line);
            if (isEnumerable(formula)) push(formula, `\`\`\` ${formula} \`\`\``);
          }
          continue;
        }
        const formula = collapse(inline);
        if (isEnumerable(formula)) push(formula, `\`${formula}\``);
      }
    }
  }
  if (lines.length === 0) return '';
  return [
    'Captured formulas (hop evidence). Each block belongs in the `sections[].text` of the section that links its node — a node you keep and link keeps its formulas too:',
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
 * {@link computeFlowRoleGroups}. A kept node with no column edge is absent from the flow-role
 * buckets by construction, so it is never offered as a terminal-source candidate. The
 * reminder then also carries the {@link buildPassthroughFlowFacts} digest — grounded writer/reader
 * facts for kept nodes with no detail slot, which otherwise have no semantic content to document.
 */
interface SmCompletionEnvelope {
  readonly ok: true;
  readonly done: true;
  readonly result: {
    readonly status: SmResult['status'];
    readonly originNodeId: string;
    readonly scope: { readonly nodes: number; readonly edges: number; readonly node_ids: readonly string[] };
    readonly suggested_sections: SmResult['suggested_sections'];
    readonly node_states: SmResult['node_states'];
    readonly detail_slots: SmResult['detail_slots'];
  };
  readonly deferred_questions: ReadonlyArray<DeferredQuestion>;
  readonly synthesis_reminder: string;
}

/**
 * Assembles the {@link SmCompletionEnvelope} from a completed engine result.
 *
 * @remarks
 * The CT chain block ({@link buildCtSynthesisBlock}) is appended only when column edges were recorded;
 * it carries the terminal-source facts CT synthesis depends on. `ctPrunedNodeIds` lists the focus
 * nodes pruned via `verdict=prune` in CT.
 *
 * `result.fullNodes` is the render bound and therefore the id set `present_result` accepts: it is
 * stated as `scope.node_ids`, and `node_states[]` plus the enumerated highlight candidates are
 * filtered to it. An id the render dropped or the depth border cut still reaches the model through
 * the recorded evidence (the column chain, the detail slots) — in prose, never in a `node_ids` field.
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
  const presentedNodeIds = result.fullNodes.map(node => node.id);
  const presented = new Set(presentedNodeIds);
  const flowBlock = result.columnAspect && result.columnAspect.edges.length > 0
    ? '\n' + buildCtSynthesisBlock(result.originNodeId, result.columnAspect.edges, result.ctPrunedNodeIds, result.edges, presented)
    : result.edges.length > 0
      ? '\n' + buildBbSynthesisBlock(result.originNodeId, result.edges, presented)
      : '';
  const passthroughFacts = buildPassthroughFlowFacts(result);
  const passthroughBlock = passthroughFacts ? '\n' + passthroughFacts : '';
  const formulaFacts = buildCapturedFormulaFacts(result);
  const formulaBlock = formulaFacts ? '\n' + formulaFacts : '';
  const envelope: SmCompletionEnvelope = {
    ok: true,
    done: true,
    result: {
      status: result.status,
      originNodeId: result.originNodeId,
      scope: { nodes: presentedNodeIds.length, edges: result.edges.length, node_ids: presentedNodeIds },
      suggested_sections: result.suggested_sections,
      node_states: result.node_states.filter(state => presented.has(state.nodeId)),
      detail_slots: result.detail_slots,
    },
    deferred_questions: deferred,
    synthesis_reminder: buildSynthesisReminder(userQuestion) + flowBlock + passthroughBlock + formulaBlock,
  };
  return envelope;
}
