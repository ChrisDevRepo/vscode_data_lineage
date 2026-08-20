import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { prunePreserveOnly } from '../../../src/ai/support/viewPrune';
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

describe("Navigation Engine — no self-prune cascade", () => {
  const nodes: LineageNode[] = [
    // Bodied origin (procedure) — required by the bipartite agenda rule:
    // only SCRIPT_TYPES (view/procedure/function) take hops.
    makeNode({ id: 'origin',   schema: 'dbo', name: 'origin',   type: 'procedure' }),
    makeNode({ id: 'core_a',   schema: 'dbo', name: 'core_a',   type: 'view' }),
    makeNode({ id: 'core_b',   schema: 'dbo', name: 'core_b',   type: 'view' }),
    makeNode({ id: 'util_log', schema: 'dbo', name: 'util_log', type: 'procedure' }),
    makeNode({ id: 'util_a',   schema: 'dbo', name: 'util_a',   type: 'procedure' }),
    makeNode({ id: 'util_b',   schema: 'dbo', name: 'util_b',   type: 'procedure' }),
  ];
  const edges: Array<[string, string]> = [
    ['origin',   'core_a'],
    ['core_a',   'core_b'],
    ['origin',   'util_log'],
    ['util_log', 'util_a'],
    ['util_a',   'util_b'],
    ['util_log', 'core_a'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  function driveWalk(engine: NavigationEngine, passNodes: Set<string>): Set<string> {
    const visited = new Set<string>();
    let ctx = engine.getHopContext();
    let guard = 0;
    while (!('done' in ctx && ctx.done) && 'focus_node' in ctx && ctx.focus_node && guard++ < 50) {
      const nid = ctx.focus_node.id as string;
      visited.add(nid);
      const route_requests = (ctx.neighbors ?? [])
        .filter((n) => n.edge_direction === 'downstream')
        .map((n) => ({ nodeId: n.id, question: 'trace' }));
      engine.submitFindings({
        focus_node_id: nid,
        sections: [{ angle: 'business' as const, text: nid }],
        summary: nid,
        verdict: passNodes.has(nid) ? 'passthrough' : 'analyze',
        route_requests,
      });
      ctx = engine.getHopContext();
    }
    return visited;
  }
  it("Test 1: a `passthrough` node never cascade-drops its descendants — full coverage.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'Full coverage, no cascade', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  const visited = driveWalk(engine, new Set(['util_log']));

  const final = engine.getResult();
  const ids = new Set(final.fullNodes.map((n) => n.id));
  for (const id of ['origin', 'core_a', 'core_b', 'util_log', 'util_a', 'util_b']) {
    assert(ids.has(id), `${id} kept — passthrough never cascades (agenda drains only by visiting)`);
  }
  assert(visited.size === 6, 'all six scoped nodes were visited');
});

  it("Test 2: the immutable origin is always present.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'origin test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });
  const ctx = engine.getHopContext();
  assert('focus_node' in ctx && ctx.focus_node?.id === 'origin', 'start at origin');

  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'root',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'core_a', question: '?' }, { nodeId: 'util_log', question: '?' }],
  });
  assert('ok' in result, 'origin submission accepted');
  const final = engine.getResult();
  assert(final.fullNodes.some((n) => n.id === 'origin'), 'origin must still be present');
});

  it("Test 3: prunePreserveOnly (present_result prune) — unaffected by the engine change.", () => {
  const nodeIds = ['A', 'B', 'C'];
  const edgesPP: Array<[string, string, string]> = [['A', 'B', 'read'], ['B', 'C', 'read']];
  const result = prunePreserveOnly(nodeIds, edgesPP, ['B']);
  assert(result.nodeIds.length === 2 && result.nodeIds.includes('A') && result.nodeIds.includes('C'), 'pruned nodeIds');
  assert(result.edges.length === 0, 'pruned edges');
  const result2 = prunePreserveOnly(nodeIds, edgesPP, []);
  assert(result2.nodeIds.length === 3, 'no-op nodeIds');
});

  it("queued coverage stays engine-owned and the hop still commits.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'in-scope prune rejected', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  const ctx = engine.getHopContext();
  assert('focus_node' in ctx && ctx.focus_node?.id === 'origin', 'start at origin');
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'root',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'core_a', question: '?' }],
    prune_neighbors: ['util_log'],
  });
  const state = engine.toJSON();
  assert('ok' in result, 'queued in-scope prune is a nonfatal notice');
  assert(!state.removedSet.includes('util_log'), 'queued util_log is not removed by prune_neighbors — it keeps its own focus hop');
  assert(!state.removedSet.includes('origin'), 'origin is never removed by prune_neighbors');
  assert(state.memory.recentRejections.some((r) => r.nodeId === 'util_log'), 'queued in-scope prune notice is recorded');
});

});
