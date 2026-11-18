// @vitest-environment jsdom
/**
 * Column statistics table: min/max strings render exactly when a JS number would lose their
 * precision, and each sortable column header is a `<th aria-sort>` holding a button.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatsSection } from '../../../src/components/StatsSection';
import type { ColumnStats, StatsMode, TableStats } from '../../../src/engine/profilingEngine';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function column(name: string, extra: Partial<ColumnStats> = {}): ColumnStats {
  return { name, type: 'bigint', distinctCount: 3, nullCount: 0, nullPercent: 0, completeness: 1, uniqueness: 1, ...extra };
}

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

function show(columns: ColumnStats[], mode: StatsMode = 'standard'): void {
  const stats: TableStats = { rowCount: 10, columns, sampled: false };
  act(() => {
    root.render(<StatsSection statsState={{ phase: 'result', stats, mode }} onRequestStats={() => {}} standardModeEnabled />);
  });
}

function expandAll(): void {
  const toggle = [...host.querySelectorAll('[role="button"]')].find(el => el.textContent === 'Expand all')!;
  act(() => { (toggle as HTMLElement).click(); });
}

describe('StatsSection min/max', () => {
  it('shows a 17-digit bigint minimum exactly instead of the rounded double', () => {
    show([column('Id', { min: '9007199254740993', max: '9007199254740995', mean: 1, stdDev: 1 })]);
    expandAll();
    expect(host.textContent).toContain('9007199254740993 – 9007199254740995');
  });

  it('shows a decimal(38) value exactly', () => {
    show([column('Amt', { type: 'decimal(38,10)', min: '12345678901234567890.1234567891', max: '1', mean: 1, stdDev: 1 })]);
    expandAll();
    expect(host.textContent).toContain('12345678901234567890.1234567891');
  });

  it('keeps thousands separators for a value a number holds exactly', () => {
    show([column('Id', { min: '1234567', max: '2500', mean: 1, stdDev: 1 })]);
    expandAll();
    expect(host.textContent).toContain('1,234,567 – 2,500');
  });

  it.each([
    ['1000.0', '1,000'],
    ['1500.00', '1,500'],
    ['1234.5', '1,234.5'],
    ['1.55', '1.6'],
    ['-0.5', '-0.5'],
    ['1e+006', '1,000,000'],
    ['2.5E3', '2,500'],
  ])('formats %s as the number display rule does (%s)', (raw, shown) => {
    show([column('Amt', { min: raw, max: raw, mean: 1, stdDev: 1 })]);
    expandAll();
    expect(host.textContent).toContain(`${shown} – ${shown}`);
  });

  it('shows a 16-digit value and non-numeric text as the source string', () => {
    show([column('Amt', { min: '1234567890123.4567', max: '2020-01-01', mean: 1, stdDev: 1 })]);
    expandAll();
    expect(host.textContent).toContain('1234567890123.4567 – 2020-01-01');
  });
});

describe('StatsSection sortable headers', () => {
  it('renders Column, Null% and Distinct as th with aria-sort around a button, and updates it on sort', () => {
    show([column('b'), column('a')], 'quick');
    const headers = [...host.querySelectorAll('th')];
    expect(headers.map(h => h.textContent)).toEqual(['Column#', 'Type', 'Null%', 'Distinct']);
    const sortable = headers.filter(h => h.hasAttribute('aria-sort'));
    expect(sortable.map(h => h.getAttribute('aria-sort'))).toEqual(['none', 'none', 'none']);
    const nullButton = headers[2].querySelector('button')!;
    act(() => { nullButton.click(); });
    expect(host.querySelectorAll('th')[2].getAttribute('aria-sort')).toBe('descending');
    act(() => { host.querySelectorAll('th')[2].querySelector('button')!.click(); });
    expect(host.querySelectorAll('th')[2].getAttribute('aria-sort')).toBe('ascending');
  });
});
