// @vitest-environment jsdom
/**
 * Pins keyboard and click behaviour of toolbar popups: a filter row toggles from its text as well as
 * its checkbox, a filter panel takes focus on open and returns it to its trigger on Escape, and the
 * Graph Analysis menu moves between items with the arrow keys and closes on Escape without exiting the
 * active mode; the schema clusters toggle keeps one
 * label and carries its state in aria-pressed; the leave confirmation focuses Cancel.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeFilterDropdown } from '../../../src/components/TypeFilterDropdown';
import { Toolbar } from '../../../src/components/Toolbar';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { useKeyboardShortcut } from '../../../src/hooks/useKeyboardShortcut';

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

// `@floating-ui/react`'s `FloatingFocusManager` and `useListNavigation` move focus via
// `requestAnimationFrame` (see `enqueueFocus` in its bundle), not synchronously with render or a
// keydown handler, so an activeElement assertion must poll for that move instead of racing it
// with a fixed-duration sleep.
const focusSettled = (assertion: () => void) => act(() => vi.waitFor(assertion, { timeout: 2000, interval: 10 }));

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

    let panel!: HTMLElement;
    await focusSettled(() => {
      panel = document.querySelector('[role="dialog"][aria-label="Filter object types"]') as HTMLElement;
      expect(panel).not.toBeNull();
      expect(panel.contains(document.activeElement)).toBe(true);
    });

    const viewText = Array.from(panel.querySelectorAll('span')).find((s) => s.textContent === 'View') as HTMLElement;
    act(() => viewText.click());
    expect(onToggleType).toHaveBeenCalledWith('view');

    key(document.activeElement as Element, 'Escape');
    await focusSettled(() => {
      expect(document.querySelector('[aria-label="Filter object types"][role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });
});

function toolbarProps(extra: Record<string, unknown>): ComponentProps<typeof Toolbar> {
  return {
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
    ...extra,
  } as unknown as ComponentProps<typeof Toolbar>;
}

describe('Graph Analysis menu', () => {
  it('opens with ArrowDown on its trigger and moves between items with the arrow keys', async () => {
    const onOpenAnalysis = vi.fn();
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
        <Toolbar {...toolbarProps({ onOpenAnalysis })} />
        </VsCodeProvider>
      );
    });
    const trigger = document.querySelector('button[aria-label="Graph Analysis"]') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    key(trigger, 'ArrowDown');

    let items: HTMLElement[] = [];
    await focusSettled(() => {
      items = Array.from(document.querySelectorAll('[role="menu"][aria-label="Graph analysis tools"] [role="menuitem"]')) as HTMLElement[];
      expect(items.map((i) => i.textContent)).toEqual(['Islands', 'Hubs', 'Orphan Nodes', 'Longest Path', 'Cycles', 'External Refs']);
      expect(document.activeElement).toBe(items[0]);
    });

    key(items[0], 'ArrowDown');
    await focusSettled(() => { expect(document.activeElement).toBe(items[1]); });

    act(() => (document.activeElement as HTMLElement).click());
    expect(onOpenAnalysis).toHaveBeenCalledWith('hubs');
  });
});

describe('Graph Analysis menu while an analysis is active', () => {
  function ModeExit({ onExit }: { onExit: () => void }) {
    useKeyboardShortcut('Escape', onExit, false, { allowEmptyTextEntry: true });
    return null;
  }

  it('opens on click with focus in the menu, and one Escape closes the menu without exiting the mode', async () => {
    const onExit = vi.fn();
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
        <ModeExit onExit={onExit} />
        <Toolbar {...toolbarProps({ onOpenAnalysis: () => {} })} isAnalysisActive canStartNewScopedMode={false} />
        </VsCodeProvider>
      );
    });
    const trigger = document.querySelector('button[aria-label="Graph Analysis"]') as HTMLButtonElement;
    trigger.focus();
    act(() => trigger.click());
    const menu = () => document.querySelector('[role="menu"][aria-label="Graph analysis tools"]');
    await focusSettled(() => { expect(menu()?.contains(document.activeElement)).toBe(true); });

    key(document.activeElement as Element, 'Escape');
    await focusSettled(() => { expect(menu()).toBeNull(); });
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('schema clusters toggle', () => {
  it('keeps one label and reports hidden clusters through aria-pressed', () => {
    const render = (show: boolean) => act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <Toolbar {...toolbarProps({ graphMode: 'overview', isExpandedSchemaViewActive: true, onResetExpandedSchemaView: () => {}, onToggleExpandedSchemaClusters: () => {}, showExpandedSchemaClusters: show })} />
        </VsCodeProvider>
      );
    });
    render(true);
    expect(document.querySelector('button[aria-label="Hide schema clusters"]')?.getAttribute('aria-pressed')).toBe('false');
    render(false);
    expect(document.querySelector('button[aria-label="Hide schema clusters"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('leave confirmation', () => {
  it('focuses Cancel when Load New Project asks to leave a modified view', async () => {
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <Toolbar {...toolbarProps({ isFilterDirty: true })} />
        </VsCodeProvider>
      );
    });
    act(() => (document.querySelector('button[aria-label="Load New Project"]') as HTMLButtonElement).click());
    await focusSettled(() => { expect(document.activeElement?.textContent?.trim()).toBe('Cancel'); });
  });
});
