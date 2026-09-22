/**
 * `AiMemoryManager.storeDetail` must not archive the same evidence twice: sections dedupe on the
 * same identity `appendUniqueSectionText` uses for `column_flow` notes (trimmed text, containment
 * match, angle ignored).
 */
import { describe, expect, it } from 'vitest';
import { AiMemoryManager, appendUniqueSectionText } from '../../../src/ai/session/memoryManager';
import type { LineageNode } from '../../../src/engine/types';

function makeNode(id: string): LineageNode {
  return { id, schema: 'dbo', name: id, fullName: `[dbo].[${id}]`, type: 'view' };
}

const CLAUSE = 'Discount is derived from BaseAmt and DiscountPct.';

describe('AiMemoryManager — a revisit does not duplicate archived sections', () => {
  it('stores one section when the same text is submitted twice', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders');
    const section = [{ angle: 'business' as const, text: CLAUSE }];

    mem.storeDetail(node, section, 'first summary');
    mem.storeDetail(node, [{ angle: 'business' as const, text: CLAUSE }], 'second summary');

    const slot = mem.toJSON().detailSlots[node.id];
    expect(slot.sections, 'the repeated clause is archived once').toEqual(section);
    expect(slot.summary, 'the latest visit still owns the summary').toBe('second summary');
  });

  it('keeps both sections when the revisit says something new', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders');
    const first = [{ angle: 'business' as const, text: CLAUSE }];
    const second = [{ angle: 'business' as const, text: 'Discount is capped at the line total.' }];

    mem.storeDetail(node, first, 'first summary');
    mem.storeDetail(node, second, 'second summary');

    expect(mem.toJSON().detailSlots[node.id].sections, 'new evidence is appended in capture order')
      .toEqual([...first, ...second]);
  });

  it('drops a repeat regardless of the angle that re-emitted it, and keeps the first occurrence', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders');

    mem.storeDetail(node, [{ angle: 'business' as const, text: CLAUSE }], 'first');
    mem.storeDetail(node, [
      { angle: 'technical' as const, text: `  ${CLAUSE}  ` },
      { angle: 'technical' as const, text: 'Reads the staging table nightly.' },
    ], 'second');

    expect(mem.toJSON().detailSlots[node.id].sections, 'the first occurrence wins its slot and angle').toEqual([
      { angle: 'business', text: CLAUSE },
      { angle: 'technical', text: 'Reads the staging table nightly.' },
    ]);
  });

  it('archives a first visit byte-for-byte, repeated text included', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders');
    // Nothing is archived yet, so there is no earlier occurrence to be the duplicate of: one hop's
    // own captures are stored exactly as submitted.
    const sections = [
      { angle: 'business' as const, text: CLAUSE },
      { angle: 'technical' as const, text: CLAUSE },
    ];

    mem.storeDetail(node, sections, 'only summary');

    expect(mem.toJSON().detailSlots[node.id].sections).toEqual(sections);
  });

  it('leaves the column_flow note merge untouched', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders');
    const merged = appendUniqueSectionText(
      [{ angle: 'business' as const, text: CLAUSE }],
      ['BaseAmt * COALESCE(DiscountPct,0)', 'BaseAmt * COALESCE(DiscountPct,0)'],
    );

    mem.storeDetail(node, merged, 'first');
    // The same merged capture arriving again is one repeat, not one repeat per merged note.
    mem.storeDetail(node, merged, 'second');

    const sections = mem.toJSON().detailSlots[node.id].sections;
    expect(sections, 'the merged capture is one section, archived once').toHaveLength(1);
    expect(sections[0].text.split('BaseAmt * COALESCE(DiscountPct,0)'), 'the note is merged once')
      .toHaveLength(2);
    expect(sections[0].text).toContain(CLAUSE);
  });
});
