/**
 * Closed-graph validation guard for present_result add/prune updates.
 */

import { findDisconnectedViewNodes } from '../../src/ai/tools/tools';
import { assert, resetCounters, printSummary } from './helpers/testUtils';

console.log('Present Result Closure');
console.log('='.repeat(40));
resetCounters();

{
  const nodeIds = ['origin', 'a', 'b', 'x'];
  const edges: Array<[string, string, string]> = [
    ['origin', 'a', 'read'],
    ['a', 'b', 'read'],
  ];

  const disconnected = findDisconnectedViewNodes(nodeIds, edges, 'origin');
  assert(disconnected.length === 1 && disconnected[0] === 'x', 'reports disconnected nodes from origin');
}

{
  const nodeIds = ['origin', 'a', 'b'];
  const edges: Array<[string, string, string]> = [
    ['origin', 'a', 'read'],
    ['a', 'b', 'read'],
  ];

  const disconnected = findDisconnectedViewNodes(nodeIds, edges, 'origin');
  assert(disconnected.length === 0, 'returns empty when view is closed');
}

printSummary('Present Result Closure');
