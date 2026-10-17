/** Mode-scoped prompts for the navigation engine. */

import { buildColumnAspectPrompt } from './prompts';
import { escapePromptText } from '../support/text';
import { assignEvidenceIds, requiredCtChainNodeIds } from '../tools/presentResult';
import type { ColumnEdge, SmResult } from '../sm/smTypes';
import { schemaKey } from '../../utils/sql';

/** Builds the static active-phase SM protocol block: the column aspect of the hop, rendered only when the hop carries tracked columns. */
export function buildSmProtocol({ targetColumns }: { targetColumns?: string[] }): string {
  if (!targetColumns || targetColumns.length === 0) return '';
  return buildColumnAspectPrompt(targetColumns);
}


/** Builds the synthesis reminder appended as the last key of the completion tool_result JSON. */
function buildSynthesisReminder(question: string): string {
  return [
    '## Answer this question',
    `"${escapePromptText(question)}"`,
  ].join('\n');
}


/** Source/transform/target highlight buckets derived from graph position. */
interface FlowRoleGroups {
  /** Upstream endpoint candidates: reached nodes data only flows out of within the trace. */
  source: string[];
  /** The queried origin node — the answer anchor. */
  target: string[];
  /** Every other reached node on the path. */
  transform: string[];
}

/** Derives source/transform/target highlight buckets from graph position — the single computation BB and CT synthesis both use, so the two modes bucket identically (no per-mode clone). */
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

/** Buckets every traced node by its DIRECTED relation to the origin. */
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

/** Renders the shared edge-direction lines from computed {@link computeDirectionGroups} buckets. */
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

/** Renders the shared `highlight_groups` guidance lines from computed {@link FlowRoleGroups}. */
function buildFlowRoleHighlightLines(groups: FlowRoleGroups, presented: ReadonlySet<string>): string[] {
  const linkable = (ids: readonly string[]): string[] => ids.filter(id => presented.has(id));
  return [
    `- highlight_groups.target (the queried object): ${linkable(groups.target).join(', ')}`,
    `- highlight_groups.source candidates (upstream endpoints reached within this trace; use retained SQL findings to describe their dependencies): ${linkable(groups.source).join(', ') || '(none)'}`,
  ];
}

/** Projects node-level `[from, to, kind]` edges to the `{from, to}` flow the shared buckets read. */
function asFlowEdges(edges: ReadonlyArray<[string, string, string]>): Array<{ from: string; to: string }> {
  return edges.map(([from, to]) => ({ from, to }));
}

/** BB-mode counterpart to {@link buildCtSynthesisBlock}: grounds the `highlight_groups` buckets in the traced node edges so BB source-bucketing is a transcription, not a guess. Both modes share the highlight and direction helpers, so they bucket identically. */
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

/** Renders the CT-specific synthesis evidence block from validated column edges. */
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

/** Per-node writer/reader graph facts — `writtenBy` = the `from` ends of edges INTO the node, `readBy` = the `to` ends of edges FROM it. Both lists lowercased and id-sorted. */
interface NodeFlowFacts {
  /** Node ids that write INTO this node (`from` ends of inbound edges), sorted, lowercased. */
  writtenBy: string[];
  /** Node ids this node is read BY (`to` ends of outbound edges), sorted, lowercased. */
  readBy: string[];
}

/** The single producer of per-node writer/reader flow facts for synthesis grounding ({@link buildAnalyzedFlowFacts} and {@link buildPassthroughFlowFacts}) so every caller reads byte-identical, deterministically-sorted facts (no per-caller re-derivation). */
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

/** Renders one node's flow facts as the shared `inputs: …; outputs: …` fragment: data flows from each input into the node and from the node into each output, whatever the object types (a procedure's inputs are what it reads, its outputs what it writes). An absent entry or empty list renders `(none)` — the byte-exact form the analyzed-node and passthrough digests share. */
function renderFlowFactsFragment(facts: NodeFlowFacts | undefined): string {
  const list = (arr: string[] | undefined): string => (arr && arr.length > 0 ? arr.join(', ') : '(none)');
  return `inputs: ${list(facts?.writtenBy)}; outputs: ${list(facts?.readBy)}`;
}

/** Renders engine flow facts for KEPT (non-pruned) nodes that received no detail slot — the envelope carries no other entry for them, so without grounded graph facts the model has nothing to state about them and drops them from sections/highlights/notes. */
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


/** Renders engine flow facts for every analyzed node the render keeps, so synthesis reads the directed edges between hops instead of inferring them from slot prose. */
function buildAnalyzedFlowFacts(result: SmResult, presented: ReadonlySet<string>, identifierCaseSensitive = false): string {
  const lc = (s: string): string => schemaKey(s, identifierCaseSensitive);
  const flowFacts = computeNodeFlowFacts(result.edges, identifierCaseSensitive);
  const lines = result.detail_slots
    .filter(slot => presented.has(slot.nodeId))
    .map(slot => `- ${lc(slot.nodeId)} — ${slot.type}: ${renderFlowFactsFragment(flowFacts.get(lc(slot.nodeId)))}`);
  return lines.length > 0 ? ['Analyzed nodes (engine flow facts):', ...lines].join('\n') : '';
}

/** The tool-result envelope delivered to synthesis when SM exploration completes — "the last tool result" the synthesis system prompt reads. */
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

/** Assembles the {@link SmCompletionEnvelope} from a completed engine result. */
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
