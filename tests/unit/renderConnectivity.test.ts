/**
 * Rendered-graph connectivity guard.
 *
 * Verifies the debug-dump "what the user sees" summary: an expanded schema's
 * connected objects form one component while collapsed clusters with no bridge
 * edge are reported as isolated — and a single bridge edge joins a cluster into
 * its neighbour's component.
 */

import { printSummary, resetCounters, assert, assertEq } from './helpers/testUtils';
import { summarizeRenderedConnectivity } from '../../src/engine/renderConnectivity';

console.log('Rendered Connectivity');
console.log('='.repeat(40));
resetCounters();

// ── Expanded ai (connected) + two orphan clusters ──
{
  const nodes = [
    { id: 'ai.a', label: 'a' }, { id: 'ai.b', label: 'b' }, { id: 'ai.c', label: 'c' },
    { id: '__schema__Production', label: 'Production' },
    { id: '__schema__Sales', label: 'Sales' },
  ];
  const edges = [
    { source: 'ai.a', target: 'ai.b' },
    { source: 'ai.b', target: 'ai.c' },
  ];
  const conn = summarizeRenderedConnectivity(nodes, edges);

  assertEq(conn.componentCount, 3, 'three components: ai cluster + two orphan schema clusters');
  assert(conn.isolatedNodes.includes('Production'), 'Production cluster reported isolated');
  assert(conn.isolatedNodes.includes('Sales'), 'Sales cluster reported isolated');
  assertEq(conn.components[0].size, 3, 'largest component has the 3 connected ai objects');
}

// ── A bridge edge joins Production into the ai component ──
{
  const nodes = [
    { id: 'ai.a', label: 'a' }, { id: 'ai.b', label: 'b' },
    { id: '__schema__Production', label: 'Production' },
    { id: '__schema__Sales', label: 'Sales' },
  ];
  const edges = [
    { source: 'ai.a', target: 'ai.b' },
    { source: 'ai.b', target: '__schema__Production' }, // bridge to cluster
  ];
  const conn = summarizeRenderedConnectivity(nodes, edges);

  assertEq(conn.componentCount, 2, 'Production joins ai; only Sales stays orphaned');
  assert(conn.isolatedNodes.includes('Sales'), 'Sales still isolated');
  assert(!conn.isolatedNodes.includes('Production'), 'Production no longer isolated');
}

printSummary('Rendered Connectivity');
