import { describe, expect, it } from 'vitest';
import { AiMemoryManager, appendUniqueSectionText } from '../../../src/ai/session/memoryManager';
import type { LineageNode } from '../../../src/engine/types';

/**
 * AiMemoryManager: pruned-node retention (A31), revisit accumulation, and the section/column_flow
 * dedupe `storeDetail` shares with `appendUniqueSectionText`. A self-pruned node's captured
 * sections/summary are retained separately from `detailSlots`, so `getResult()` (synthesis-visible)
 * never sees them. A revisit appends to a slot rather than overwriting it, deduping on exact-text
 * identity (angle ignored) while containment is never identity.
 */

function makeNode(id: string, type: LineageNode['type'] = 'table'): LineageNode {
  return { id, schema: 'dbo', name: id, fullName: `[dbo].[${id}]`, type };
}

const CLAUSE = 'Discount is derived from BaseAmt and DiscountPct.';

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

describe('AiMemoryManager — a revisit does not duplicate archived sections', () => {
  it('stores one section when the same text is submitted twice, and the latest visit owns the summary', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');
    const section = [{ angle: 'business' as const, text: CLAUSE }];

    mem.storeDetail(node, section, 'first summary');
    mem.storeDetail(node, [{ angle: 'business' as const, text: CLAUSE }], 'second summary');

    const slot = mem.toJSON().detailSlots[node.id];
    expect(slot.sections, 'the repeated clause is archived once').toEqual(section);
    expect(slot.summary, 'the latest visit still owns the summary').toBe('second summary');
    expect(mem.toJSON().slotCount).toBe(1);
  });

  it('keeps both sections when the revisit says something new, and carries reason_for_visit forward', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');
    const first = [{ angle: 'business' as const, text: CLAUSE }];
    const second = [{ angle: 'business' as const, text: 'Discount is capped at the line total.' }];

    mem.storeDetail(node, first, 'first summary', { reason_for_visit: 'first question' });
    mem.storeDetail(node, second, 'second summary', { reason_for_visit: 'second question' });

    const slot = mem.toJSON().detailSlots[node.id];
    expect(slot.sections, 'new evidence is appended in capture order').toEqual([...first, ...second]);
    expect(slot.reason_for_visit).toBe('second question');
  });

  it('drops a repeat regardless of the angle that re-emitted it, and keeps the first occurrence', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');

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

  it('keeps a revisit section that is only a substring of an earlier one — containment is not identity', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');
    const longer = `${CLAUSE} It is capped at the line total.`;

    mem.storeDetail(node, [{ angle: 'business' as const, text: longer }], 'first');
    mem.storeDetail(node, [{ angle: 'technical' as const, text: CLAUSE }], 'second');

    expect(mem.toJSON().detailSlots[node.id].sections, 'the shorter, contained section is kept, not dropped').toEqual([
      { angle: 'business', text: longer },
      { angle: 'technical', text: CLAUSE },
    ]);
  });

  it('logs the dropped node id and count at the commit site (storeDetail) when a debugLog sink is supplied', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');
    const logs: string[] = [];

    mem.storeDetail(node, [{ angle: 'business' as const, text: CLAUSE }], 'first');
    mem.storeDetail(node, [
      { angle: 'technical' as const, text: `  ${CLAUSE}  ` },
      { angle: 'technical' as const, text: 'Reads the staging table nightly.' },
    ], 'second', undefined, message => logs.push(message));

    expect(logs.some(l => l.includes('[Memory] duplicate section(s) dropped on revisit') && l.includes(`node=${node.id}`) && l.includes('count=1'))).toBe(true);
  });

  it('archives a first visit byte-for-byte, repeated text included', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');
    // Nothing is archived yet, so there is no earlier occurrence to be the duplicate of: one hop's
    // own captures are stored exactly as submitted.
    const sections = [
      { angle: 'business' as const, text: CLAUSE },
      { angle: 'technical' as const, text: CLAUSE },
    ];

    mem.storeDetail(node, sections, 'only summary');

    expect(mem.toJSON().detailSlots[node.id].sections).toEqual(sections);
  });

  it('leaves the column_flow note merge untouched: the merged capture is one section, archived once', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('vwOrders', 'view');
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

  it('getArchivedAngles reports the angles a prior visit already committed, ahead of a reopen', () => {
    // m57-close-azure-azure-foundry run-T8 host.log:151-187: hop 5 committed both angles for
    // spCleanOrders; the CT reopen at hop 9 needs to see that coverage before storeDetail runs
    // again, so the classification-lock check can credit it instead of demanding a re-send.
    const mem = new AiMemoryManager();
    const node = makeNode('spCleanOrders', 'procedure');
    expect(mem.getArchivedAngles(node.id)).toEqual(new Set());

    mem.storeDetail(node, [
      { angle: 'business', text: 'Business note from hop 5.' },
      { angle: 'technical', text: 'Technical note from hop 5.' },
    ], 'hop 5 summary');

    expect(mem.getArchivedAngles(node.id)).toEqual(new Set(['business', 'technical']));
  });
});

describe('appendUniqueSectionText — column_flow notes reach the slot', () => {
  it('merges a note that is not already in sections', () => {
    const sections = [{ angle: 'business' as const, text: 'Derives Discount from OrderAmount.' }];
    const merged = appendUniqueSectionText(sections, [
      'BaseAmt * COALESCE(DiscountPct,0)',
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toContain('Derives Discount from OrderAmount.');
    expect(merged[0].text).toContain('BaseAmt * COALESCE(DiscountPct,0)');
  });

  it('drops a note that is an exact duplicate (trimmed) of an earlier section — equality still dedupes', () => {
    const sections = [{ angle: 'business' as const, text: 'BaseAmt * COALESCE(DiscountPct,0)' }];
    const merged = appendUniqueSectionText(sections, [
      'BaseAmt * COALESCE(DiscountPct,0)',
      '  BaseAmt * COALESCE(DiscountPct,0)  ',
    ]);
    expect(merged).toEqual(sections);
  });

  it('logs the dropped-duplicate count and node id at the commit site when a debugLog sink is supplied', () => {
    const sections = [{ angle: 'business' as const, text: 'BaseAmt * COALESCE(DiscountPct,0)' }];
    const logs: string[] = [];
    appendUniqueSectionText(
      sections,
      ['BaseAmt * COALESCE(DiscountPct,0)', 'CostPrice * (1 + COALESCE(MarkupPct,0.15))'],
      'spRefresh',
      message => logs.push(message),
    );
    expect(logs.some(l => l.includes('[Memory] duplicate column_flow note(s) dropped') && l.includes('node=spRefresh') && l.includes('count=1'))).toBe(true);
  });

  it('drops blank extras and de-duplicates identical notes', () => {
    const sections = [{ angle: 'technical' as const, text: 'Pass-through rename.' }];
    const merged = appendUniqueSectionText(sections, [
      '',
      '  ',
      'ListPrice AS BasePrice, BasePrice * 1.0 AS AdjPrice',
      'ListPrice AS BasePrice, BasePrice * 1.0 AS AdjPrice',
    ]);
    expect(merged[0].text).toBe(
      'Pass-through rename.\nListPrice AS BasePrice, BasePrice * 1.0 AS AdjPrice',
    );
  });

  it('is a no-op when there are no sections to merge into', () => {
    expect(appendUniqueSectionText([], ['COALESCE(MarkupPct, 0.15)'])).toEqual([]);
  });

  it('storeDetail keeps the merged note on a single-accept hop', () => {
    const mem = new AiMemoryManager();
    const node = makeNode('spRefresh', 'procedure');
    const sections = [{ angle: 'business' as const, text: 'Computes ListPrice from cost and markup.' }];
    const merged = appendUniqueSectionText(sections, [
      'CostPrice * (1 + COALESCE(MarkupPct,0.15))',
    ]);
    mem.storeDetail(node, merged, 'Computes ListPrice from cost and markup.');
    const text = mem.toJSON().detailSlots[node.id].sections.map(s => s.text).join('\n');
    expect(text).toContain('CostPrice * (1 + COALESCE(MarkupPct,0.15))');
    expect(text).toContain('Computes ListPrice from cost and markup.');
  });
});
