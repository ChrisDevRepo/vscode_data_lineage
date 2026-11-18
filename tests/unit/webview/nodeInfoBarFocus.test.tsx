// @vitest-environment jsdom
/**
 * The In/Out/Unresolved/Excluded counters open their popover for keyboard users too: the counter
 * is focusable and focusing it (after a key press) shows the same list a hover shows.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeInfoBar } from '../../../src/components/NodeInfoBar';
import type { CatalogEntry, ParseStats } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (name: string): CatalogEntry => ({ name, schema: 'dbo', type: 'table' }) as CatalogEntry;
const catalog = { a: entry('Alpha'), b: entry('Beta'), c: entry('Gamma') } as Record<string, CatalogEntry>;
const parseStats = { spDetails: [{ name: 'dbo.Alpha', unrelated: ['#tmp'], excluded: [] }] } as unknown as ParseStats;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(
    <NodeInfoBar
      nodeId="a"
      catalog={catalog}
      neighborIndex={{ a: { in: ['b'], out: ['c'] } }}
      visibleNodeIds={new Set(['a', 'b', 'c'])}
      parseStats={parseStats}
      onClose={() => {}}
    />,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const counter = (text: string) => [...host.querySelectorAll<HTMLElement>('span')].find(s => s.textContent === text)!;

describe('NodeInfoBar popovers', () => {
  it.each([
    ['In: 1', 'Beta'],
    ['Out: 1', 'Gamma'],
    ['Unresolved: 1', '#tmp'],
  ])('opens the %s list when the counter takes keyboard focus', async (label, item) => {
    const el = counter(label);
    expect(el.tabIndex).toBe(0);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); });
    act(() => { el.focus(); });
    expect(document.body.textContent).toContain(item);
    act(() => { el.blur(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(document.body.textContent).not.toContain(item);
  });
});
