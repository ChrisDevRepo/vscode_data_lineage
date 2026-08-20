import { findBareNonPrunedNodes } from '../../../src/ai/tools/presentResult';
import { assert, assertEq } from '../helpers/testUtils';
import { describe, it } from 'vitest';

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
  assertEq(JSON.stringify(input), before, 'payload is NOT mutated — no sections[].node_ids injection');
  assertEq(bare.sort().join(','), ['[ai].[oracle]', '[ai].[sap]', '[ai].[view]'].sort().join(','), 'returns exactly the bare non-pruned ids');
  assert(!bare.includes('[ai].[log]'), 'PRUNED node [log] is not reported as bare (prune removes it from the view)');
});

  it("nothing bare when all non-pruned nodes linked", () => {
  const resolved = ['[ai].[a]', '[ai].[b]'];
  const resultGraph = { node_states: [NS('[ai].[a]', 'analyze'), NS('[ai].[b]', 'passthrough')] };
  const input: any = { sections: [{ label: 'S', node_ids: ['[ai].[a]', '[ai].[b]'], text: 't' }] };
  assertEq(findBareNonPrunedNodes(resultGraph, input, resolved).length, 0, 'nothing bare when all non-pruned nodes linked');
});

  it("[b] linked via highlight_groups is not bare", () => {
  const resolved = ['[ai].[a]', '[ai].[b]'];
  const resultGraph = { node_states: [NS('[ai].[a]', 'analyze'), NS('[ai].[b]', 'passthrough')] };
  const input: any = {
    sections: [{ label: 'S', node_ids: ['[ai].[a]'], text: 't' }],
    highlight_groups: [{ label: 'Src', color: 'source', node_ids: ['[ai].[b]'] }],
  };
  assertEq(findBareNonPrunedNodes(resultGraph, input, resolved).length, 0, '[b] linked via highlight_groups is not bare');
});

  it("no sections → no report (update-style call)", () => {
  const resultGraph = { node_states: [NS('[ai].[a]', 'passthrough')] };
  const input: any = { sections: [] };
  assertEq(findBareNonPrunedNodes(resultGraph, input, ['[ai].[a]']).length, 0, 'no sections → no report (update-style call)');
});

});
