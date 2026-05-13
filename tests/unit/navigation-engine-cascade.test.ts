/**
 * Verifies the `prune` verdict contract:
 * - Pruning a node removes all its unvisited descendants from the agenda.
 * - Already visited nodes or noted nodes are never removed by a cascade.
 * - The origin node cannot be marked prune (treated as pass).
 * - Orphan protection prevents pruning a node that would disconnect already-noted work.
 */

import { NavigationEngine } from '../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { bfsReachable } from '../../src/ai/sm/smGuards';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('Navigation Engine Cascade (Prune)');
console.log('='.repeat(40));
resetCounters();

// Topology:
// origin -> core_a -> core_b (noted path)
// origin -> util_log -> util_a -> util_b (utility path, to be pruned)
// origin -> util_log -> core_a (cross-path edge)
const nodes: LineageNode[] = [
  // Bodied origin (procedure) — required by the bipartite agenda rule:
  // only SCRIPT_TYPES (view/procedure/function) take hops.
  { id: 'origin',   schema: 'dbo', name: 'origin',   type: 'procedure' },
  { id: 'core_a',   schema: 'dbo', name: 'core_a',   type: 'view' },
  { id: 'core_b',   schema: 'dbo', name: 'core_b',   type: 'view' },
  { id: 'util_log', schema: 'dbo', name: 'util_log', type: 'procedure' },
  { id: 'util_a',   schema: 'dbo', name: 'util_a',   type: 'procedure' },
  { id: 'util_b',   schema: 'dbo', name: 'util_b',   type: 'procedure' },
];
const edges: Array<[string, string]> = [
  ['origin',   'core_a'],
  ['core_a',   'core_b'],
  ['origin',   'util_log'],
  ['util_log', 'util_a'],
  ['util_a',   'util_b'],
  ['util_log', 'core_a'],
];

const model: DatabaseModel = { nodes, edges: edges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })), schemas: ['dbo'], dbPlatform: 'SQL Server' };
const graph = makeGraph(nodes, edges);

// Test 1: Cascade prune
{
  const engine = new NavigationEngine(model, graph, (l, m) => console.log(`[Engine ${l}] ${m}`), {});

  engine.init({
    origin: 'origin',
    question: 'Test cascade',
    direction: 'downstream',
    depth: 5
  });

  // Hop 1: origin
  let ctx = engine.getHopContext();
  assert(ctx && ctx.focus_node && ctx.focus_node.id === 'origin', 'Hop 1 is origin');

  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'Root node' }],
    summary: 'analyzed origin',
    verdict: 'analyze',
    route_requests: [
        { nodeId: 'core_a', question: '?' },
        { nodeId: 'util_log', question: '?' }
    ]
  });

  // Drain agenda. Note: Priority 2 (routed) > Priority 0 (initial seed).
  // So if core_a is served and it routes core_b, core_b jumps ahead of seeded util_log.
  let core_a_analyzed = false;
  let core_b_analyzed = false;
  let util_log_pruned = false;

  while (true) {
    ctx = engine.getHopContext();
    if (ctx.done || !ctx.focus_node) break;

    const nid = ctx.focus_node.id;
    console.log(`Hop focus: ${nid}`);

    if (nid === 'core_a') {
      engine.submitFindings({
        focus_node_id: nid,
        sections: [{ angle: 'business' as const, text: 'core' }],
        summary: 'ok',
        verdict: 'analyze',
        route_requests: [{ nodeId: 'core_b', question: 'trace' }]
      });
      core_a_analyzed = true;
    } else if (nid === 'core_b') {
      engine.submitFindings({
        focus_node_id: nid,
        sections: [{ angle: 'business' as const, text: 'end' }],
        summary: 'ok',
        verdict: 'analyze'
      });
      core_b_analyzed = true;
    } else if (nid === 'util_log') {
      const res = engine.submitFindings({ focus_node_id: nid, sections: [{ angle: 'business' as const, text: 'util' }], summary: 'ok', verdict: 'prune' });
      assert('ok' in res && res.ok === true, 'Prune util_log accepted');
      util_log_pruned = true;
    } else {
        console.log(`Unexpected node: ${nid}`);
        assert(false, `Unexpected node ${nid} served (cascade fail)`);
    }
  }

  assert(core_a_analyzed, 'core_a was analyzed');
  assert(core_b_analyzed, 'core_b was analyzed');
  assert(util_log_pruned, 'util_log was pruned');

  const final = engine.getResult();
  const ids = new Set(final.fullNodes.map(n => n.id));
  assert(ids.has('origin'), 'origin kept');
  assert(ids.has('core_a'), 'core_a kept');
  assert(ids.has('core_b'), 'core_b kept');
  assert(!ids.has('util_log'), 'util_log gone');
  assert(!ids.has('util_a'), 'util_a cascaded out');
  assert(!ids.has('util_b'), 'util_b cascaded out');
}

// Test 2: Origin cannot be marked prune
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'origin test', direction: 'downstream', depth: 5 });

  const ctx = engine.getHopContext();
  assert(ctx && ctx.focus_node && ctx.focus_node.id === 'origin', 'start at origin');

  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'Try to prune origin' }],
    summary: 'not allowed',
    verdict: 'prune'
  });

  assert('ok' in result, 'Submission for origin prune accepted (no prune)');
  const final = engine.getResult();
  assert(final.fullNodes.some(n => n.id === 'origin'), 'Origin must still be present');
}

// Test 3: prunePreserveOnly (present_result prune)
{
  const { prunePreserveOnly } = require('../../src/ai/infra/viewPrune');
  const nodeIds = ['A', 'B', 'C'];
  const edgesPP: Array<[string, string, string]> = [['A', 'B', 'read'], ['B', 'C', 'read']];
  const pruneIds = ['B'];

  const result = prunePreserveOnly(nodeIds, edgesPP, pruneIds);

  assert(result.nodeIds.length === 2 && result.nodeIds.includes('A') && result.nodeIds.includes('C'), 'pruned nodeIds');
  assert(result.edges.length === 0, 'pruned edges');

  const result2 = prunePreserveOnly(nodeIds, edgesPP, []);
  assert(result2.nodeIds.length === 3, 'no-op nodeIds');
}

// Test 4: prune_neighbors cannot remove an unvisited connector that would break origin closure
{
  // Topology:
  // origin(proc) -> bridge(table) -> p1(proc), p2(proc)
  // bridge is non-bodied (never visited directly), but removing it would disconnect p1 from origin.
  const nodes2: LineageNode[] = [
    { id: 'origin2', schema: 'dbo', name: 'origin2', type: 'procedure' },
    { id: 'bridge', schema: 'dbo', name: 'bridge', type: 'table' },
    { id: 'p1', schema: 'dbo', name: 'p1', type: 'procedure' },
    { id: 'p2', schema: 'dbo', name: 'p2', type: 'procedure' },
  ];
  const edges2: Array<[string, string]> = [
    ['origin2', 'bridge'],
    ['bridge', 'p1'],
    ['bridge', 'p2'],
  ];
  const model2: DatabaseModel = {
    nodes: nodes2,
    edges: edges2.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })),
    schemas: ['dbo'],
    dbPlatform: 'SQL Server',
  };
  const graph2 = makeGraph(nodes2, edges2);
  const logs: string[] = [];
  const engine2 = new NavigationEngine(model2, graph2, (level, msg) => logs.push(`[${level}] ${msg}`), {});

  engine2.init({
    origin: 'origin2',
    question: 'connector prune guard',
    direction: 'downstream',
    depth: 5,
  });

  let ctx2 = engine2.getHopContext();
  assert(ctx2 && ctx2.focus_node && ctx2.focus_node.id === 'origin2', 'connector test starts at origin2');
  engine2.submitFindings({
    focus_node_id: 'origin2',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'root',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'bridge', question: 'trace bridge branch' }],
  });

  ctx2 = engine2.getHopContext();
  assert(ctx2 && ctx2.focus_node && ctx2.focus_node.id === 'p1', 'connector test reaches p1 through non-bodied bridge');
  engine2.submitFindings({
    focus_node_id: 'p1',
    sections: [{ angle: 'business' as const, text: 'p1' }],
    summary: 'p1',
    verdict: 'analyze',
    prune_neighbors: ['bridge'],
  });

  const state2 = engine2.toJSON();
  assert(!state2.removedSet.includes('bridge'), 'connector bridge is not pruned when it would break closure');
  assert(logs.some(l => l.includes('reason=would_orphan_noted')), 'reject log includes reason=would_orphan_noted');
}

printSummary('Navigation Engine Cascade (Prune)');
