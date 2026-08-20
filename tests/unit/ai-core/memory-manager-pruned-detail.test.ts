import { describe, expect, it } from 'vitest';
import { AiMemoryManager } from '../../../src/ai/session/memoryManager';
import type { LineageNode } from '../../../src/engine/types';

/**
 * Regression test for A31 — a self-pruned focus node's already-captured `sections`/`summary`
 * were discarded at the `submit_findings` prune branch (`smBase.ts`) before the analyze/passthrough
 * path's `storeDetail` call ever ran, so later synthesis had nothing to cite for that node. Pins
 * the storage-only fix: `AiMemoryManager.storePrunedDetail` retains that content in a store
 * separate from `detailSlots`, so `getResult()` (the synthesis-visible archive) never sees it.
 */

function makeNode(id: string): LineageNode {
  return {
    id,
    schema: 'dbo',
    name: id,
    fullName: `[dbo].[${id}]`,
    type: 'table',
  } as LineageNode;
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
