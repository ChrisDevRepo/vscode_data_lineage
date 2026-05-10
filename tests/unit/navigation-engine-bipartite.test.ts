/**
 * Bipartite agenda rule — `sp → table → {viewA, viewB}` forwarding.
 *
 * Asserts:
 *  - Tables never appear as a hop focus.
 *  - When a proc routes to a table, the authored question is forwarded
 *    to the table's bodied neighbors in the exploration direction, verbatim.
 *  - Agenda invariant: every enqueued node is bodied (view/procedure/function).
 */

import { NavigationEngine } from '../../src/ai/sm/smBase';
import { SCRIPT_TYPES } from '../../src/ai/tools/tools';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('Bipartite Agenda Rule');
console.log('='.repeat(40));
resetCounters();

// Topology: sp → table → viewA, sp → table → viewB
// sp is bodied origin; table is passive; viewA and viewB are bodied readers.
const nodes: LineageNode[] = [
  { id: 'sp',     schema: 'dbo', name: 'sp',     type: 'procedure' },
  { id: 'table',  schema: 'dbo', name: 'table',  type: 'table' },
  { id: 'viewA',  schema: 'dbo', name: 'viewA',  type: 'view' },
  { id: 'viewB',  schema: 'dbo', name: 'viewB',  type: 'view' },
];
const edges: Array<[string, string]> = [
  ['sp',    'table'],
  ['table', 'viewA'],
  ['table', 'viewB'],
];
const model: DatabaseModel = {
  nodes,
  edges: edges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })),
  schemas: ['dbo'],
  dbPlatform: 'SQL Server',
};
const graph = makeGraph(nodes, edges);

// Test 1: seeded agenda after init contains only bodied nodes
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depth: 3 });

  const state = engine.toJSON() as { agenda: Array<{ nodeId: string }>; scopeNodeIds: string[] };
  const agendaIds = state.agenda.map(e => e.nodeId);
  const scopeIds = state.scopeNodeIds;

  assert(scopeIds.includes('table'), 'scope contains the table (still routable / referenceable)');
  assert(!agendaIds.includes('table'), 'agenda does NOT contain the table (bipartite rule)');
  assert(agendaIds.includes('viewA'), 'agenda contains viewA (forwarded from table seed)');
  assert(agendaIds.includes('viewB'), 'agenda contains viewB (forwarded from table seed)');
  assert(
    agendaIds.every(id => SCRIPT_TYPES.has(nodes.find(n => n.id === id)!.type)),
    'every agenda entry is bodied',
  );
}

// Test 2: route_requests forwarding — proc routes to table, question propagates to viewA/viewB
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depth: 3 });

  // Hop 1 — sp is focus
  const ctx1 = engine.getHopContext();
  assert(ctx1.focus_node?.id === 'sp', 'Hop 1 focus is sp');

  const SP_QUESTION = 'how are col1/col2 consumed downstream?';
  engine.submitFindings({
    focus_node_id: 'sp',
    sections: [{ angle: 'business' as const, text: 'sp writes col1 and col2 to the table' }],
    summary: 'sp writes col1, col2',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'table', question: SP_QUESTION }],
  });

  // After submit, agenda should have viewA and viewB with sp's verbatim question merged in.
  const state = engine.toJSON() as { agenda: Array<{ nodeId: string; question: string }> };
  const entryA = state.agenda.find(e => e.nodeId === 'viewA');
  const entryB = state.agenda.find(e => e.nodeId === 'viewB');

  assert(!!entryA, 'viewA is on agenda after sp routes to table');
  assert(!!entryB, 'viewB is on agenda after sp routes to table');
  assert(entryA!.question.includes(SP_QUESTION), 'viewA inherits sp\'s authored question verbatim');
  assert(entryB!.question.includes(SP_QUESTION), 'viewB inherits sp\'s authored question verbatim');
  assert(!state.agenda.some(e => e.nodeId === 'table'), 'table is NOT on agenda after route forwarding');
}

// Test 3: no non-bodied node ever becomes focus
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depth: 3 });

  const focusIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const ctx = engine.getHopContext();
    if (ctx.done || !ctx.focus_node) break;
    focusIds.push(ctx.focus_node.id);
    engine.submitFindings({
      focus_node_id: ctx.focus_node.id,
      sections: [{ angle: 'business' as const, text: 'noop' }],
      summary: 'noop',
      verdict: 'analyze',
    });
  }

  assert(!focusIds.includes('table'), 'table never appears as hop focus across the whole session');
  assert(
    focusIds.every(id => SCRIPT_TYPES.has(nodes.find(n => n.id === id)!.type)),
    'every hop focus was bodied',
  );
}

printSummary('Bipartite Agenda Rule');
