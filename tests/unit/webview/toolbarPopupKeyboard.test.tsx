// @vitest-environment jsdom
/**
 * Pins keyboard and click behaviour of toolbar popups: a filter row toggles from its text as well as
 * its checkbox, a filter panel takes focus on open and returns it to its trigger on Escape, and the
 * Graph Analysis menu moves between items with the arrow keys.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeFilterDropdown } from '../../../src/components/TypeFilterDropdown';
import { Toolbar } from '../../../src/components/Toolbar';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

function key(target: Element, k: string): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
}

describe('filter panel', () => {
  it('toggles a type from its row text, takes focus on open and returns it to the trigger on Escape', async () => {
    const onToggleType = vi.fn();
    act(() => {
      root.render(<TypeFilterDropdown types={new Set(['table', 'view', 'procedure', 'function', 'external'])} onToggleType={onToggleType} isNarrowed={false} />);
    });
    const trigger = document.querySelector('button[aria-label="Filter object types"]') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    trigger.focus();
    act(() => trigger.click());
    await flush();

    const panel = document.querySelector('[role="dialog"][aria-label="Filter object types"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true);

    const viewText = Array.from(panel.querySelectorAll('span')).find((s) => s.textContent === 'View') as HTMLElement;
    act(() => viewText.click());
    expect(onToggleType).toHaveBeenCalledWith('view');

    key(document.activeElement as Element, 'Escape');
    await flush();
    expect(document.querySelector('[aria-label="Filter object types"][role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Graph Analysis menu', () => {
  it('opens with ArrowDown on its trigger and moves between items with the arrow keys', async () => {
    const onOpenAnalysis = vi.fn();
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
        <Toolbar
          {...({
            types: new Set(['table']),
            onToggleType: () => {},
            hideIsolated: false,
            onToggleIsolated: () => {},
            focusSchemas: new Set(),
            onToggleFocusSchema: () => {},
            onRefresh: () => {},
            onBack: () => {},
            visibleNodeIds: new Set(),
            metrics: { totalNodes: 0, totalEdges: 0, rootNodes: 0, leafNodes: 0 },
            renderedNodeCount: 0,
            overviewThreshold: 150,
            renderLimit: 750,
            onOpenAnalysis,
          } as unknown as ComponentProps<typeof Toolbar>)}
        />
        </VsCodeProvider>
      );
    });
    const trigger = document.querySelector('button[aria-label="Graph Analysis"]') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    key(trigger, 'ArrowDown');
    await flush();

    const items = Array.from(document.querySelectorAll('[role="menu"][aria-label="Graph analysis tools"] [role="menuitem"]')) as HTMLElement[];
    expect(items.map((i) => i.textContent)).toEqual(['Islands', 'Hubs', 'Orphan Nodes', 'Longest Path', 'Cycles', 'External Refs']);
    expect(document.activeElement).toBe(items[0]);

    key(items[0], 'ArrowDown');
    await flush();
    expect(document.activeElement).toBe(items[1]);

    act(() => (document.activeElement as HTMLElement).click());
    expect(onOpenAnalysis).toHaveBeenCalledWith('hubs');
  });
});
