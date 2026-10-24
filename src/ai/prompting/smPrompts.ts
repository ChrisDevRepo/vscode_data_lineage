/** Mode-scoped prompts for the navigation engine. */

import { buildColumnAspectPrompt } from './prompts';
import { escapePromptText } from '../support/text';
import { assignEvidenceIds, requiredCtChainNodeIds } from '../tools/presentResult';
import type { ColumnEdge, DeferredQuestion, SmResult } from '../sm/smTypes';
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
    'Length follows the captured evidence, not the question: every kept node keeps its rules, predicates and formulas. Sections run in graph order — terminal sources, then each transform, then the origin and what reads it. State each default, fallback, correction and dedup or aggregation choice that changes a value on the traced path, with its condition. Name base tables at every level the evidence shows: those the object reads directly and the terminal origins behind them. A statement about the whole chain must hold for every captured node.',
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
    `- side branches (connected nodes on no directed path to or from the origin): ${direction.sideBranch.join(', ') || '(none)'}`,
  ];
}

/** Renders the shared `highlight_groups` guidance lines from computed {@link FlowRoleGroups}. */
function buildFlowRoleHighlightLines(groups: FlowRoleGroups, presented: ReadonlySet<string>): string[] {
  const linkable = (ids: readonly string[]): string[] => ids.filter(id => presented.has(id));
  return [
    `- highlight_groups entry with color "target" (the queried object): ${linkable(groups.target).join(', ')}`,
    `- highlight_groups entry with color "source", candidates (upstream endpoints reached within this trace; use retained SQL findings to describe their dependencies): ${linkable(groups.source).join(', ') || '(none)'}`,
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
 * Every other mandatory-carry class at synthesis is enumerated as a checklist; formulas and
 * predicates otherwise reach the model only inside slot prose it must re-scan. Only delimited
 * artifacts are read — a formula the hop writer left in plain prose is not enumerated. Within a
 * delimited artifact, content decides what is enumerable: a fenced line or inline span qualifies when it
 * carries a {@link CALL_TOKEN} or opens with a {@link PREDICATE_START} keyword and is not a whole
 * {@link STATEMENT_START} statement; a fenced block is read line by line since one body mixes both
 * classes. Enumeration only — sorted by capture order and de-duplicated per node for byte-stable
 * output; which blocks belong in the answer stays the model's judgement.
 *
 * @param result - Completed SM result; `detail_slots[].sections[].text` is the captured archive.
 * @returns A markdown checklist, or an empty string when no hop captured a formula.
 */
function buildCapturedFormulaFacts(result: SmResult, identifierCaseSensitive = false): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  const collapse = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');
  const isEnumerable = (artifact: string): boolean =>
    (CALL_TOKEN.test(artifact) || PREDICATE_START.test(artifact)) && !STATEMENT_START.test(artifact);
  for (const slot of result.detail_slots) {
    const nodeId = schemaKey(slot.nodeId, identifierCaseSensitive);
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
    'Captured formulas and predicates (hop evidence) — each reappears in the text of the section that links its node:',
    ...lines,
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
    readonly scope: { readonly nodes: number; readonly edges: number; readonly node_ids: readonly string[] };
    readonly suggested_sections: ReadonlyArray<{ label: string; node_ids: string[] }>;
    readonly node_states: SmResult['node_states'];
    readonly detail_slots: SmResult['detail_slots'];
    readonly deferred_questions?: readonly DeferredQuestion[];
  };
  readonly synthesis_reminder: string;
}

/** Starting-point stage grouping: the origin first, then the nodes at each undirected edge distance from it. A node the edges do not reach from the origin is left out; the model still carries it from `scope.node_ids`. */
function buildSuggestedSections(
  result: SmResult,
  presentedNodeIds: readonly string[],
): Array<{ label: string; node_ids: string[] }> {
  const adjacent = new Map<string, string[]>();
  for (const [from, to] of result.edges) {
    adjacent.set(from, [...(adjacent.get(from) ?? []), to]);
    adjacent.set(to, [...(adjacent.get(to) ?? []), from]);
  }
  const depth = new Map<string, number>([[result.originNodeId, 0]]);
  const queue = [result.originNodeId];
  for (const id of queue) {
    for (const next of adjacent.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(id)! + 1);
      queue.push(next);
    }
  }
  const sections: Array<{ label: string; node_ids: string[] }> = [];
  for (let level = 0; level <= Math.max(...depth.values()); level++) {
    const ids = presentedNodeIds.filter(id => depth.get(id) === level);
    if (ids.length > 0) sections.push({ label: level === 0 ? 'Origin' : `Stage ${level}`, node_ids: ids });
  }
  return sections;
}

/** Assembles the {@link SmCompletionEnvelope} from a completed engine result. */
export function buildSmCompletionEnvelope(
  result: SmResult,
  userQuestion: string,
  identifierCaseSensitive = false,
  deferredQuestions: readonly DeferredQuestion[] = [],
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
  const formulaFacts = buildCapturedFormulaFacts(result, identifierCaseSensitive);
  const formulaBlock = formulaFacts ? '\n' + formulaFacts : '';
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
      scope: { nodes: presentedNodeIds.length, edges: result.edges.length, node_ids: presentedNodeIds },
      suggested_sections: buildSuggestedSections(result, presentedNodeIds),
      node_states: result.node_states.filter(state => presented.has(state.nodeId)),
      detail_slots: assignEvidenceIds(result.detail_slots).slots,
      ...(deferredQuestions.length ? { deferred_questions: deferredQuestions } : {}),
    },
    synthesis_reminder: buildSynthesisReminder(userQuestion) + flowBlock + analyzedBlock + passthroughBlock + formulaBlock + mustCoverBlock,
  };
}
