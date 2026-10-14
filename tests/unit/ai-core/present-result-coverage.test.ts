/** Owns presentResult.ts coverage APIs: highlights cover bare nodes; only sections render detail slots. */
import { describe, expect, it } from 'vitest';
import { findBareNonPrunedNodes, findUnrenderedDetailSlotIds, type PresentResultInput } from '../../../src/ai/tools/presentResult';

interface CoverageCase {
  name: string;
  api: 'bare' | 'slots';
  ids: string[];
  input: Partial<PresentResultInput>;
  states?: Array<{ nodeId: string; action: string }>;
  expected: string[];
  excluded?: string;
}

const states = (...pairs: Array<[string, string]>) => pairs.map(([nodeId, action]) => ({ nodeId, action }));
const cases: CoverageCase[] = [
  { name: 'reports bare non-pruned nodes without mutating', api: 'bare',
    ids: ['[ai].[fact]', '[ai].[proc]', '[ai].[view]', '[ai].[sap]', '[ai].[oracle]', '[ai].[log]'],
    states: states(['[ai].[fact]', 'analyze'], ['[ai].[proc]', 'analyze'], ['[ai].[view]', 'passthrough'], ['[ai].[sap]', 'passthrough'], ['[ai].[oracle]', 'passthrough'], ['[ai].[log]', 'prune']),
    input: { sections: [{ label: 'Origin', node_ids: ['[ai].[fact]'], text: 'x' }, { label: 'Transform', node_ids: ['[ai].[proc]'], text: 'y' }] },
    expected: ['[ai].[oracle]', '[ai].[sap]', '[ai].[view]'], excluded: '[ai].[log]' },
  { name: 'nothing bare when all non-pruned nodes linked', api: 'bare', ids: ['[ai].[a]', '[ai].[b]'],
    states: states(['[ai].[a]', 'analyze'], ['[ai].[b]', 'passthrough']),
    input: { sections: [{ label: 'S', node_ids: ['[ai].[a]', '[ai].[b]'], text: 't' }] }, expected: [] },
  { name: '[b] linked via highlight_groups is not bare', api: 'bare', ids: ['[ai].[a]', '[ai].[b]'],
    states: states(['[ai].[a]', 'analyze'], ['[ai].[b]', 'passthrough']),
    input: { sections: [{ label: 'S', node_ids: ['[ai].[a]'], text: 't' }], highlight_groups: [{ label: 'Src', color: 'source', node_ids: ['[ai].[b]'] }] }, expected: [] },
  { name: 'no sections → no report (update-style call)', api: 'bare', ids: ['[ai].[a]'],
    states: states(['[ai].[a]', 'passthrough']), input: { sections: [] }, expected: [] },
  { name: 'reports slots absent from every sections[].node_ids[]', api: 'slots', ids: ['[ai].[fact]', '[ai].[proc]', '[ai].[view]'],
    input: { sections: [{ label: 'Origin', node_ids: ['[ai].[fact]'], text: 'x' }, { label: 'Transform', node_ids: [], text: 'y' }] }, expected: ['[ai].[proc]', '[ai].[view]'] },
  { name: 'a slot linked only via highlight_groups still counts as unrendered', api: 'slots', ids: ['[ai].[a]', '[ai].[b]'],
    input: { sections: [{ label: 'S', node_ids: ['[ai].[a]'], text: 't' }], highlight_groups: [{ label: 'Src', color: 'source', node_ids: ['[ai].[b]'] }] }, expected: ['[ai].[b]'] },
  { name: 'nothing reported when every slot is sectioned', api: 'slots', ids: ['[ai].[a]', '[ai].[b]'],
    input: { sections: [{ label: 'S', node_ids: ['[ai].[a]', '[ai].[b]'], text: 't' }] }, expected: [] },
  { name: 'no sections → no report (update-style call)', api: 'slots', ids: ['[ai].[a]'], input: { sections: [] }, expected: [] },
  { name: 'no slots → no report', api: 'slots', ids: [], input: { sections: [{ label: 'S', node_ids: [], text: 't' }] }, expected: [] },
  { name: 'a slot covered only via notes[] is still unrendered — notes are not the walkthrough', api: 'slots', ids: ['[ai].[a]', '[ai].[b]'],
    // This legacy notes shape is deliberately ignored by the section-coverage API.
    input: { sections: [{ label: 'S', node_ids: ['[ai].[a]'], text: 't' }], notes: [{ node_id: '[ai].[b]', text: 'One-line caption.' }] } as unknown as Partial<PresentResultInput>, expected: ['[ai].[b]'] },
];

describe('presentation coverage contracts', () => {
  it.each(cases)('$api: $name', row => {
    const before = JSON.stringify(row.input);
    const input = row.input as PresentResultInput;
    const result = row.api === 'bare' ? findBareNonPrunedNodes({ node_states: row.states }, input, row.ids)
      : findUnrenderedDetailSlotIds(row.ids, input);
    expect(result.slice().sort()).toEqual(row.expected.slice().sort());
    expect(JSON.stringify(row.input), 'coverage observation must not mutate the payload').toBe(before);
    if (row.excluded) expect(result).not.toContain(row.excluded);
  });
});
