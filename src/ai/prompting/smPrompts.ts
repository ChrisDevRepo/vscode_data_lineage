/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Following a hybrid Markdown + XML strategy: Markdown headers provide structural context
 * for GPT/Gemini, while XML tags protect high-risk dynamic data for precision in reasoning models.
 */

import { buildColumnAspectPrompt } from './prompts';
import { escapePromptText } from '../support/text';
import { assignEvidenceIds, requiredCtChainNodeIds } from '../tools/presentResult';
import type { ColumnEdge, SmResult } from '../sm/smTypes';
import { schemaKey } from '../../utils/sql';

/**
 * Re-anchor sentence for a passthrough-inherited sub-question that lands on a bodied focus.
 *
 * @remarks
 * `enqueueHop` forwards the authored question verbatim and stores this sentence beside it on the
 * investigation task (`InvestigationTask.reAnchor`), never inside the question: the receiving hop's
 * `<current_task>` renders it on the line after the question, and synthesis receives the authored
 * question only. It names the passthrough provenance and re-anchors the question onto the new
 * focus. The column clause is gated on the branch: one carrying none of the traced columns has no
 * column to ground an answer in, and asking it for one is the dead-end instruction.
 *
 * @param passthroughId - The non-bodied node the question was inherited through.
 * @param focusId - The bodied neighbor the question re-anchors onto.
 * @param mode - The mode of the BRANCH this question is forwarded on, not of the session: the
 *   column clause is answerable only where a traced column is actually carried, and a CT session
 *   reaches branches that carry none.
 * @param questioned - Whether the forwarded question has text. When it has none, the sentence is
 *   the whole sub-question, so it names the original question instead of pointing at a question
 *   that is not there.
 * @returns The re-anchor sentence, without a leading newline.
 */
export function buildPassthroughReAnchor(passthroughId: string, focusId: string, mode: 'bb' | 'ct', questioned = true): string {
  const anchor = questioned ? `re-anchor this question to ${focusId}` : `continue the original question at ${focusId}`;
  const reAnchor = `(Inherited through passthrough ${passthroughId}; ${anchor}. ${focusId} applies its own logic — capture the rules, calculations, and thresholds it uses to produce these values, not only which columns feed the downstream node.`;
  return mode === 'ct' ? `${reAnchor} Ground that in the traced column.)` : `${reAnchor})`;
}

/**
 * Builds the static active-phase SM protocol block: the column aspect of the hop, rendered only
 * when the hop carries tracked columns.
 *
 * @remarks
 * The hop's task and deliverable are the same with or without tracked columns and live in the
 * active phase prompt (`buildActivePhasePrompt`, `prompts.ts`); field meanings live in the
 * `submit_findings` schema. A hop without target columns therefore gets no block here.
 *
 * @param targetColumns - The columns being traced; absent or empty for a BB hop.
 * @returns The CT column-aspect block, or `''` for a BB hop.
 */
export function buildSmProtocol({ targetColumns }: { targetColumns?: string[] }): string {
  if (!targetColumns || targetColumns.length === 0) return '';
  return buildColumnAspectPrompt(targetColumns);
}


/**
 * Builds the synthesis reminder appended as the last key of the completion tool_result JSON.
 *
 * @remarks
 * Anchored on the user question at the highest-attention slot (long-context models attend most
 * strongly to the window edges). Depth, order and the field skeleton live once, in the synthesis
 * system block and the `lineage_present_result` describes; the engine facts appended after this
 * anchor are the content.
 *
 * @param question - The user's original question, re-injected to anchor synthesis on intent.
 */
function buildSynthesisReminder(question: string): string {
  return [
    '## Answer this question',
    `"${escapePromptText(question)}"`,
  ].join('\n');
}


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
 * only, via `hopNodes` — never itself a focus, since `writes_to` makes writer procs appear as
 * `from` only). `target` = the queried origin. `transform` = every other reached node.
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
 * Takes the computed buckets rather than the edges, so a caller that also branches on a bucket
 * reads the same object these lines state and cannot disagree with the rendered claim.
 *
 * @param originNodeId - The queried origin the buckets are relative to.
 * @param direction - Buckets from {@link computeDirectionGroups} for that origin.
 */
function buildDirectionLines(
  originNodeId: string,
  direction: ReturnType<typeof computeDirectionGroups>,
): string[] {
  return [
    `Edge direction relative to ${originNodeId} (engine-computed; the analyzed-node list is in hop order, not flow order):`,
    `- upstream (data flows INTO the origin): ${direction.upstream.join(', ') || '(none)'}`,
    `- downstream (data flows OUT of the origin): ${direction.downstream.join(', ') || '(none)'}`,
    `- side branches (read a traced node, on no path to or from the origin): ${direction.sideBranch.join(', ') || '(none)'}`,
  ];
}

/**
 * Renders the shared `highlight_groups` guidance lines from computed {@link FlowRoleGroups}.
 *
 * @remarks
 * Enumerates only mechanical facts (target, terminal-source candidates) — transform is
 * deliberately NOT enumerated: models transcribe enumerated lists verbatim, defeating the
 * question-relative judgment the highlights template assigns the AI. Candidates are bounded by
 * the presented set, since `highlight_groups[].node_ids` rejects anything the render does not carry.
 *
 * @param groups - Mechanically computed flow-role buckets.
 * @param presented - Ids the render carries; a bucket member outside it is dropped from the line.
 */
function buildFlowRoleHighlightLines(groups: FlowRoleGroups, presented: ReadonlySet<string>): string[] {
  const linkable = (ids: readonly string[]): string[] => ids.filter(id => presented.has(id));
  return [
    `- highlight_groups.target (the queried origin): ${linkable(groups.target).join(', ')}`,
    `- highlight_groups.source candidates (terminal origins this trace reached): ${linkable(groups.source).join(', ') || '(none)'}`,
  ];
}

/** Projects node-level `[from, to, kind]` edges to the `{from, to}` flow the shared buckets read. */
function asFlowEdges(edges: ReadonlyArray<[string, string, string]>): Array<{ from: string; to: string }> {
  return edges.map(([from, to]) => ({ from, to }));
}

/**
 * BB-mode counterpart to {@link buildCtSynthesisBlock}: grounds the `highlight_groups` buckets in the
 * traced node edges so BB source-bucketing is a transcription, not a guess. Both modes share the
 * highlight and direction helpers, so they bucket identically.
 *
 * @param originNodeId - The queried origin (the `target` node).
 * @param edges - Node-level lineage edges `[from, to, kind]` from `SmResult.edges`.
 * @param presentedNodeIds - Ids the render carries, bounding the enumerated candidates.
 */
function buildBbSynthesisBlock(
  originNodeId: string,
  edges: ReadonlyArray<[string, string, string]>,
  presentedNodeIds: ReadonlySet<string>,
): string {
  const flowEdges = asFlowEdges(edges);
  return [
    '## Flow roles',
    ...buildFlowRoleHighlightLines(computeFlowRoleGroups(originNodeId, flowEdges), presentedNodeIds),
    '',
    ...buildDirectionLines(originNodeId, computeDirectionGroups(originNodeId, flowEdges)),
  ].join('\n');
}

/**
 * Renders the CT-specific synthesis evidence block from validated column edges.
 *
 * @remarks
 * Appended to the synthesis reminder when CT was active and at least one edge was recorded; a CT
 * run with none renders the BB block instead. Presents the directed graph in a flat edge list so
 * the AI can structure `present_result` around the actual traced path rather than free-form prose.
 * Off-trace nodes excluded by the scope filter are not listed here.
 *
 * @param originNodeId - The queried origin node that should be treated as the answer target.
 * @param edges - Validated column-flow edges accumulated by the engine; non-empty.
 * @param nodeEdges - Node-level flow edges used to distinguish written intermediates from base
 *   feeds; when empty, direction is read from the column edges instead.
 * @param presentedNodeIds - Ids the render carries, bounding the enumerated highlight candidates.
 *   The recorded edge list itself is never bounded — the trace is the evidence, and an endpoint
 *   outside the render is stated in prose.
 * @returns Markdown instructions/evidence for the final `lineage_present_result` turn.
 */
function buildCtSynthesisBlock(
  originNodeId: string,
  edges: readonly ColumnEdge[],
  nodeEdges: ReadonlyArray<[string, string, string]>,
  presentedNodeIds: ReadonlySet<string>,
): string {
  const lines = ['## Column Trace Chain'];
  for (const e of edges) {
    const metadata = [
      ...(e.transforms?.length ? [`transforms: ${e.transforms.join(', ')}`] : []),
      ...(e.note ? [`expression: ${escapePromptText(e.note)}`] : []),
    ];
    lines.push(`  ${e.from_node}.${e.from_col} → ${e.to_node}.${e.to_col} (hop ${e.hop})${metadata.length ? ` — ${metadata.join('; ')}` : ''}`);
  }
  lines.push('');
  const directionEdges = nodeEdges.length > 0
    ? asFlowEdges(nodeEdges)
    : edges.map(e => ({ from: e.from_node, to: e.to_node }));
  const direction = computeDirectionGroups(originNodeId, directionEdges);
  lines.push(...buildDirectionLines(originNodeId, direction));
  const groups = computeFlowRoleGroups(originNodeId, directionEdges,
    nodeEdges.length > 0 ? undefined : new Set(edges.map(e => e.hop_node)));
  lines.push('');
  lines.push('A chain node that does not carry, persist or terminate the traced column gets one line on what it does to the rows: join, filter, predicate or set operation.');
  lines.push('');
  lines.push('## Flow roles');
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
 * The single producer of per-node writer/reader flow facts for synthesis grounding
 * ({@link buildAnalyzedFlowFacts} and {@link buildPassthroughFlowFacts}) so every caller reads byte-identical, deterministically-sorted
 * facts (no per-caller re-derivation).
 *
 * @remarks
 * Facts only: writers/readers come purely from the node-level edge list. A node with no inbound or
 * outbound edge simply has no map entry (callers render it as `(none)` via
 * {@link renderFlowFactsFragment}). Ids are lowercased and neighbor lists id-sorted for determinism.
 *
 * @param edges - Node-level `[from, to, kind]` flow edges from {@link SmResult.edges}.
 */
function computeNodeFlowFacts(edges: ReadonlyArray<[string, string, string]>, identifierCaseSensitive = false): Map<string, NodeFlowFacts> {
  const lc = (s: string): string => schemaKey(s, identifierCaseSensitive);
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
 * Renders one node's flow facts as the shared `inputs: …; outputs: …` fragment: data flows from each
 * input into the node and from the node into each output, whatever the object types (a procedure's
 * inputs are what it reads, its outputs what it writes). An absent entry or empty list renders
 * `(none)` — the byte-exact form the analyzed-node and passthrough digests share.
 */
function renderFlowFactsFragment(facts: NodeFlowFacts | undefined): string {
  const list = (arr: string[] | undefined): string => (arr && arr.length > 0 ? arr.join(', ') : '(none)');
  return `inputs: ${list(facts?.writtenBy)}; outputs: ${list(facts?.readBy)}`;
}

/**
 * Renders engine flow facts for KEPT (non-pruned) nodes that received no detail slot — the
 * envelope carries no other entry for them, so without grounded graph facts the model has nothing
 * to state about them and drops them from sections/highlights/notes.
 *
 * @remarks
 * Facts only, derived from {@link SmResult.edges} (`inputs`/`outputs`), `fullNodes` (type) and
 * `node_states` (action). `fullNodes` already excludes pruned nodes; the explicit `prune` filter
 * here is belt-and-suspenders. A CT dependency carrying no traced value is kept and unslotted, so
 * it surfaces here too. A qualifying node with no `node_states` entry was never dispositioned —
 * scope reachability alone put it in the render — so it lists under its own heading with
 * `notes[]` as the only surface; section-linking it would overstate it as evidence. Deterministic:
 * nodes and neighbor lists sort by id, ids lowercased.
 *
 * @param result - Completed SM result: `fullNodes` the rendered kept set, `detail_slots` the
 * analyzed subset, `edges` the node-level `[from, to, kind]` flow, `node_states` the actions.
 * @returns A markdown bullet list of input/output facts, or an empty string when every kept node is slotted.
 */
function buildPassthroughFlowFacts(result: SmResult, identifierCaseSensitive = false): string {
  const lc = (s: string): string => schemaKey(s, identifierCaseSensitive);
  const slottedIds = new Set(result.detail_slots.map(s => lc(s.nodeId)));
  const prunedIds = new Set(result.node_states.filter(s => s.action === 'prune').map(s => lc(s.nodeId)));
  const actionById = new Map(result.node_states.map(s => [lc(s.nodeId), s.action]));
  const flowFacts = computeNodeFlowFacts(result.edges, identifierCaseSensitive);

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
    'Kept nodes without a detail slot (engine flow facts). Document each in the section of its writer or reader — what it holds for this flow, the predicate it is read or written under, the row grain it lands at, from that writer\'s or reader\'s captured SQL — and give it a `sections[].node_ids` or `notes[].node_id` entry:',
    ...dispositioned.map(renderLine),
    ...(undispositioned.length > 0
      ? [
        'In scope but never dispositioned (no hop analyzed, routed to or pruned them) — `notes[]` alone is their surface, not a section or a highlight group:',
        ...undispositioned.map(renderLine),
      ]
      : []),
  ].join('\n');
}


/**
 * Renders engine flow facts for every analyzed node the render keeps, so synthesis reads the
 * directed edges between hops instead of inferring them from slot prose.
 *
 * @param result - Completed SM result: `detail_slots` the analyzed nodes, `edges` the node-level flow.
 * @param presented - Ids the render carries; a slot outside it is not listed.
 * @returns A markdown bullet list, or an empty string when no analyzed node is rendered.
 */
function buildAnalyzedFlowFacts(result: SmResult, presented: ReadonlySet<string>, identifierCaseSensitive = false): string {
  const lc = (s: string): string => schemaKey(s, identifierCaseSensitive);
  const flowFacts = computeNodeFlowFacts(result.edges, identifierCaseSensitive);
  const lines = result.detail_slots
    .filter(slot => presented.has(slot.nodeId))
    .map(slot => `- ${lc(slot.nodeId)} — ${slot.type}: ${renderFlowFactsFragment(flowFacts.get(lc(slot.nodeId)))}`);
  return lines.length > 0 ? ['Analyzed nodes (engine flow facts):', ...lines].join('\n') : '';
}

/**
 * The tool-result envelope delivered to synthesis when SM exploration completes — "the last tool
 * result" the synthesis system prompt reads.
 *
 * @remarks
 * Single source of truth for the synthesis evidence surface; both the `lineage_submit_findings`
 * completion branch and the host-graph synthesis node call this builder. It carries the archived
 * hop findings, the id set `present_result` accepts and {@link synthesis_reminder}: the
 * user-question anchor plus the rendered flow-role block (BB from node edges, CT from column edges
 * plus the Column Trace Chain), the inputs and outputs of every analyzed node
 * ({@link buildAnalyzedFlowFacts}) and the {@link buildPassthroughFlowFacts} digest for kept nodes
 * with no detail slot. Section, depth and order rules live in the synthesis system prompt; the reminder
 * carries engine facts and the coverage rules tied to its own id lists.
 */
interface SmCompletionEnvelope {
  readonly ok: true;
  readonly done: true;
  readonly result: {
    readonly originNodeId: string;
    readonly scope: { readonly node_ids: readonly string[] };
    readonly detail_slots: SmResult['detail_slots'];
  };
  readonly synthesis_reminder: string;
}

/**
 * Assembles the {@link SmCompletionEnvelope} from a completed engine result.
 *
 * @remarks
 * The CT chain block ({@link buildCtSynthesisBlock}) is appended only when column edges were
 * recorded. `result.fullNodes` is the render bound and therefore the id set `present_result`
 * accepts: it is stated as `scope.node_ids`, and the enumerated highlight candidates are filtered
 * to it. An id the render dropped or the depth border cut still reaches the model through the
 * recorded evidence, in prose, never in a `node_ids` field.
 *
 * `detail_slots` is delivered with a citation id appended to every fenced code block's own fence
 * info string ({@link assignEvidenceIds}, e.g. `sql S7`), numbered by detail-slot order then block
 * order — `present_result` recomputes the same id set from the same archive to expand an empty
 * ```` ```sql S7 ```` fence in place, so a reference resolves without any id persisted across the call.
 *
 * @param result - The completed `engine.getResult()` archive (full `detail_slots` across all hops).
 * @param userQuestion - The verbatim mission question anchoring the synthesis reminder.
 */
export function buildSmCompletionEnvelope(
  result: SmResult,
  userQuestion: string,
  identifierCaseSensitive = false,
): SmCompletionEnvelope {
  const presentedNodeIds = result.fullNodes.map(node => node.id);
  const presented = new Set(presentedNodeIds);
  const flowBlock = result.columnAspect && result.columnAspect.edges.length > 0
    ? '\n' + buildCtSynthesisBlock(result.originNodeId, result.columnAspect.edges, result.edges, presented)
    : result.edges.length > 0
      ? '\n' + buildBbSynthesisBlock(result.originNodeId, result.edges, presented)
      : '';
  const analyzedFacts = buildAnalyzedFlowFacts(result, presented, identifierCaseSensitive);
  const analyzedBlock = analyzedFacts ? '\n' + analyzedFacts : '';
  const passthroughFacts = buildPassthroughFlowFacts(result, identifierCaseSensitive);
  const passthroughBlock = passthroughFacts ? '\n' + passthroughFacts : '';
  const mustCover = requiredCtChainNodeIds(
    result.columnAspect?.edges ?? [], presentedNodeIds,
    [...result.detail_slots.map(slot => slot.nodeId), ...result.node_states.filter(state => state.action === 'prune').map(state => state.nodeId)],
    id => schemaKey(id, identifierCaseSensitive),
  );
  const mustCoverBlock = mustCover.length > 0 ? `\nLink in \`sections[].node_ids\` or caption in \`notes[]\`: ${mustCover.join(', ')}` : '';
  return {
    ok: true,
    done: true,
    result: {
      originNodeId: result.originNodeId,
      scope: { node_ids: presentedNodeIds },
      detail_slots: assignEvidenceIds(result.detail_slots).slots,
    },
    synthesis_reminder: buildSynthesisReminder(userQuestion) + flowBlock + analyzedBlock + passthroughBlock + mustCoverBlock,
  };
}
