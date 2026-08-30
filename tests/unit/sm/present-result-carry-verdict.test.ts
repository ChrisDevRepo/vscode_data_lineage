import { findBareNonPrunedNodes } from '../../../src/ai/tools/presentResult';
import { describe, expect, it } from 'vitest';

describe("findBareNonPrunedNodes — observe bare nodes, never mutate", () => {
  const NS = (nodeId: string, action: string) => ({ nodeId, action });
  it("reports bare non-pruned nodes without mutating", () => {
  const resolved = ['[ai].[fact]', '[ai].[proc]', '[ai].[view]', '[ai].[sap]', '[ai].[oracle]', '[ai].[log]'];
  const resultGraph = {
    node_states: [
      NS('[ai].[fact]', 'analyze'), NS('[ai].[proc]', 'analyze'),
      NS('[ai].[view]', 'passthrough'), NS('[ai].[sap]', 'passthrough'), NS('[ai].[oracle]', 'passthrough'),
      NS('[ai].[log]', 'prune'),
    ],
  };
  const input: any = {
    sections: [
      { label: 'Origin', node_ids: ['[ai].[fact]'], text: 'x' },
      { label: 'Transform', node_ids: ['[ai].[proc]'], text: 'y' },
    ],
  };
  const before = JSON.stringify(input);
  const bare = findBareNonPrunedNodes(resultGraph, input, resolved);
  expect(JSON.stringify(input), 'payload is NOT mutated — no sections[].node_ids injection').toBe(before);
  expect(bare.sort().join(','), 'returns exactly the bare non-pruned ids').toBe(['[ai].[oracle]', '[ai].[sap]', '[ai].[view]'].sort().join(','));
  expect(!bare.includes('[ai].[log]'), 'PRUNED node [log] is not reported as bare (prune removes it from the view)').toBe(true);
});

  it("nothing bare when all non-pruned nodes linked", () => {
  const resolved = ['[ai].[a]', '[ai].[b]'];
  const resultGraph = { node_states: [NS('[ai].[a]', 'analyze'), NS('[ai].[b]', 'passthrough')] };
  const input: any = { sections: [{ label: 'S', node_ids: ['[ai].[a]', '[ai].[b]'], text: 't' }] };
  expect(findBareNonPrunedNodes(resultGraph, input, resolved).length, 'nothing bare when all non-pruned nodes linked').toBe(0);
});

  it("[b] linked via highlight_groups is not bare", () => {
  const resolved = ['[ai].[a]', '[ai].[b]'];
  const resultGraph = { node_states: [NS('[ai].[a]', 'analyze'), NS('[ai].[b]', 'passthrough')] };
  const input: any = {
    sections: [{ label: 'S', node_ids: ['[ai].[a]'], text: 't' }],
    highlight_groups: [{ label: 'Src', color: 'source', node_ids: ['[ai].[b]'] }],
  };
  expect(findBareNonPrunedNodes(resultGraph, input, resolved).length, '[b] linked via highlight_groups is not bare').toBe(0);
});

  it("no sections → no report (update-style call)", () => {
  const resultGraph = { node_states: [NS('[ai].[a]', 'passthrough')] };
  const input: any = { sections: [] };
  expect(findBareNonPrunedNodes(resultGraph, input, ['[ai].[a]']).length, 'no sections → no report (update-style call)').toBe(0);
});

});
