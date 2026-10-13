/**
 * Synthetic object-level (BB) worlds for tests/unit/sm/bb-*.test.ts.
 *
 * NOT a test file. A world is a named graph and an approved depth per side; the direction is
 * derived from the depth exactly as the tool boundary derives it, so no test can state a
 * direction the product never forwards.
 */
import { NavigationEngine } from '../../../../src/ai/sm/smBase';
import type { DepthIntent } from '../../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../../src/engine/shared/explorationDepthContract';
import type { DatabaseModel, ObjectType } from '../../../../src/engine/types';
import { makeGraph } from '../../helpers/testUtils';
import { makeModel, makeNode } from './fixtures';

/** One side of the approved depth. */
export type DepthSide = DepthIntent['upstream'];

/** What one scripted hop tells the engine about its neighbours. */
export interface HopScript { prune?: string[]; ask?: string[] }

/** A built world: the engine after `init`, its runtime handles and the captured host log. */
export interface BbWorld {
  engine: NavigationEngine;
  model: DatabaseModel;
  graph: ReturnType<typeof makeGraph>;
  logs: string[];
  /** Sorted ids of the engine's current scope. */
  scope: () => string[];
  /** Pending follow-up leads as `node:reason`, sorted. */
  leads: () => string[];
}

/**
 * Builds a model from `types` and `edges` (`[source, target]`: target reads source, or a procedure
 * source writes target) and starts a BB exploration at `origin`.
 */
export function world(
  types: Record<string, ObjectType>,
  edges: Array<[string, string]>,
  origin: string,
  upstream: DepthSide,
  downstream: DepthSide,
  filters: { excludeNodeIds?: string[]; excludeTypes?: string[]; passNodeIds?: string[] } = {},
): BbWorld {
  const nodes = Object.entries(types).map(([id, type]) => makeNode({
    id, name: id, schema: 'dbo', type, ...(type === 'procedure' ? { bodyScript: `-- ${id}` } : {}),
  }));
  const model = makeModel(nodes, edges, ['dbo']);
  const neighborIndex: Record<string, { in: string[]; out: string[] }> = {};
  for (const node of nodes) neighborIndex[node.id] = { in: [], out: [] };
  for (const [source, target] of edges) { neighborIndex[target].in.push(source); neighborIndex[source].out.push(target); }
  (model as { neighborIndex: unknown }).neighborIndex = neighborIndex;
  const graph = makeGraph(nodes, edges);
  const logs: string[] = [];
  const engine = new NavigationEngine(model, graph, (_level, message) => { logs.push(message); }, {});
  const depthIntent = { upstream, downstream };
  const started = engine.init({
    origin, question: 'Trace the lineage', direction: directionFromDepth(depthIntent), analysisMode: 'bb', depthIntent, ...filters,
  });
  if (!('ok' in started)) throw new Error(`init rejected: ${JSON.stringify(started)}`);
  const state = engine.toJSON.bind(engine);
  return {
    engine, model, graph, logs,
    scope: () => [...state().scopeNodeIds].sort(),
    leads: () => state().engineInternals.pendingLeads.filter(lead => lead.status === 'pending').map(lead => `${lead.nodeId}:${lead.reason}`).sort(),
  };
}

/** Submits one kept hop for the current focus. */
export function submit(engine: NavigationEngine, focus: string, script: HopScript = {}): ReturnType<NavigationEngine['submitFindings']> {
  return engine.submitFindings({
    focus_node_id: focus, verdict: 'analyze', summary: `Observed ${focus}`,
    sections: [{ angle: 'technical', text: `SQL at ${focus}` }],
    ...(script.prune?.length ? { prune_neighbors: script.prune.map(id => ({ id, reason: 'off the answer' })) } : {}),
    ...(script.ask?.length ? { questions: script.ask.map(nodeId => ({ nodeId, question: 'check this' })) } : {}),
  });
}

/** Runs the hop loop to its end with `script` per focus and returns the dispatch order; throws on a rejected hop. */
export function drain(engine: NavigationEngine, script: Record<string, HopScript> = {}): string[] {
  const order: string[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const context = engine.getHopContext();
    if (context.done || !context.focus_node) return order;
    const focus = String(context.focus_node.id);
    order.push(focus);
    const result = submit(engine, focus, script[focus]);
    if (!('ok' in result)) throw new Error(`hop ${focus} rejected: ${JSON.stringify(result)}`);
  }
  throw new Error('hop loop did not end');
}

/** The delivered object graph: sorted node ids, `source>target` edges and the pruned ids on record. */
export function delivered(engine: NavigationEngine): { nodes: string[]; edges: string[]; pruned: string[] } {
  const result = engine.getResult();
  return {
    nodes: result.fullNodes.map(node => node.id).sort(),
    edges: result.edges.map(([source, target]) => `${source}>${target}`).sort(),
    pruned: result.node_states.filter(state => state.action === 'prune').map(state => state.nodeId).sort(),
  };
}

/**
 * Delivered nodes with no directed path from the origin over delivered edges on an approved side —
 * the reference oracle, written here and independent of the engine's own walks.
 */
export function withoutDirectedPath(engine: NavigationEngine, origin: string, sides: { upstream: boolean; downstream: boolean }): string[] {
  const { nodes, edges } = delivered(engine);
  const pairs = edges.map(edge => edge.split('>') as [string, string]);
  const walk = (next: (id: string) => string[]): Set<string> => {
    const seen = new Set([origin]);
    const queue = [origin];
    for (let i = 0; i < queue.length; i++) for (const id of next(queue[i])) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    return seen;
  };
  const up = sides.upstream ? walk(id => pairs.filter(([, target]) => target === id).map(([source]) => source)) : new Set<string>();
  const down = sides.downstream ? walk(id => pairs.filter(([source]) => source === id).map(([, target]) => target)) : new Set<string>();
  return nodes.filter(id => id !== origin && !up.has(id) && !down.has(id));
}
