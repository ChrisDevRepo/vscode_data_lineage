// @vitest-environment jsdom
//
// Pure-logic cover for the two pieces added to `GraphCanvas`: the reverse map a node click
// uses to land the AI report on its section, and the cache key that lets a re-run of the same view
// restore its pane layout instead of resetting it. Both are plain functions exported alongside the
// component specifically so they can be exercised without mounting the 107-prop canvas.
import { describe, expect, it } from 'vitest';
import { aiLayoutCacheKey, sectionsForNode } from '../../../src/components/GraphCanvas';
import type { AiReportSection } from '../../../src/components/AiDescriptionOverlay';

function section(n: number, nodeIds: string[]): AiReportSection {
  return { n, label: `Section ${n}`, nodeIds };
}

describe('sectionsForNode', () => {
  it('returns every section number that badged the node, in document order', () => {
    const sections = [
      section(1, ['a', 'b']),
      section(2, ['b', 'c']),
      section(3, ['d']),
    ];
    expect(sectionsForNode(sections, 'b')).toEqual([1, 2]);
  });

  it('returns an empty array for a node badged into no section', () => {
    const sections = [section(1, ['a']), section(2, ['c'])];
    expect(sectionsForNode(sections, 'z')).toEqual([]);
  });

  it('returns an empty array when there are no sections at all', () => {
    expect(sectionsForNode([], 'a')).toEqual([]);
  });
});

describe('aiLayoutCacheKey', () => {
  it('combines the origin id and view name', () => {
    expect(aiLayoutCacheKey('bm-1', 'Orders view')).toBe('bm-1::Orders view');
  });

  it('falls back to a "preview" origin when no id is given', () => {
    expect(aiLayoutCacheKey(undefined, 'Ad-hoc preview')).toBe('preview::Ad-hoc preview');
  });

  it('keeps two different profiles on the same view name from colliding', () => {
    const a = aiLayoutCacheKey('bm-1', 'Orders view');
    const b = aiLayoutCacheKey('bm-2', 'Orders view');
    expect(a).not.toBe(b);
  });
});
