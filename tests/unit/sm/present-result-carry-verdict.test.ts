import { findBareNonPrunedNodes, findUnrenderedDetailSlotIds } from '../../../src/ai/tools/presentResult';
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

describe("findUnrenderedDetailSlotIds — observe unsectioned detail slots, never mutate", () => {
  it("reports slots absent from every sections[].node_ids[]", () => {
    const slotNodeIds = ['[ai].[fact]', '[ai].[proc]', '[ai].[view]'];
    const input: any = {
      sections: [
        { label: 'Origin', node_ids: ['[ai].[fact]'], text: 'x' },
        { label: 'Transform', node_ids: [], text: 'y' },
      ],
    };
    const before = JSON.stringify(input);
    const unrendered = findUnrenderedDetailSlotIds(slotNodeIds, input);
    expect(JSON.stringify(input), 'payload is NOT mutated').toBe(before);
    expect(unrendered.sort().join(','), 'returns exactly the slots absent from sections[].node_ids[]').toBe(['[ai].[proc]', '[ai].[view]'].sort().join(','));
  });

  it("a slot linked only via highlight_groups still counts as unrendered — this is not findBareNonPrunedNodes", () => {
    const slotNodeIds = ['[ai].[a]', '[ai].[b]'];
    const input: any = {
      sections: [{ label: 'S', node_ids: ['[ai].[a]'], text: 't' }],
      highlight_groups: [{ label: 'Src', color: 'source', node_ids: ['[ai].[b]'] }],
    };
    // findBareNonPrunedNodes would call [b] covered (highlight_groups counts); the detail-slot
    // check does not, because a highlight color carries no captured detail text.
    expect(findUnrenderedDetailSlotIds(slotNodeIds, input)).toEqual(['[ai].[b]']);
  });

  it("nothing reported when every slot is sectioned", () => {
    const slotNodeIds = ['[ai].[a]', '[ai].[b]'];
    const input: any = { sections: [{ label: 'S', node_ids: ['[ai].[a]', '[ai].[b]'], text: 't' }] };
    expect(findUnrenderedDetailSlotIds(slotNodeIds, input).length).toBe(0);
  });

  it("no sections → no report (update-style call)", () => {
    const input: any = { sections: [] };
    expect(findUnrenderedDetailSlotIds(['[ai].[a]'], input).length).toBe(0);
  });

  it("no slots → no report", () => {
    const input: any = { sections: [{ label: 'S', node_ids: [], text: 't' }] };
    expect(findUnrenderedDetailSlotIds([], input).length).toBe(0);
  });
});
