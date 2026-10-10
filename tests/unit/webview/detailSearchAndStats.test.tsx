// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetailSearchSidebar } from '../../../src/components/DetailSearchSidebar';
import { StatsSection } from '../../../src/components/StatsSection';
import type { ColumnStats } from '../../../src/engine/profilingEngine';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('detail search and statistics', () => {
  it('finds matches in function SQL bodies', () => {
    act(() => root.render(<DetailSearchSidebar onClose={() => {}} onResultClick={() => {}}
      allNodes={[{ id: '[dbo].[ComputeTotal]', schema: 'dbo', name: 'ComputeTotal', type: 'function', bodyScript: 'RETURN needle' }]} />));
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.ln-detail-search-result')).toHaveLength(1);
    expect(host.textContent).toContain('Functions');
    expect(host.textContent).toContain('ComputeTotal');
  });

  it.each([
    { type: 'bigint', min: '9007199254740993', max: '9223372036854775807' },
    { type: 'decimal(38, 5)', min: '0.00001', max: '123456789012345678901234567890123.45678' },
  ])('preserves exact $type extrema returned by SQL', ({ type, min, max }) => {
    const column: ColumnStats = {
      name: 'amount', type, distinctCount: 2, nullCount: 0, nullPercent: 0,
      completeness: 1, uniqueness: 1, min, max, mean: 1,
    };
    act(() => root.render(<StatsSection standardModeEnabled onRequestStats={() => {}}
      statsState={{ phase: 'result', mode: 'standard', stats: { rowCount: 2, sampled: false, columns: [column] } }} />));
    const expand = [...host.querySelectorAll('[role="button"]')].find(el => el.textContent === 'Expand all')!;
    act(() => expand.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const text = host.textContent!.replace(/,/g, '');
    expect(text).toContain(min);
    expect(text).toContain(max);
  });
});
