/**
 * Mode-scoped prompts for the navigation engine, composed from shared blocks so guidance common to
 * every mode lives once. Markdown headers give structure; XML tags protect dynamic data.
 */

import { buildColumnAspectPrompt } from '../prompting/prompts';
import { escapePromptText } from '../support/text';
import { assignEvidenceIds, requiredCtChainNodeIds, requiredDetailSlotIds } from '../tools/presentResult';
import type { ColumnEdge, DeferredQuestion, SmResult } from '../sm/smTypes';
import { schemaKey } from '../../utils/sql';

/**
 * Suffix appended when a passthrough-inherited sub-question lands on a bodied focus: names the
 * passthrough provenance and re-anchors the verbatim question onto the new focus.
 *
 * @param mode - Mode of the BRANCH the question is forwarded on, not of the session: the column
 *   clause is added only for a branch that carries a traced column.
 * @param questioned - False when the forwarded question has no text; the suffix is then the whole
 *   sub-question, names the original question and has no leading newline.
 */
export function buildPassthroughReAnchor(passthroughId: string, focusId: string, mode: 'bb' | 'ct', questioned = true): string {
  const anchor = questioned ? `re-anchor this question to ${focusId}` : `continue the original question at ${focusId}`;
  const reAnchor = `${questioned ? '\n' : ''}(Inherited through passthrough ${passthroughId}; ${anchor}. ${focusId} applies its own logic — capture the rules, calculations, and thresholds it uses to produce these values, not only which columns feed the downstream node.`;
  return mode === 'ct' ? `${reAnchor} Ground that in the traced column.)` : `${reAnchor})`;
}

/**
 * Spec-02 relevance check for a writer reached through a passthrough table whose write to the table
 * only deletes rows: that write supplies no data, so the writer gets the check, not the column task.
 * It is the whole sub-question: the inherited question is addressed to the passthrough table.
 *
 * @param columns - Columns forwarded to the passthrough; empty: the column clause is omitted.
 */
export function buildDeleteOnlyRelevanceCheck(passthroughId: string, focusId: string, columns: readonly string[]): string {
  const touch = columns.length > 0 ? `; does it touch the forwarded columns [${columns.join(', ')}]` : '';
  return `(Relevance check through passthrough ${passthroughId}: ${focusId} writes to it only by deleting rows. Does ${focusId} matter for the question at all${touch}?)`;
}

/**
 * Builds the static active-phase SM protocol block: the column aspect of the hop, rendered only
 * when the hop carries tracked columns (task and deliverable live in the active phase prompt).
 * Returns `''` for a BB hop.
 */
export function buildSmProtocol({ targetColumns }: { targetColumns?: string[] }): string {
  if (!targetColumns || targetColumns.length === 0) return '';
  return buildColumnAspectPrompt(targetColumns);
}


/**
 * Builds the synthesis reminder appended as the last key of the completion tool_result JSON: the
 * user question at the highest-attention slot, plus the one rule that belongs beside the evidence
 * (depth follows what was captured). The field skeleton lives once, in the synthesis system block.
 */
function buildSynthesisReminder(question: string): string {
  return [
    '## Answer this question',
    `"${escapePromptText(question)}"`,
    'Length follows the captured evidence, not the question: every kept node keeps its rules, predicates and formulas. Sections run in graph order — terminal sources, then each transform, then the origin and what reads it.',
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
 * Derives source/transform/target highlight buckets from graph position; BB and CT synthesis share
 * it so both bucket identically.
 *
 * `source` = a reached node data only flows OUT of (never a flow target in the trace and, CT only
 * via `hopNodes`, never a focus, since `writes_to` makes writer procs appear as `from` only) and not
 * a `borderCut` leaf: the approved border stopped the walk there, so more upstream lies beyond it.
 * `target` = the queried origin. `transform` = every other reached node.
 */
function computeFlowRoleGroups(
  originNodeId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
  hopNodes?: ReadonlySet<string>,
  borderCut?: ReadonlySet<string>,
): FlowRoleGroups {
  const toNodes = new Set(edges.map(e => e.to));
  const reached = new Set<string>([originNodeId]);
  for (const e of edges) { reached.add(e.from); reached.add(e.to); }
  const source = [...new Set(edges.map(e => e.from))]
    .filter(n => n !== originNodeId && !toNodes.has(n) && !hopNodes?.has(n) && !borderCut?.has(n));
  const sourceSet = new Set(source);
  const transform = [...reached].filter(n => n !== originNodeId && !sourceSet.has(n));
  return { source, target: [originNodeId], transform };
}

/**
 * Buckets every traced node by its DIRECTED relation to the origin. The Column Trace Chain renders
 * in hop order, not direction order, so these buckets state direction explicitly. `sideBranch`
 * matters: a node that reads a traced node but lies on no path to or from the origin is neither
 * upstream nor downstream, and calling it upstream inverts a real edge. A `delete` edge carries no
 * data, so it is no path: a node whose only traced edges are its deletes is `deleteOnly`; a node
 * that also reads or writes data stays where those edges put it.
 */
function computeDirectionGroups(
  originNodeId: string,
  edges: ReadonlyArray<{ from: string; to: string; kind?: string }>,
): { upstream: string[]; downstream: string[]; sideBranch: string[]; deleteOnly: string[] } {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const reached = new Set<string>([originNodeId]);
  const deleteWriters = new Set<string>();
  const onFlow = new Set<string>();
  for (const e of edges) {
    reached.add(e.from);
    reached.add(e.to);
    if (e.kind === 'delete') { deleteWriters.add(e.from); continue; }
    onFlow.add(e.from);
    onFlow.add(e.to);
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
  const deleteOnly = new Set([...deleteWriters].filter(n => n !== originNodeId && !onFlow.has(n)));
  const sideBranch = [...reached]
    .filter(n => n !== originNodeId && !upstream.has(n) && !downstream.has(n) && !deleteOnly.has(n));
  return { upstream: [...upstream].sort(), downstream: [...downstream].sort(), sideBranch: sideBranch.sort(), deleteOnly: [...deleteOnly].sort() };
}

/**
 * Renders the shared edge-direction lines from computed {@link computeDirectionGroups} buckets.
 * Takes the buckets, not the edges, so a caller that also branches on a bucket cannot disagree with
 * the rendered claim.
 */
function buildDirectionLines(
  originNodeId: string,
  direction: ReturnType<typeof computeDirectionGroups>,
): string[] {
  return [
    `Edge direction relative to ${originNodeId} (engine-computed; the analyzed-node list is in hop order, not flow order):`,
    `- upstream (data flows INTO the origin): ${direction.upstream.join(', ') || '(none)'}`,
    `- downstream (data flows OUT of the origin): ${direction.downstream.join(', ') || '(none)'}`,
    `- side branches (read a traced node, on no path to or from the origin; neither a source nor a consumer of the origin): ${direction.sideBranch.join(', ') || '(none)'}`,
    ...(direction.deleteOnly.length > 0
      ? [`- delete-only writers (write to a traced node only by deleting rows; supply it no data): ${direction.deleteOnly.join(', ')}`]
      : []),
  ];
}

/**
 * Renders the shared `highlight_groups` guidance lines from computed {@link FlowRoleGroups}.
 *
 * Enumerates only mechanical facts (target, terminal-source candidates); transform is deliberately
 * NOT enumerated because models transcribe enumerated lists verbatim, defeating the
 * question-relative judgment the template assigns. Candidates are bounded by `presented` (`null`:
 * no render set, bounds nothing), since `highlight_groups[].node_ids` rejects ids the render does
 * not carry.
 */
function buildFlowRoleHighlightLines(groups: FlowRoleGroups, presented: ReadonlySet<string> | null): string[] {
  const linkable = (ids: readonly string[]): string[] => presented ? ids.filter(id => presented.has(id)) : [...ids];
  return [
    `- highlight_groups.target (the queried origin): ${linkable(groups.target).join(', ')}`,
    `- highlight_groups.source candidates (upstream endpoints reached within this trace): ${linkable(groups.source).join(', ') || '(none)'}`,
  ];
}

/** Projects node-level `[from, to, kind]` edges to the flow edges the shared buckets read. */
function asFlowEdges(edges: ReadonlyArray<[string, string, string]>): Array<{ from: string; to: string; kind: string }> {
  return edges.map(([from, to, kind]) => ({ from, to, kind }));
}

/**
 * Renders the flow-role heading plus direction lines. BB synthesis is exactly this block; CT reuses
 * the same helpers and assembles them around the column-chain rider.
 */
function renderFlowRoleAndDirection(
  originNodeId: string,
  flowEdges: ReadonlyArray<{ from: string; to: string; kind?: string }>,
  presentedNodeIds: ReadonlySet<string> | null,
  borderCut?: ReadonlySet<string>,
): string {
  const groups = computeFlowRoleGroups(originNodeId, flowEdges, undefined, borderCut);
  return [
    '## Flow roles',
    ...buildFlowRoleHighlightLines(groups, presentedNodeIds),
    '',
    ...buildDirectionLines(originNodeId, computeDirectionGroups(originNodeId, flowEdges)),
  ].join('\n');
}

/**
 * BB counterpart to {@link buildCtSynthesisBlock}: grounds the `highlight_groups` buckets in the
 * traced node edges so source-bucketing is a transcription, not a guess.
 *
 * @param edges - Node-level lineage edges `[from, to, kind]` from `SmResult.edges`.
 * @param presentedNodeIds - Ids the render carries, bounding the enumerated candidates; omitted:
 *   bounds nothing.
 * @param borderCut - Ids the approved border cut (deferred leads); never listed as source candidates.
 */
export function buildBbSynthesisBlock(
  originNodeId: string,
  edges: ReadonlyArray<[string, string, string]>,
  presentedNodeIds: ReadonlySet<string> | null = null,
  borderCut?: ReadonlySet<string>,
): string {
  return renderFlowRoleAndDirection(originNodeId, asFlowEdges(edges), presentedNodeIds, borderCut);
}

/**
 * Renders the CT synthesis evidence block from validated column edges: the edges grouped by target
 * (each target and hop stated once) so `present_result` follows the actual traced path. Appended to the synthesis reminder when CT was
 * active and edges were recorded; off-trace nodes excluded by the scope filter are not listed.
 *
 * @param nodeEdges - Node-level flow edges used to tell written intermediates from base feeds.
 * @param presentedNodeIds - Ids the render carries, bounding the enumerated highlight candidates;
 *   omitted: bounds nothing. The recorded edge list is never bounded (the trace is the evidence; an
 *   endpoint outside the render is stated in prose).
 * @param borderCut - Ids the approved border cut (deferred leads); never listed as source candidates.
 */
export function buildCtSynthesisBlock(
  originNodeId: string,
  edges: ColumnEdge[],
  nodeEdges: ReadonlyArray<[string, string, string]> = [],
  presentedNodeIds: ReadonlySet<string> | null = null,
  borderCut?: ReadonlySet<string>,
): string {
  const lines = ['## Column Trace Chain'];
  if (edges.length === 0) {
    lines.push('No column edges were recorded.');
    lines.push('Structure present_result as a zero-trace answer: explain that no column-flow edge was proven, link the origin/result node in sections[], and include highlight_groups.target for that origin/result node.');
    return lines.join('\n');
  }
  const sources = new Map<string, string[]>();
  for (const e of edges) {
    const target = `  ${e.to_node}.${e.to_col} (hop ${e.hop}) ←`;
    const metadata = [
      ...(e.transforms?.length ? [`transforms: ${e.transforms.join(', ')}`] : []),
      ...(e.note ? [`expression: ${escapePromptText(e.note)}`] : []),
    ];
    sources.set(target, [...(sources.get(target) ?? []), `    ${e.from_node}.${e.from_col}${metadata.length ? ` — ${metadata.join('; ')}` : ''}`]);
  }
  lines.push(...[...sources].flat(2));
  lines.push('');
  const directionEdges = nodeEdges.length > 0
    ? asFlowEdges(nodeEdges)
    : edges.map(e => ({ from: e.from_node, to: e.to_node }));
  const direction = computeDirectionGroups(originNodeId, directionEdges);
  lines.push(...buildDirectionLines(originNodeId, direction));
  const groups = computeFlowRoleGroups(originNodeId, directionEdges,
    nodeEdges.length > 0 ? undefined : new Set(edges.map(e => e.hop_node)), borderCut);
  lines.push('');
  lines.push('A chain node that does not carry, persist or terminate the traced column gets one line on what it does to the rows: join, filter, predicate or set operation.');
  lines.push('');
  lines.push('## Flow roles');
  lines.push(...buildFlowRoleHighlightLines(groups, presentedNodeIds));
  return lines.join('\n');
}

/**
 * Per-node writer/reader facts: `writtenBy` = `from` ends of edges INTO the node, `readBy` = `to`
 * ends of edges FROM it. Both lists lowercased and id-sorted.
 */
interface NodeFlowFacts {
  /** Node ids that write INTO this node (`from` ends of inbound edges), sorted, lowercased. */
  writtenBy: string[];
  /** Node ids this node is read BY (`to` ends of outbound edges), sorted, lowercased. */
  readBy: string[];
}

/**
 * The single producer of per-node writer/reader facts for synthesis passthrough grounding
 * ({@link buildPassthroughFlowFacts}), so every caller reads byte-identical, id-sorted facts. A
 * node with no edge has no entry (rendered `(none)` by {@link renderFlowFactsFragment}).
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
 * Renders one node's flow facts as the shared `written by …; read by …` fragment; an absent entry
 * or empty list renders `(none)`, the byte-exact form the digest and note captions share.
 */
function renderFlowFactsFragment(facts: NodeFlowFacts | undefined): string {
  const list = (arr: string[] | undefined): string => (arr && arr.length > 0 ? arr.join(', ') : '(none)');
  return `written by ${list(facts?.writtenBy)}; read by ${list(facts?.readBy)}`;
}

/**
 * Renders engine flow facts for KEPT (non-pruned) nodes that received no detail slot. Their terse
 * `node_states` entry is their only trace, so without grounded facts the model drops them from
 * sections/highlights/notes.
 *
 * Facts only, from {@link SmResult.edges}, `fullNodes` (type) and `node_states` (action);
 * `fullNodes` already excludes pruned nodes. A CT dependency carrying no traced value is kept and
 * unslotted, so it appears here too. A qualifying node with no `node_states` entry was never
 * dispositioned (scope reachability alone put it in the render), so it lists under its own heading
 * with `notes[]` as the only surface; section-linking it would overstate it as evidence. Nodes and
 * neighbors sort by id, ids lowercased.
 *
 * @returns A markdown bullet list, or an empty string when every kept node is slotted.
 */
export function buildPassthroughFlowFacts(result: SmResult, identifierCaseSensitive = false): string {
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
 * backticked span. Matched left to right, so a nested delimiter is part of the outer artifact,
 * never a second entry. Group order is render order: math, fence, inline.
 */
const CAPTURED_ARTIFACT = /\$\$([\s\S]*?)\$\$|```[^\n`]*\n?([\s\S]*?)```|`([^`\n]+)`/g;

/** An identifier directly followed by `(`: the lexical mark of a call, hence a computed value. */
const CALL_TOKEN = /\w\(/;

/** A whole DML/DDL statement: it performs an action, whatever it calls along the way. */
const STATEMENT_START = /^(?:insert|update|delete|merge|truncate|exec|execute|create|alter|drop|declare|select|with|if|begin|end)\b/i;

/** The opening word of a filter condition; it decides which rows survive wherever it is nested. */
const PREDICATE_START = /^(?:where|on|having|and|or|join)\b/i;


/**
 * Enumerates the value computations and filter conditions the hops captured (`$$ … $$` blocks plus
 * the SQL that computes a value or filters rows), each keyed by the node whose detail slot holds
 * it: one `- <node>` line, then one line per formula.
 *
 * Formulas and predicates otherwise reach the model only inside slot prose it must re-scan. Only
 * delimited artifacts are read; a formula left in plain prose is not enumerated. A fenced line or
 * inline span qualifies when it carries a {@link CALL_TOKEN} or opens with a
 * {@link PREDICATE_START} keyword and is not a whole {@link STATEMENT_START} statement; a fenced
 * block is read line by line since one body mixes both classes. Output is capture-ordered and
 * de-duplicated per node (byte-stable); which blocks belong in the answer stays the model's
 * judgement.
 *
 * @returns A markdown checklist, or an empty string when no hop captured a formula.
 */
function buildCapturedFormulaFacts(result: SmResult, identifierCaseSensitive = false): string {
  const seen = new Set<string>();
  const byNode = new Map<string, string[]>();
  const collapse = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');
  const isEnumerable = (artifact: string): boolean =>
    (CALL_TOKEN.test(artifact) || PREDICATE_START.test(artifact)) && !STATEMENT_START.test(artifact);
  for (const slot of result.detail_slots) {
    const nodeId = schemaKey(slot.nodeId, identifierCaseSensitive);
    const push = (formula: string, rendered: string): void => {
      const key = `${nodeId}\u0000${formula}`;
      if (formula.length === 0 || seen.has(key)) return;
      seen.add(key);
      byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), rendered]);
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
  if (byNode.size === 0) return '';
  return [
    'Captured formulas and predicates (hop evidence) — each reappears in the text of the section that links its node:',
    ...[...byNode].flatMap(([nodeId, formulas]) => [`- ${nodeId}`, ...formulas.map(formula => `  ${formula}`)]),
  ].join('\n');
}

/**
 * The tool-result envelope delivered to synthesis when SM exploration completes: "the last tool
 * result" the synthesis system prompt reads. Single source of truth for the synthesis evidence
 * surface (the `lineage_submit_findings` completion branch and the host-graph synthesis node both
 * call its builder). {@link synthesis_reminder} carries the user-question anchor plus the flow-role
 * block, the only place the model learns which nodes are terminal sources, and the
 * {@link buildPassthroughFlowFacts} digest for kept nodes with no detail slot.
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
 * The CT chain block ({@link buildCtSynthesisBlock}) is appended only when column edges were
 * recorded. `result.fullNodes` is the render bound and so the id set `present_result` accepts: it
 * is stated as `scope.node_ids`, and `node_states[]` plus the highlight candidates are filtered to
 * it. An id the render dropped or the depth border cut still reaches the model through the recorded
 * evidence, in prose, never in a `node_ids` field.
 *
 * `detail_slots` carries a citation id appended to every fenced block's info string
 * ({@link assignEvidenceIds}, e.g. `sql S7`), numbered by slot then block order; `present_result`
 * recomputes the same ids from the same archive to expand an empty fence in place, so no id is
 * persisted across the call.
 *
 * @param deferred - The engine's deferred follow-up leads (`DeferredQuestion.reason` names why each
 *   was not visited).
 */
export function buildSmCompletionEnvelope(
  result: SmResult,
  userQuestion: string,
  deferred: ReadonlyArray<DeferredQuestion>,
  identifierCaseSensitive = false,
): SmCompletionEnvelope {
  const presentedNodeIds = result.fullNodes.map(node => node.id);
  const presented = new Set(presentedNodeIds);
  const borderCut = new Set(deferred.map(d => d.nodeId));
  const flowBlock = result.columnAspect && result.columnAspect.edges.length > 0
    ? '\n' + buildCtSynthesisBlock(result.originNodeId, result.columnAspect.edges, result.edges, presented, borderCut)
    : result.edges.length > 0
      ? '\n' + buildBbSynthesisBlock(result.originNodeId, result.edges, presented, borderCut)
      : '';
  const passthroughFacts = buildPassthroughFlowFacts(result, identifierCaseSensitive);
  const passthroughBlock = passthroughFacts ? '\n' + passthroughFacts : '';
  const formulaFacts = buildCapturedFormulaFacts(result, identifierCaseSensitive);
  const formulaBlock = formulaFacts ? '\n' + formulaFacts : '';
  const mustLink = requiredDetailSlotIds(result.detail_slots.map(slot => slot.nodeId), presented);
  const mustLinkBlock = mustLink.length > 0 ? `\nLink in \`sections[].node_ids\`: ${mustLink.join(', ')}` : '';
  const mustCover = requiredCtChainNodeIds(
    result.columnAspect?.edges ?? [], presentedNodeIds,
    [...result.detail_slots.map(slot => slot.nodeId), ...result.node_states.filter(state => state.action === 'prune').map(state => state.nodeId)],
    id => schemaKey(id, identifierCaseSensitive),
  );
  const mustCoverBlock = mustCover.length > 0 ? `\nLink in \`sections[].node_ids\` or caption in \`notes[]\`: ${mustCover.join(', ')}` : '';
  const envelope: SmCompletionEnvelope = {
    ok: true,
    done: true,
    result: {
      status: result.status,
      originNodeId: result.originNodeId,
      scope: { nodes: presentedNodeIds.length, edges: result.edges.length, node_ids: presentedNodeIds },
      suggested_sections: result.suggested_sections,
      node_states: result.node_states.filter(state => presented.has(state.nodeId)),
      detail_slots: assignEvidenceIds(result.detail_slots).slots,
    },
    deferred_questions: deferred,
    synthesis_reminder: buildSynthesisReminder(userQuestion) + flowBlock + passthroughBlock + formulaBlock + mustLinkBlock + mustCoverBlock,
  };
  return envelope;
}
