// @vitest-environment jsdom
//
// Legend placement: beside an open sidebar, the navigator card, a collapsed panel's reopen rail, or at the edge.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Legend } from '../../../src/components/Legend';
import { TRACE_NAVIGATOR_WIDTH } from '../../../src/components/TraceTreePanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

function legendLeft(inset?: 'sidebar' | 'navigator' | 'rail'): string {
  act(() => root.render(<Legend schemas={['dbo']} inset={inset} />));
  return (host.querySelector('.ln-legend') as HTMLElement).style.left;
}

describe('Legend inset', () => {
  it.each([false, true])('uses source casing to distinguish expanded schema twins (CS=%s)', cs => {
    act(() => root.render(<Legend
      schemas={['Sales', 'sales']}
      identifierCaseSensitive={cs}
      isExpandedSchemaViewActive
      expandedSchemas={new Set(['Sales'])}
    />));
    const labels = [...host.querySelectorAll<HTMLElement>('[data-schema-state]')];
    expect(labels.map(label => label.textContent)).toEqual(['Sales', 'sales']);
    expect(labels.map(label => label.dataset.schemaState)).toEqual(['expanded', cs ? 'collapsed' : 'expanded']);
    const colors = [...host.querySelectorAll<HTMLElement>('.w-4.h-4')].map(swatch => swatch.style.backgroundColor);
    expect(colors[0] === colors[1]).toBe(!cs);
  });

  it('clears the reopen rail so it never covers the collapsed navigator button', () => {
    expect(legendLeft('rail')).toBe('52px');
  });

  it('sits at the edge with no inset and beside an open sidebar', () => {
    expect(legendLeft()).toBe('16px');
    expect(legendLeft('sidebar')).toContain('380px');
  });

  it('follows the navigator card width', () => {
    expect(legendLeft('navigator')).toBe(`${TRACE_NAVIGATOR_WIDTH + 24}px`);
  });

  it('scrolls the expanded schema list and keeps the toggle outside it', () => {
    const schemas = Array.from({ length: 40 }, (_, i) => `schema_${i}`);
    act(() => root.render(<Legend schemas={schemas} />));
    const list = host.querySelector<HTMLElement>('[data-testid="legend-schema-list"]')!;
    const toggle = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('more'))!;
    expect(list.style.maxHeight).toBe('');
    expect(list.contains(toggle)).toBe(false);

    act(() => toggle.click());
    expect(list.querySelectorAll('.w-4.h-4')).toHaveLength(40);
    expect(list.style.maxHeight).not.toBe('');
    expect(list.classList).toContain('overflow-y-auto');
    expect(list.classList).toContain('nowheel');
    expect(toggle.textContent).toBe('Show less');
    expect(list.contains(toggle)).toBe(false);
  });
});

