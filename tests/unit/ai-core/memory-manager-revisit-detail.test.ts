import { describe, expect, it } from 'vitest';
import { AiMemoryManager, appendUniqueSectionText } from '../../../src/ai/session/memoryManager';
import type { LineageNode } from '../../../src/engine/types';

/** A revisit's `storeDetail` call appends to the slot rather than overwriting the first visit's content. */

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

  it('keeps a note that is merely a substring of an earlier section — containment is not identity', () => {
    const sections = [{
      angle: 'business' as const,
      text: 'DiscountVal = BaseAmt * COALESCE(DiscountPct,0) per StagingID.',
    }];
    const merged = appendUniqueSectionText(sections, [
      'BaseAmt * COALESCE(DiscountPct,0)',
      '  BaseAmt * COALESCE(DiscountPct,0)  ',
    ]);
    // The two extras are exact duplicates of each other (after trim), so only one copy is merged in.
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe(
      'DiscountVal = BaseAmt * COALESCE(DiscountPct,0) per StagingID.\nBaseAmt * COALESCE(DiscountPct,0)',
    );
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
    const node = makeNode('spRefresh');
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
