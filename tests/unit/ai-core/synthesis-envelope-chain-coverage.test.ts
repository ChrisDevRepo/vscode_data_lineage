/** The synthesis envelope names the column-chain objects a section link or note must cover, from the computation the present check uses. */
import { expect, it } from 'vitest';
import { buildSmCompletionEnvelope } from '../../../src/ai/prompting/smPrompts';
import type { SmResult } from '../../../src/ai/sm/smTypes';

const view = '[mart].[orders]';
const table = '[stage].[orders]';
const dropped = '[stage].[legacy]';

function result(over: Partial<SmResult> = {}): SmResult {
  return {
    status: 'complete',
    originNodeId: view,
    fullNodes: [{ id: view, s: 'mart', n: 'orders', t: 'view' }, { id: table, s: 'stage', n: 'orders', t: 'table' }],
    edges: [[table, view, 'body']],
    detail_slots: [{ nodeId: view, schema: 'mart', name: 'orders', type: 'view', sections: [{ angle: 'technical', text: 'Selects Amount.' }], summary: 'Selects Amount.' }],
    node_states: [{ nodeId: dropped, action: 'prune', reason: 'Not on the chain.' }],
    columnAspect: {
      edges: [
        { hop_node: view, hop: 1, from_node: table, from_col: 'Amount', to_node: view, to_col: 'Amount' },
        { hop_node: view, hop: 1, from_node: dropped, from_col: 'Amount', to_node: view, to_col: 'Amount' },
      ],
    },
    ...over,
  } as SmResult;
}

it('lists a kept chain object without a detail slot, and neither a slotted nor a pruned one', () => {
  const reminder = buildSmCompletionEnvelope(result(), 'Where does Amount come from?', []).synthesis_reminder;

  expect(reminder).toContain(`Link in \`sections[].node_ids\`: ${view}`);
  expect(reminder.split('\n').at(-1)).toBe(`Link in \`sections[].node_ids\` or caption in \`notes[]\`: ${table}`);
});

it('serves no coverage line when every chain object has a detail slot', () => {
  const slotted = result();
  slotted.detail_slots.push({ ...slotted.detail_slots[0]!, nodeId: table, schema: 'stage', type: 'table' });

  expect(buildSmCompletionEnvelope(slotted, 'Where does Amount come from?', []).synthesis_reminder).not.toContain('or caption in');
});
