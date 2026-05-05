/**
 * High-fidelity unit tests for the NavigationEngine's state management,
 * routing validation, and verdict tallying.
 */

import { NavigationEngine } from '../../src/ai/smBase';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('NavigationEngine Robustness');
console.log('='.repeat(40));
resetCounters();

const nodes: LineageNode[] = [
  // Bodied origin (procedure) — required by the bipartite agenda rule:
  // only SCRIPT_TYPES (view/procedure/function) take hops.
  { id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' },
  { id: 'child_a', schema: 'dbo', name: 'child_a', type: 'view' },
  { id: 'child_b', schema: 'dbo', name: 'child_b', type: 'view' },
];
const edges: Array<[string, string]> = [
  ['origin', 'child_a'],
  ['child_a', 'child_b'],
];
const model: DatabaseModel = { nodes, edges: edges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })), schemas: ['dbo'], dbPlatform: 'SQL Server' };
const graph = makeGraph(nodes, edges);

// Status check
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  assert(engine.status === 'created', 'status created');

  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });
  assert(engine.status === 'initialized', 'status initialized');

  engine.getHopContext();
  assert(engine.status === 'awaiting_findings', 'status awaiting_findings');

  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'Root node' }],
    summary: 'analyzed origin',
    verdict: 'analyze',
  });
  assert(engine.status === 'exploring', 'status exploring');
}

// Tally tracking
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'Root' }], summary: 'ok', verdict: 'analyze' });

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'child_a', sections: [{ angle: 'business' as const, text: 'child' }], summary: 'ok', verdict: 'prune' });

  const diag = engine.getHopDiagnostics();
  assert(diag.tally.analyze === 1, 'analyze tally 1');
  assert(diag.tally.prune === 1, 'prune tally 1');
}

// Path grounding
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  const ctx1 = engine.getHopContext();
  assert(ctx1.working_memory.topological_map.navigation_path === 'origin', 'path 1');

  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'analyze' });

  const ctx2 = engine.getHopContext();
  assert(ctx2.working_memory.topological_map.navigation_path === 'origin → child_a', 'path 2');
}

// SM mode completion contract: AI's complete:true is silently ignored — engine owns termination
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    complete: true,
  } as any);

  assert(!('done' in result), 'SM should ignore complete:true — engine owns termination');
  assert(engine.status === 'exploring', 'status exploring');
}

// Route rejections are recorded and surfaced
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'NON_EXISTENT', question: '?' }],
  });

  const ctx2 = engine.getHopContext();
  const rejections = ctx2.working_memory.recent_rejections;
  assert(rejections.length === 1, 'rejection recorded');
  assert(rejections[0].nodeId === 'NON_EXISTENT', 'nodeId matched');
}

// Diagnostics archive counter
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'a'.repeat(100) }],
    summary: 's'.repeat(10),
    verdict: 'analyze',
  });

  const d1 = engine.getHopDiagnostics();
  assert(d1.archiveChars === 110, 'archiveChars 110');
  assert(d1.tally.analyze === 1, 'tally 1');

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'child_a',
    sections: [{ angle: 'business' as const, text: 'b'.repeat(50) }],
    summary: 't'.repeat(5),
    verdict: 'analyze',
  });

  const d2 = engine.getHopDiagnostics();
  assert(d2.archiveChars === 165, 'archiveChars 165');
}

printSummary('NavigationEngine Robustness');
