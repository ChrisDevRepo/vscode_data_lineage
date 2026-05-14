/**
 * Closed-graph validation guard for present_result add/prune updates.
 */

import { findDisconnectedViewNodes, orderAndAssemble, validatePresentResult } from '../../src/ai/tools/tools';
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

{
  const assembled = orderAndAssemble([
    { label: 'Source Tables', node_ids: ['a', 'b'], text: 'Sources feed the calculation.' },
    { label: 'Output', text: 'The output table stores the result.' },
  ]);
  const result = validatePresentResult({
    name: 'ok',
    summary: 'ok',
    sections: [
      { label: 'Source Tables', node_ids: ['a', 'b'], text: 'Sources feed the calculation.' },
      { label: 'Output', text: 'The output table stores the result.' },
    ],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  }, ['a', 'b', 'c'], assembled.badges, assembled.description);
  assert(result.success === true, 'allows one section label to link multiple nodes and another section with no node_ids');
}

{
  const assembled = orderAndAssemble([{ label: '', text: 'Missing label.' }]);
  const result = validatePresentResult({
    name: 'bad',
    summary: 'bad',
    sections: [{ label: '', text: 'Missing label.' }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  }, ['a'], assembled.badges, assembled.description);
  assert(result.success === false && result.errors.some(e => e.includes('Section label is required')), 'rejects empty section labels');
}

{
  const sections = [
    { label: 'Source Tables', text: 'One.' },
    { label: '1 Source Tables', text: 'Two.' },
  ];
  const assembled = orderAndAssemble(sections);
  const result = validatePresentResult({
    name: 'bad',
    summary: 'bad',
    sections,
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  }, ['a'], assembled.badges, assembled.description);
  assert(result.success === false && result.errors.some(e => e.includes('Duplicate section label')), 'rejects duplicate normalized labels');
}

{
  const sections = [{ label: 'Very Long Section Label', text: 'Too long.' }];
  const assembled = orderAndAssemble(sections);
  const result = validatePresentResult({
    name: 'bad',
    summary: 'bad',
    sections,
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  }, ['a'], assembled.badges, assembled.description);
  assert(result.success === false && result.errors.some(e => e.includes('exceeds 3 words')), 'rejects labels over three words');
}

{
  const sections = [{ label: 'Output', node_ids: ['a'], text: '' }];
  const assembled = orderAndAssemble(sections);
  const result = validatePresentResult({
    name: 'bad',
    summary: 'bad',
    sections,
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  }, ['a'], assembled.badges, assembled.description);
  assert(result.success === false && result.errors.some(e => e.includes('missing text')), 'rejects empty section text');
}

{
  const sections = [
    { label: 'Source', node_ids: ['a'], text: 'One.' },
    { label: 'Output', node_ids: ['a'], text: 'Two.' },
  ];
  const assembled = orderAndAssemble(sections);
  const result = validatePresentResult({
    name: 'bad',
    summary: 'bad',
    sections,
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  }, ['a'], assembled.badges, assembled.description);
  assert(result.success === false && result.errors.some(e => e.includes('multiple section labels')), 'rejects same node linked to multiple final sections');
}

printSummary('Present Result Closure');
