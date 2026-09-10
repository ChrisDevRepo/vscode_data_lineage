import { describe, expect, it } from 'vitest';
import { AiMemoryManager } from '../../../src/ai/session/memoryManager';
import type { LineageNode } from '../../../src/engine/types';

/**
 * A revisit of an already-analyzed node (a reopened column chain re-enqueues a visited node,
 * `smBase.ts` route enqueue with `openColumnEnd`) commits a second accepted finding through
 * `storeDetail`. The slot must keep what the first visit captured: a Map overwrite dropped a
 * first-visit risk from the synthesis archive while the revisit, re-anchored to another question,
 * never restated it.
 */

function makeNode(id: string): LineageNode {
  return { id, schema: 'dbo', name: id, fullName: `[dbo].[${id}]`, type: 'procedure' };
}

describe('AiMemoryManager — revisit keeps first-visit detail', () => {
  it('appends a revisit\'s sections to the slot instead of replacing them', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('spClean');
    const first = [{ angle: 'business' as const, text: 'Dedup key omits the amount column.' }];
    const second = [{ angle: 'business' as const, text: 'Carries the amount to the target table.' }];

    mem.storeDetail(node, first, 'first summary', { reason_for_visit: 'first question' });
    mem.storeDetail(node, second, 'second summary', { reason_for_visit: 'second question' });

    const slot = mem.toJSON().detailSlots[node.id];
    expect(slot.sections).toEqual([...first, ...second]);
    expect(slot.summary).toBe('second summary');
    expect(slot.reason_for_visit).toBe('second question');
    expect(mem.toJSON().slotCount).toBe(1);
  });

  it('stores a first visit unchanged', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOnce');
    const sections = [{ angle: 'technical' as const, text: 'Passes the column through.' }];
    mem.storeDetail(node, sections, 'only summary');
    expect(mem.toJSON().detailSlots[node.id].sections).toEqual(sections);
  });
});
