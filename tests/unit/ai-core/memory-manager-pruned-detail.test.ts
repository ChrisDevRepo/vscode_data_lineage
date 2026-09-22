import { describe, expect, it } from 'vitest';
import { AiMemoryManager } from '../../../src/ai/session/memoryManager';
import type { LineageNode } from '../../../src/engine/types';

/** A self-pruned node's captured sections/summary are retained separately from `detailSlots`, so `getResult()` (synthesis-visible) never sees them. */

function makeNode(id: string): LineageNode {
  return {
    id,
    schema: 'dbo',
    name: id,
    fullName: `[dbo].[${id}]`,
    type: 'table',
  };
}

describe('AiMemoryManager — pruned-node content retention (A31)', () => {
  it('retains a self-pruned node\'s captured sections and summary', () => {
    const mem = new AiMemoryManager();
    const sections = [{ angle: 'technical' as const, text: 'Feeds spBuildSalesReport.UnitPrice.' }];

    mem.storePrunedDetail(makeNode('vwPriceList'), sections, 'Carries ListPrice through unchanged.', {
      badge_label: 'Pass-through',
      reason_for_visit: 'Historical path investigation',
    });

    const retained = mem.getPrunedDetails();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      nodeId: 'vwPriceList',
      sections,
      summary: 'Carries ListPrice through unchanged.',
      badge_label: 'Pass-through',
    });
  });

  it('is a no-op when nothing was captured before the prune', () => {
    const mem = new AiMemoryManager();

    mem.storePrunedDetail(makeNode('vwEmpty'), [], '');

    expect(mem.getPrunedDetails()).toHaveLength(0);
  });

  it('never surfaces retained content through the synthesis-visible archive', () => {
    const mem = new AiMemoryManager();

    mem.storePrunedDetail(makeNode('vwPriceList'), [{ angle: 'technical' as const, text: 'x' }], 'summary');

    expect(mem.getResult().detail_slots).toHaveLength(0);
    expect(mem.slotCount).toBe(0);
  });

  it('clears retained content on reset', () => {
    const mem = new AiMemoryManager();
    mem.storePrunedDetail(makeNode('vwPriceList'), [{ angle: 'technical' as const, text: 'x' }], 'summary');

    mem.reset();

    expect(mem.getPrunedDetails()).toHaveLength(0);
  });
});
