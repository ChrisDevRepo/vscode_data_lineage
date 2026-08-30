import { buildPassthroughFlowFacts, buildSmCompletionEnvelope } from '../../../src/ai/prompting/smPrompts';
import type { SmResult } from '../../../src/ai/sm/smTypes';
import { describe, expect, it } from 'vitest';

describe("Completion Envelope — Passthrough Flow Facts", () => {
  const HEADER = 'Kept passthrough nodes (engine flow facts';
  function makeResult(over: Partial<SmResult>): SmResult {
    return {
      status: 'complete',
      originNodeId: '[dbo].[origina]',
      fullNodes: [],
      edges: [],
      detail_slots: [],
      node_states: [],
      columnAspect: null,
      ...over,
    };
  }
  it("(a) kept passthrough node without a slot → exactly one digest line with its writers/readers.", () => {
  const result = makeResult({
    fullNodes: [
      { id: '[dbo].[stagea]', s: 'dbo', n: 'stagea', t: 'table' },
      { id: '[dbo].[sploada]', s: 'dbo', n: 'sploada', t: 'procedure' },
      { id: '[dbo].[vwb]', s: 'dbo', n: 'vwb', t: 'view' },
    ],
    edges: [
      ['[dbo].[sploada]', '[dbo].[stagea]', 'INSERT'],
      ['[dbo].[stagea]', '[dbo].[vwb]', 'SELECT'],
    ],
    detail_slots: [
      { nodeId: '[dbo].[sploada]', schema: 'dbo', name: 'sploada', type: 'procedure', sections: [], summary: 's' },
      { nodeId: '[dbo].[vwb]', schema: 'dbo', name: 'vwb', type: 'view', sections: [], summary: 's' },
    ],
    node_states: [
      { nodeId: '[dbo].[stagea]', action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
    ],
  });
  const block = buildPassthroughFlowFacts(result);
  const lines = block.split('\n');
  expect(lines[0].startsWith(HEADER), '(a) block opens with the fixed header').toBe(true);
  expect(lines.length === 2, '(a) exactly one node line under the header').toBe(true);
  expect(lines[1] === '- [dbo].[stagea] — table, passthrough: written by [dbo].[sploada]; read by [dbo].[vwb]', '(a) line carries type, action, writers and readers').toBe(true);
});

  it("(b) node WITH a detail slot → no digest line for it.", () => {
  const result = makeResult({
    fullNodes: [{ id: '[dbo].[stagea]', s: 'dbo', n: 'stagea', t: 'table' }],
    node_states: [{ nodeId: '[dbo].[stagea]', action: 'analyze', source: 'ai', reason: 'submitted_analyze' }],
    detail_slots: [
      { nodeId: '[dbo].[stagea]', schema: 'dbo', name: 'stagea', type: 'table', sections: [], summary: 's' },
    ],
  });
  expect(buildPassthroughFlowFacts(result) === '', '(b) slotted node produces no digest').toBe(true);
});

  it("(c) zero qualifying nodes → header absent from the assembled synthesis_reminder.", () => {
  const result = makeResult({
    fullNodes: [{ id: '[dbo].[origina]', s: 'dbo', n: 'origina', t: 'view' }],
    detail_slots: [
      { nodeId: '[dbo].[origina]', schema: 'dbo', name: 'origina', type: 'view', sections: [], summary: 's' },
    ],
    node_states: [{ nodeId: '[dbo].[origina]', action: 'analyze', source: 'ai', reason: 'submitted_analyze' }],
  });
  const envelope = buildSmCompletionEnvelope(result, 'question A?', []);
  expect(!envelope.synthesis_reminder.includes(HEADER), '(c) no header when nothing qualifies').toBe(true);
});

  it("(c2) qualifying node → header present in the assembled synthesis_reminder.", () => {
  const result = makeResult({
    fullNodes: [
      { id: '[dbo].[origina]', s: 'dbo', n: 'origina', t: 'view' },
      { id: '[dbo].[stagea]', s: 'dbo', n: 'stagea', t: 'table' },
    ],
    edges: [['[dbo].[stagea]', '[dbo].[origina]', 'SELECT']],
    detail_slots: [
      { nodeId: '[dbo].[origina]', schema: 'dbo', name: 'origina', type: 'view', sections: [], summary: 's' },
    ],
    node_states: [{ nodeId: '[dbo].[stagea]', action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' }],
  });
  const envelope = buildSmCompletionEnvelope(result, 'question A?', []);
  expect(envelope.synthesis_reminder.includes(HEADER), '(c2) header rides in synthesis_reminder when a node qualifies').toBe(true);
});

  it("(d) pruned node is never listed, even without a slot and even if it has edges.", () => {
  const result = makeResult({
    fullNodes: [{ id: '[dbo].[stagea]', s: 'dbo', n: 'stagea', t: 'table' }],
    edges: [['[dbo].[droppeda]', '[dbo].[stagea]', 'INSERT']],
    node_states: [
      { nodeId: '[dbo].[stagea]', action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
      { nodeId: '[dbo].[droppeda]', action: 'prune', source: 'ai', reason: 'submitted_prune' },
    ],
  });
  const block = buildPassthroughFlowFacts(result);
  expect(!block.includes('[dbo].[droppeda]') || block.indexOf('[dbo].[droppeda]') > block.indexOf('written by'), '(d) pruned node is not a digest subject').toBe(true);
  // droppeda is not in fullNodes, so it never becomes a subject line; it may appear only as a writer.
  const subjectLines = block.split('\n').slice(1).filter(l => l.startsWith('- [dbo].[droppeda]'));
  expect(subjectLines.length === 0, '(d) pruned node never appears as its own line').toBe(true);
});

  it("(e) deterministic ordering with 2+ qualifying nodes and multi-neighbor lists.", () => {
  const result = makeResult({
    fullNodes: [
      { id: '[dbo].[nodeb]', s: 'dbo', n: 'nodeb', t: 'table' },
      { id: '[dbo].[nodea]', s: 'dbo', n: 'nodea', t: 'table' },
    ],
    edges: [
      ['[dbo].[wz]', '[dbo].[nodea]', 'INSERT'],
      ['[dbo].[wa]', '[dbo].[nodea]', 'INSERT'],
      ['[dbo].[nodea]', '[dbo].[nodeb]', 'SELECT'],
    ],
    node_states: [
      { nodeId: '[dbo].[nodea]', action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
      { nodeId: '[dbo].[nodeb]', action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
    ],
  });
  const lines = buildPassthroughFlowFacts(result).split('\n').slice(1);
  expect(lines[0].startsWith('- [dbo].[nodea]') && lines[1].startsWith('- [dbo].[nodeb]'), '(e) subject nodes sorted by id').toBe(true);
  expect(lines[0].includes('written by [dbo].[wa], [dbo].[wz]'), '(e) writer list sorted by id').toBe(true);
  expect(lines[1].includes('read by (none)'), '(e) empty reader list renders (none)').toBe(true);
});

});
