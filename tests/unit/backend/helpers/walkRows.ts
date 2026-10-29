/** Catalog walk rows (`contract: walk`): `authorReply` is the one place that turns a semantic decision into the current wire shape, and `walkRow` drives the production hop loop through the registered tools while checking every served hop. */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { createRequire } from 'node:module';
import type { WalkCase, WalkDecision } from '../../../cases/loadCases.cjs';
import type { HopNeighborDisclosure } from '../../../../src/ai/sm/smBase';
import { readToolErrorText, renderProblem, type ToolRejection } from '../../../../src/ai/support/toolErrorEnvelope';
import type { ObjectType } from '../../../../src/engine/types';
import { hopMessage, hopTools, openModelWalk, startWalk } from '../../ai-core/helpers/modelRequests';
import { makeGraph, makeIndexedModel, makeNode } from '../../helpers/modelFixtures';

const { loadCases } = createRequire(import.meta.url)('../../../cases/loadCases.cjs') as { loadCases: (runner?: string) => Array<{ contract?: string }> };

/** Every `contract: walk` row of the scripted catalog. */
export const walkRows = loadCases('scripted').filter((row): row is WalkCase => row.contract === 'walk');

const qualify = (name: string) => `[d].[${name}]`;
const shorten = (id: string) => id.replace(/^\[d\]\.\[(.*)\]$/, '$1');

/** What a decision needs to know about the hop it answers. */
export interface HopView {
  readonly focus: string;
  readonly type: ObjectType;
  readonly mode: 'bb' | 'ct';
}

/** The current wire shape of one hop reply (D-130 `column_flow` with `out_node` at a procedure). A contract change edits this function and no row. */
export function authorReply(hop: HopView, decision: WalkDecision): Record<string, unknown> {
  const name = shorten(hop.focus);
  return {
    focus_node_id: hop.focus,
    summary: `Observed ${name}`,
    sections: { technical: `SQL at ${name}` },
    ...(hop.mode === 'ct' ? { column_flow: (decision.map ?? []).map(entry => ({
      out_col: entry.col,
      ...(hop.type === 'procedure' ? { out_node: qualify(entry.to ?? '') } : {}),
      upstream_columns: entry.from.map(ref => ({ node: qualify(ref.node), col: ref.col, ...(ref.transforms ? { transforms: ref.transforms } : {}) })),
    })) } : {}),
    ...(decision.ask ? { questions: decision.ask.map(node => ({ nodeId: qualify(node), question: `Establish what ${node} contributes.` })) } : {}),
    ...(decision.prune ? { prune_neighbors: decision.prune.map(node => ({ id: qualify(node), reason: `${node} does not contribute.` })) } : {}),
  };
}

type Schema = { type?: string; enum?: unknown[]; const?: unknown; not?: object; anyOf?: Schema[]; properties?: Record<string, Schema>;
  required?: string[]; items?: Schema; minItems?: number; maxItems?: number; minLength?: number };

/** A value of a served JSON Schema built only from its own enum, const and limits; `undefined` when nothing satisfies it. */
function sampleOf(node: Schema): unknown {
  if ('const' in node) return node.const;
  if (node.enum) return node.enum[0];
  if (node.not) return undefined;
  if (node.anyOf) return node.anyOf.map(sampleOf).find(value => value !== undefined);
  if (node.type === 'string') return 'x'.repeat(Math.max(node.minLength ?? 1, 1));
  if (node.type === 'array') {
    const items = Array.from({ length: node.minItems ?? 0 }, () => (node.items ? sampleOf(node.items) : 'x'));
    return items.includes(undefined) ? undefined : items;
  }
  if (node.type === 'object') {
    const entries = (node.required ?? []).map(key => [key, sampleOf(node.properties?.[key] ?? {})] as const);
    return entries.some(([, value]) => value === undefined) ? undefined : Object.fromEntries(entries);
  }
  return node.type === 'null' ? null : node.type === 'boolean' ? false : 0;
}

/** Served lists that offer entries no allowed value can satisfy and are not capped at zero entries. */
function unsatisfiableOffers(schema: Schema): string[] {
  return Object.entries(schema.properties ?? {}).filter(([, field]) => field.type === 'array' && field.maxItems !== 0 && field.items && sampleOf(field.items) === undefined).map(([name]) => name);
}

const ajv = new Ajv2020({ strict: false });
const validators = new Map<string, ValidateFunction>();
/** One compiled validator per distinct served schema. */
function validatorFor(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) validators.set(key, validate = ajv.compile(schema));
  return validate;
}

const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });

/** The independent oracle for a walk's scope: every object reached from `origin` along the edges, `limit` levels deep. */
function directedClosure(origin: string, edges: ReadonlyArray<readonly [string, string]>, reverse: boolean, limit = Infinity): Set<string> {
  const reached = new Set([origin]);
  let frontier = [origin];
  for (let depth = 0; frontier.length && depth < limit; depth++) {
    const next = frontier.flatMap(id => edges.flatMap(([from, to]) => (reverse ? (to === id ? [from] : []) : (from === id ? [to] : []))).filter(id => !reached.has(id)));
    next.forEach(id => reached.add(id));
    frontier = [...new Set(next)];
  }
  return reached;
}

/** Name pairs `a>b` of qualified edges, sorted. */
const pairs = (edges: ReadonlyArray<readonly [string, string, ...unknown[]]>) => edges.map(([from, to]) => `${shorten(from)}>${shorten(to)}`).sort();

/** Outcome of one walk: the broken invariants (each starts with its letter) and the delivered graph. */
interface WalkOutcome {
  violations: string[];
  nodes: string[];
  edges: string[];
  columnEdges: string[];
}

/** Top-level fields whose value differs between two replies. */
const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

/**
 * Walks one row through the registered tools. `scripted` follows the row's decisions; otherwise every hop asks all
 * questionable neighbors ahead (an exploration without a prune), whose delivered graph the closure oracle fixes.
 * Per hop: (a) the served schema offers nothing unsatisfiable and admits the reply built from its own allowed values,
 * (b) the hop message names every endpoint of the current tasks, (c) a refusal's named fields are the only change its
 * correction needs, (d) the walk ends complete, every correction accepted.
 */
export async function walkRow(row: WalkCase, scripted: boolean): Promise<WalkOutcome> {
  const { graph: spec } = row;
  const nodes = Object.entries(spec.nodes).map(([name, type]) => makeNode({ id: qualify(name), schema: 'd', name, type,
    columns: type === 'procedure' ? [] : spec.columns.map(column), ...(type === 'table' ? {} : { bodyScript: `-- ${name}` }) }));
  const edges = spec.edges.map(([from, to]) => [qualify(from), qualify(to)] as [string, string]);
  const walk = openModelWalk(makeIndexedModel(nodes, edges), makeGraph(nodes, edges));
  const up = row.direction === 'upstream', depth = spec.levels ?? 'all';
  const engine = startWalk(walk, { origin: qualify(spec.origin), question: `Trace ${spec.columns.join(', ')}`, analysisMode: row.mode, direction: row.direction,
    ...(row.mode === 'ct' ? { targetColumns: spec.columns } : {}), excludeNodeIds: (spec.excluded ?? []).map(qualify),
    depthIntent: { upstream: { levels: up ? depth : 0, exactness: 'exact' }, downstream: { levels: up ? 0 : depth, exactness: 'exact' } } }, 'technical');
  const violations: string[] = [];
  engine.getHopContext();
  for (let step = 0; engine.status === 'awaiting_findings' && step <= nodes.length + 1; step++) {
    const focus = engine.currentFocus!, name = shorten(focus);
    const view: HopView = { focus, type: nodes.find(node => node.id === focus)!.type, mode: engine.currentHopAnalysisMode };
    const neighbors = (engine.peekHopContext()!.neighbors ?? []) as unknown as readonly HopNeighborDisclosure[];
    const ahead = neighbors.filter(neighbor => neighbor.can_question && !neighbor.out_of_direction).map(neighbor => shorten(neighbor.id));
    const schema = hopTools(walk).find(tool => tool.name === 'lineage_submit_findings')!.inputSchema as Schema;
    for (const field of unsatisfiableOffers(schema)) violations.push(`(a) ${name}: ${field} offers entries no allowed value satisfies`);
    const canonical = authorReply(view, { ask: neighbors.filter(neighbor => neighbor.can_question).map(neighbor => shorten(neighbor.id)) });
    if (!validatorFor(schema)(canonical)) violations.push(`(a) ${name}: the reply built from the allowed values is not admitted by the served schema`);
    const message = hopMessage(walk);
    for (const task of engine.getCurrentTasks().filter(candidate => candidate.kind === 'column_lineage')) {
      const refs: ReadonlyArray<{ node: string; col: string }> = task.sourceRefs ?? task.returnTargets ?? (task.nodeId === qualify(spec.origin) ? task.activeColumns.map(col => ({ node: qualify(spec.origin), col })) : []);
      if (refs.length === 0) violations.push(`(b) ${name}: a column task carries no endpoint`);
      for (const ref of refs) if (!message.includes(`${ref.node}.${ref.col}`) && !message.includes(`\`${ref.col}\` at \`${ref.node}\``)) violations.push(`(b) ${name}: the message omits ${shorten(ref.node)}.${ref.col}`);
    }
    const hop = scripted ? row.hops[step] : { at: name, decide: { ask: ahead, map: [] } };
    if (hop?.at !== name) { violations.push(`(d) the walk reached ${name} where the row expects ${hop?.at}`); break; }
    if ('refuse' in hop && hop.refuse) {
      const refused = authorReply(view, hop.refuse);
      const rejection = readToolErrorText(await walk.registry.invoke('lineage_submit_findings', refused)) as ToolRejection | null;
      if (!rejection) violations.push(`(c) ${name}: the reply the row refuses was accepted`);
      else {
        if (rejection.code !== hop.refuse.kind || !rejection.errors.some(error => error.path === hop.refuse!.field && error.code === hop.refuse!.issue)) {
          violations.push(`(c) ${name}: expected ${hop.refuse.kind} ${hop.refuse.issue} at ${hop.refuse.field}, got ${rejection.code} ${JSON.stringify(rejection.errors)}`);
        }
        const named = new Set([...rejection.errors.map(error => error.path.split('.')[0]), ...(JSON.parse(renderProblem(rejection, 3, refused)) as { resend: string[] }).resend]);
        const extra = changedFields(refused, authorReply(view, hop.decide)).filter(field => !named.has(field));
        if (extra.length) violations.push(`(c) ${name}: the correction changes ${extra.join(', ')}, which the rejection does not name`);
      }
    }
    const result = JSON.parse(await walk.registry.invoke('lineage_submit_findings', authorReply(view, hop.decide))) as Record<string, unknown>;
    if (result.ok !== true) { violations.push(`(d) ${name}: the reply was not accepted: ${JSON.stringify(result.errors ?? result)}`); break; }
  }
  if (engine.status !== 'complete') violations.push(`(d) the walk ended in status ${engine.status}`);
  else if (scripted && row.hops.length !== engine.toJSON().visited.filter(id => spec.nodes[shorten(id)] !== 'table').length) violations.push('(d) the row scripts a different number of hops than the walk ran');
  const done = engine.status === 'complete' ? engine.getResult() : null;
  return { violations, nodes: done ? done.fullNodes.map(node => shorten(node.id)).sort() : [], edges: done ? pairs(done.edges) : [],
    columnEdges: done?.columnAspect ? done.columnAspect.edges.map(edge => `${shorten(edge.from_node)}.${edge.from_col}>${shorten(edge.to_node)}.${edge.to_col}`).sort() : [] };
}

/** The graph the closure oracle expects after a walk that prunes nothing. */
export function closureOutcome(row: WalkCase): { nodes: string[]; edges: string[] } {
  const { edges, origin, excluded = [], levels } = row.graph;
  const eligible = edges.filter(([from, to]) => !excluded.includes(from) && !excluded.includes(to));
  const reached = directedClosure(origin, eligible, row.direction === 'upstream', levels);
  return { nodes: [...reached].sort(), edges: eligible.filter(([from, to]) => reached.has(from) && reached.has(to)).map(([from, to]) => `${from}>${to}`).sort() };
}
