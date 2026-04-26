/**
 * Verifies the `prune` verdict contract:
 * - Pruning a node removes all its unvisited descendants from the agenda.
 * - Already visited nodes or noted nodes are never removed by a cascade.
 * - The origin node cannot be marked prune (treated as pass).
 * - Orphan protection prevents pruning a node that would disconnect already-noted work.
 */

import { NavigationEngine } from '../../src/ai/smBase';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { bfsReachable } from '../../src/ai/smGuards';
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

printSummary('Navigation Engine Cascade (Prune)');
