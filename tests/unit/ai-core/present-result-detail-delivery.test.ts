/**
 * Pins detail-callout delivery in `orderAndAssemble`: every captured ⚠️ callout of a section-linked
 * slot reaches the preview description exactly once; unlinked slots stay on the rejection path.
 */
import { describe, expect, it } from 'vitest';
import { orderAndAssemble } from '../../../src/ai/tools/presentResult';
import type { DetailSlot } from '../../../src/ai/session/memoryManager';

const NODE_ID = '[ai].[spImportOrders]';

/** Captured technical findings as the capture templates author them: one ⚠️ line per row-losing statement. */
function spImportOrdersSlot(): DetailSlot {
  return {
    nodeId: NODE_ID,
    schema: 'ai',
    name: 'spImportOrders',
    type: 'procedure',
    sections: [
      {
        angle: 'technical',
        text: [
          'Import staging procedure.',
          '⚠️ `SET RawQty = 0,` overwrites negative quantities in place instead of rejecting those rows.',
          "⚠️ `UPDATE #RawBatch SET IsValidated = 1 WHERE ValidationMessage IS NULL;` defaults every unflagged row to loadable, so warnings do not block the insert.",
          '⚠️ `DELETE FROM #RawBatch WHERE IsDuplicate = 1;` drops intra-batch duplicate rows before the merge.',
        ].join('\n'),
      },
    ],
    summary: 'Stages raw orders.',
  };
}

describe('present_result detail-callout delivery', () => {
  it('renders every captured ⚠️ callout of a section-linked slot in the preview description', () => {
    const sections = [
      {
        label: 'Staging import',
        node_ids: [NODE_ID],
        // Model-authored walkthrough: keeps one callout verbatim, drops the other two.
        text: [
          'spImportOrders stages the raw batch.',
          "⚠️ `UPDATE #RawBatch SET IsValidated = 1 WHERE ValidationMessage IS NULL;` defaults every unflagged row to loadable, so warnings do not block the insert.",
        ].join('\n'),
      },
    ];
    const assembled = orderAndAssemble(sections, { title: 'Lineage', detailSlots: [spImportOrdersSlot()] });

    expect(assembled.description).toContain('SET RawQty = 0,');
    expect(assembled.description).toContain('DELETE FROM #RawBatch WHERE IsDuplicate = 1;');
  });

  it('does not duplicate a callout the section already carries', () => {
    const sections = [
      {
        label: 'Staging import',
        node_ids: [NODE_ID],
        text: spImportOrdersSlot().sections[0].text,
      },
    ];
    const assembled = orderAndAssemble(sections, { title: 'Lineage', detailSlots: [spImportOrdersSlot()] });

    const occurrences = assembled.description.split('SET RawQty = 0,').length - 1;
    expect(occurrences).toBe(1);
  });

  it('leaves slots with no rendered section to the existing unlinked-slot rejection path', () => {
    const sections = [{ label: 'Unrelated', node_ids: ['[ai].[FactSalesReport]'], text: 'Facts.' }];
    const assembled = orderAndAssemble(sections, { title: 'Lineage', detailSlots: [spImportOrdersSlot()] });

    expect(assembled.description).not.toContain('SET RawQty = 0,');
  });
});
