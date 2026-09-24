// @vitest-environment jsdom
//
// Trace navigator shell: L0 anchor, browsable sides/levels, row activation,
// relocated full-model toggle in the footer, collapse rail.
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceTreePanel, type TraceTreeNodeMeta } from '../../../src/components/TraceTreePanel';
import type { TraceTree } from '../../../src/components/traceTreeModel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tree: TraceTree = {
  originId: 'o',
  upstream: [{ side: 'up', depth: 1, nodeIds: ['a'] }],
  downstream: [],
  totalUpstream: 1,
  totalDownstream: 0,
  leafGrow: new Map([['a', ['f']]]),
};

const resolveNode = (id: string): TraceTreeNodeMeta => ({
  name: `name-${id}`,
  detail: 'dbo',
  type: id === 'a' ? 'view' : 'table',
});

function renderPanel(overrides: Partial<React.ComponentProps<typeof TraceTreePanel>> = {}) {
  const props = {
    tree,
    originName: 'Origin Object',
    collapsed: false,
    onToggleCollapse: vi.fn(),
    useFullModel: false,
    onToggleFullModel: vi.fn(),
    filteredOutCount: 0,
    resolveNode,
    selectedNodeId: null as string | null,
    onSelectNode: vi.fn(),
    onFocusPaths: vi.fn(() => true),
    onExitFocus: vi.fn(),
    focusActive: false,
    onPruneNode: vi.fn(),
    onResetTrace: vi.fn(),
    onGrowLevel: vi.fn(),
    removeKind: 'trace-prune' as const,
    ...overrides,
  };
  act(() => {
    root.render(
      <StrictMode>
        <TraceTreePanel {...props} />
      </StrictMode>,
    );
  });
  return props;
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

describe('TraceTreePanel', () => {
  it('pins the L0 anchor with origin name and counts', () => {
    renderPanel();
    const anchor = host.querySelector('[data-testid="trace-tree-anchor"]');
    expect(anchor?.textContent).toContain('Origin Object');
    expect(anchor?.textContent).toContain('↑1');
  });

  it('shows the canvas type symbol on leaves and the schema color on clusters', () => {
    renderPanel();
    const leaf = host.querySelector('[data-testid="trace-tree-row-a"]');
    expect(leaf?.querySelector('.ln-tree-type')?.textContent).toBe('●');
    const cluster = host.querySelector('[data-testid="trace-tree-row-trace-up-L1-schema-dbo"]') as HTMLElement;
    expect(cluster?.style.getPropertyValue('--ln-tree-schema')).not.toBe('');
    const group = host.querySelector('[data-testid="trace-tree-row-trace-up"]');
    expect(group?.querySelector('.ln-tree-type')).toBeNull();
  });

  it('activates a leaf row on click', () => {
    const props = renderPanel();
    // Sides and schema clusters start open; the leaf label activates selection.
    const leaf = host.querySelector('[data-testid="trace-tree-row-a"] .ln-tree-label') as HTMLElement;
    expect(leaf?.textContent).toContain('name-a');
    act(() => {
      leaf.click();
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('a');
  });

  it('nests level then schema with a swatch, count, and single-line leaves', () => {
    renderPanel();
    const level = host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-label');
    expect(level?.textContent).toContain('L1 · 1 node');
    const cluster = host.querySelector('[data-testid="trace-tree-row-trace-up-L1-schema-dbo"]');
    expect(cluster?.querySelector('.ln-tree-swatch')).not.toBeNull();
    expect(cluster?.querySelector('.ln-tree-count')?.textContent).toBe('1');
    expect(cluster?.querySelector('.ln-tree-type')).toBeNull();
    const leafLabel = host.querySelector('[data-testid="trace-tree-row-a"] .ln-tree-label');
    expect(leafLabel?.querySelector('.ln-tree-suffix')).toBeNull();
    expect(leafLabel?.textContent).toContain('name-a');
  });

  it('toggles groups instead of selecting them', () => {
    const props = renderPanel();
    const groupLabel = host.querySelector('[data-testid="trace-tree-row-trace-up"] .ln-tree-label') as HTMLElement;
    expect(groupLabel.closest('[data-trace-tree-kind]')?.getAttribute('data-trace-tree-kind')).toBe('group');
    act(() => {
      groupLabel.click();
    });
    expect(props.onSelectNode).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).toBeNull();
  });

  it('collapses and re-expands a level through its chevron', () => {
    renderPanel();
    const chevron = host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-chevron') as HTMLElement;
    expect(host.querySelector('[data-testid="trace-tree-row-a"]')).not.toBeNull();
    act(() => {
      chevron.click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-a"]')).toBeNull();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-chevron') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-a"]')).not.toBeNull();
  });

  it('collapses a schema cluster without touching its level', () => {
    renderPanel();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1-schema-dbo"] .ln-tree-chevron') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-a"]')).toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).not.toBeNull();
  });

  it('hosts the relocated full-model toggle in the footer', () => {
    const props = renderPanel({ filteredOutCount: 3 });
    const checkbox = host.querySelector('.ln-trace-tree-footer input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    expect(host.querySelector('.ln-trace-tree-footer')?.textContent).toContain('+3');
    act(() => {
      checkbox.click();
    });
    expect(props.onToggleFullModel).toHaveBeenCalledTimes(1);
  });

  it('finds without hiding: count shown, rows intact, Enter selects', () => {
    const props = renderPanel();
    const input = host.querySelector('[aria-label="Find node in trace"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'name-a');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')?.textContent).toBe('1/1');
    // Non-matching structure stays mounted: find never filters.
    expect(host.querySelector('[data-testid="trace-tree-row-trace-down"]')).not.toBeNull();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('a');
  });

  it('shows 0/0 for a miss and clears on Escape', () => {
    renderPanel();
    const input = host.querySelector('[aria-label="Find node in trace"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'zzz-no-such-node');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')?.textContent).toBe('0/0');
    expect(host.querySelector('[data-testid="trace-tree-row-a"]')).not.toBeNull();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')).toBeNull();
  });

  it('focuses checked paths and clears the checks', () => {
    const props = renderPanel();
    const box = host.querySelector('[data-testid="trace-tree-row-a"] input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      box.click();
    });
    const focus = [...host.querySelectorAll('.ln-trace-tree-actions button')].find(
      (button) => button.textContent?.startsWith('Focus paths'),
    ) as HTMLElement;
    expect(focus?.textContent).toContain('(1)');
    act(() => {
      focus.click();
    });
    expect(props.onFocusPaths).toHaveBeenCalledWith(['a']);
    const clear = [...host.querySelectorAll('.ln-trace-tree-actions button')].find(
      (button) => button.textContent === 'Clear',
    ) as HTMLElement;
    act(() => {
      clear.click();
    });
    expect(host.querySelector('.ln-trace-tree-actions')?.textContent).toContain('(0)');
  });

  it('exits an active focus from the footer', () => {
    const props = renderPanel({ focusActive: true });
    const exit = [...host.querySelectorAll('.ln-trace-tree-actions button')].find(
      (button) => button.textContent === 'Exit focus',
    ) as HTMLElement;
    expect(exit).not.toBeUndefined();
    act(() => {
      exit.click();
    });
    expect(props.onExitFocus).toHaveBeenCalledTimes(1);
  });

  it('activates the origin through the anchor', () => {
    const props = renderPanel();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-anchor"] .ln-trace-tree-recenter') as HTMLElement).click();
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('o');
  });

  it('resets the trace through the anchor button', () => {
    const props = renderPanel();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-anchor"] [aria-label="Reset trace to its starting scope"]') as HTMLElement).click();
    });
    expect(props.onResetTrace).toHaveBeenCalledTimes(1);
  });

  it('grows one level from a leaf with candidates', () => {
    const props = renderPanel();
    const grow = host.querySelector('[data-testid="trace-tree-row-a"] .ln-tree-grow') as HTMLButtonElement;
    expect(grow.disabled).toBe(false);
    act(() => {
      grow.click();
    });
    expect(props.onGrowLevel).toHaveBeenCalledWith(['f']);
  });

  it('disables growth where the model has no further neighbors', () => {
    renderPanel({
      tree: { ...tree, leafGrow: new Map([['a', []]]) },
    });
    const grow = host.querySelector('[data-testid="trace-tree-row-a"] .ln-tree-grow') as HTMLButtonElement;
    expect(grow.disabled).toBe(true);
    expect(grow.title).toContain('No further levels');
  });

  it('prunes the selected row on Delete, never from the find box', () => {
    const props = renderPanel({ selectedNodeId: 'a' });
    const section = host.querySelector('[data-testid="trace-tree-panel"]') as HTMLElement;
    act(() => {
      section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(props.onPruneNode).toHaveBeenCalledWith('a');
  });

  it('ignores Delete in non-editable modes', () => {
    const props = renderPanel({ selectedNodeId: 'a', removeKind: 'none' as const });
    const section = host.querySelector('[data-testid="trace-tree-panel"]') as HTMLElement;
    act(() => {
      section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(props.onPruneNode).not.toHaveBeenCalled();
  });

  it('never prunes from inside the find box', () => {
    const props = renderPanel({ selectedNodeId: 'a' });
    const input = host.querySelector('[aria-label="Find node in trace"]') as HTMLElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(props.onPruneNode).not.toHaveBeenCalled();
  });

  it('collapses to a rail with an expand affordance', () => {
    const props = renderPanel({ collapsed: true });
    expect(host.querySelector('[data-testid="trace-tree-panel"]')).toBeNull();
    const rail = host.querySelector('[data-testid="trace-tree-collapsed"] button') as HTMLElement;
    expect(rail?.getAttribute('aria-label')).toBe('Expand trace navigator');
    act(() => {
      rail.click();
    });
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});
