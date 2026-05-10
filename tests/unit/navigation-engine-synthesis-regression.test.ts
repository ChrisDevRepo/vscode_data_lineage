/**
 * Regression guard: synthesis grounding must remain stable even when the model
 * emits aggressive prune_neighbors on previously analyzed nodes.
 */

import { NavigationEngine } from '../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('Navigation Engine Synthesis Regression');
console.log('='.repeat(40));
resetCounters();

const nodes: LineageNode[] = [
  { id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' },
  { id: 'a', schema: 'dbo', name: 'a', type: 'procedure' },
  { id: 'b', schema: 'dbo', name: 'b', type: 'procedure' },
];
const edges: Array<[string, string]> = [
  ['origin', 'a'],
  ['a', 'b'],
];
const model: DatabaseModel = {
  nodes,
  edges: edges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })),
  schemas: ['dbo'],
  dbPlatform: 'SQL Server',
};
const graph = makeGraph(nodes, edges);

const logs: string[] = [];
const engine = new NavigationEngine(model, graph, (level, msg) => logs.push(`[${level}] ${msg}`), {});
engine.init({ origin: 'origin', question: 'regression check', direction: 'downstream', depth: 4 });

let ctx = engine.getHopContext() as any;
assert(ctx.focus_node?.id === 'origin', 'Hop 1 focus is origin');
engine.submitFindings({
  focus_node_id: 'origin',
  sections: [{ angle: 'business' as const, text: 'origin' }],
  summary: 'origin done',
  verdict: 'analyze',
  route_requests: [{ nodeId: 'a', question: 'analyze a' }],
});

ctx = engine.getHopContext() as any;
assert(ctx.focus_node?.id === 'a', 'Hop 2 focus is a');
engine.submitFindings({
  focus_node_id: 'a',
  sections: [{ angle: 'business' as const, text: 'a' }],
  summary: 'a done',
  verdict: 'analyze',
  route_requests: [{ nodeId: 'b', question: 'analyze b' }],
});

ctx = engine.getHopContext() as any;
assert(ctx.focus_node?.id === 'b', 'Hop 3 focus is b');
engine.submitFindings({
  focus_node_id: 'b',
  sections: [{ angle: 'business' as const, text: 'b' }],
  summary: 'b done',
  verdict: 'analyze',
  prune_neighbors: ['a', 'origin', '[dbo].[doesNotExist]'],
});

const result = engine.getResult();
const nodeIds = new Set(result.fullNodes.map(n => n.id));
assert(nodeIds.has('a'), 'Previously analyzed node "a" is retained in final result graph');
assert(nodeIds.has('origin'), 'Origin is retained in final result graph');
assert(nodeIds.has('b'), 'Terminal analyzed node is retained in final result graph');

const slotIds = result.detail_slots.map(s => s.nodeId);
for (const id of slotIds) {
  assert(nodeIds.has(id), `Detail slot ${id} is grounded in result fullNodes`);
}

assert(logs.some(l => l.includes('reason=already_visited')), 'Reject log includes reason=already_visited');
assert(logs.some(l => l.includes('reason=origin_forbidden')), 'Reject log includes reason=origin_forbidden');
assert(logs.some(l => l.includes('reason=unknown_node')), 'Reject log includes reason=unknown_node');

printSummary('Navigation Engine Synthesis Regression');
