/** Synthetic object-level (BB) worlds for tests/unit/backend/bb-*.test.ts. */
import { expect } from 'vitest';
import { submitFindingsSchemaForMode, toHopFinding } from '../../../../src/ai/tools/toolSchemas';
import { NavigationEngine, type HopNeighborDisclosure } from '../../../../src/ai/sm/smBase';
import type { DepthIntent } from '../../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../../src/engine/shared/explorationDepthContract';
import type { DatabaseModel, ObjectType } from '../../../../src/engine/types';
import { makeGraph, makeIndexedModel, makeNode } from '../../helpers/modelFixtures';

/** One side of the approved depth. */
export type DepthSide = DepthIntent['upstream'];

/** What one scripted hop tells the engine about its neighbours. */
export interface HopScript { prune?: string[]; ask?: string[]; rejectPrune?: boolean }

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

/** Builds a model from `types` and `edges` (`[source, target]`: target reads source, or a procedure source writes target) and starts a BB exploration at `origin`. */
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
  const model = makeIndexedModel(nodes, edges);
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
    focus_node_id: focus, summary: `Observed ${focus}`,
    sections: [{ angle: 'technical', text: `SQL at ${focus}` }],
    ...(script.prune?.length ? { prune_neighbors: script.prune.map(id => ({ id, reason: 'off the answer' })) } : {}),
    ...(script.ask !== undefined ? { questions: script.ask.map(nodeId => ({ nodeId, question: 'check this' })) } : {}),
  });
}

/** Runs the hop loop to its end with `script` per focus and returns the dispatch order; throws on a rejected hop. */
export function drain(engine: NavigationEngine, graph: BbWorld['graph'], script: Record<string, HopScript> = {}): string[] {
  const order: string[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const context = engine.getHopContext();
    if (context.done || !context.focus_node) return order;
    const focus = String(context.focus_node.id);
    order.push(focus);
    const decision = script[focus] ?? {};
    const next = new Set(engine.currentDirection === 'upstream' ? graph.inNeighbors(focus)
      : engine.currentDirection === 'downstream' ? graph.outNeighbors(focus) : graph.neighbors(focus));
    const neighbors = context.neighbors as readonly HopNeighborDisclosure[] | undefined;
    const ask = decision.ask ?? neighbors?.filter(neighbor => next.has(neighbor.id) && neighbor.can_question
      && !neighbor.out_of_direction && !decision.prune?.includes(neighbor.id)).map(neighbor => neighbor.id);
    const before = decision.rejectPrune ? engine.toJSON() : undefined;
    let result = submit(engine, focus, { ...decision, ask });
    if (before) {
      expect(result).toMatchObject({ code: 'route_validation_failed', reason: expect.stringContaining('prune_neighbors.0.id'),
        hint: expect.stringContaining('Remove this protected id from prune_neighbors') });
      const after = engine.toJSON();
      expect(after.agenda).toEqual(before.agenda);
      expect(after.columnAspect).toEqual(before.columnAspect);
      expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
      expect(engine.currentFocus).toBe(focus);
      result = engine.submitFindings(toHopFinding(submitFindingsSchemaForMode('bb').parse({ focus_node_id: focus, prune_neighbors: [] })));
    }
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

/** Connectivity invariant over delivered edges, independent of the engine's own walks. Missing nodes and edges require separate comparisons against fixture expectations. */
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
