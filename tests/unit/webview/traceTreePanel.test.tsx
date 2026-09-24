// @vitest-environment jsdom
//
// Trace navigator: pinned L0 starting point, fixed sides with +1 level, leaves directly under levels,
// widget-owned row activation and selection, find reveal into collapsed levels, instant route
// checkboxes and Cmd/Ctrl+click, Expand/Collapse all, edit footer, collapse.
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceTreePanel, type TraceTreeNodeMeta } from '../../../src/components/TraceTreePanel';
import type { TraceTree } from '../../../src/components/traceTreeModel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tree: TraceTree = {
  originId: 'o',
  upstream: [{ side: 'up', depth: 1, nodeIds: ['a'], grow: new Map([['a', ['f']]]) }],
  downstream: [],
  connected: null,
  totalUpstream: 1,
  totalDownstream: 0,
  nextUpstream: ['f'],
  nextDownstream: [],
};

/** Three upstream levels; level 3 starts collapsed. */
const deepTree: TraceTree = {
  originId: 'o',
  upstream: [
    { side: 'up', depth: 1, nodeIds: ['a'], grow: new Map([['a', []]]) },
    { side: 'up', depth: 2, nodeIds: ['b'], grow: new Map([['b', []]]) },
    { side: 'up', depth: 3, nodeIds: ['deep'], grow: new Map([['deep', []]]) },
  ],
  downstream: [],
  connected: null,
  totalUpstream: 3,
  totalDownstream: 0,
  nextUpstream: [],
  nextDownstream: [],
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
    resolveNode,
    selectedNodeId: null as string | null,
    onSelectNode: vi.fn(),
    focusTargetIds: [] as readonly string[],
    onFocusTargets: vi.fn((_ids: string[]) => true),
    onStageIds: null as ReadonlySet<string> | null,
    editCounts: { added: 0, trimmed: 0 },
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

  it('shows the canvas type symbol on leaves in the schema color', () => {
    renderPanel();
    const leaf = host.querySelector('[data-testid="trace-tree-row-up:a"]') as HTMLElement;
    expect(leaf?.querySelector('.ln-tree-type')?.textContent).toBe('●');
    expect(leaf?.style.getPropertyValue('--ln-tree-schema')).not.toBe('');
    const group = host.querySelector('[data-testid="trace-tree-row-trace-up"]');
    expect(group?.querySelector('.ln-tree-type')).toBeNull();
  });

  it('activates a leaf row on click', () => {
    const props = renderPanel();
    // Sides and the first levels start open; the leaf label activates selection.
    const leaf = host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement;
    expect(leaf?.textContent).toContain('name-a');
    act(() => {
      leaf.click();
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('a');
  });

  it('lists leaves directly under their level, sorted by schema then name', () => {
    const mixed: TraceTree = { ...tree, upstream: [{ side: 'up', depth: 1, nodeIds: ['z', 'm', 'a'], grow: new Map() }], totalUpstream: 3 };
    renderPanel({
      tree: mixed,
      resolveNode: (id) => ({ name: `name-${id}`, detail: id === 'm' ? 'dbo' : 'sales', type: 'table' }),
    });
    const level = host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-label');
    expect(level?.querySelector('.ln-tree-name')?.textContent).toBe('L1');
    expect(level?.querySelector('.ln-tree-count')?.textContent).toBe('3');
    const kinds = [...host.querySelectorAll('[data-trace-tree-kind]')].map((row) => row.getAttribute('data-trace-tree-kind'));
    expect(kinds).not.toContain('cluster');
    const order = [...host.querySelectorAll('[data-trace-tree-kind="leaf"]')].map((row) => row.getAttribute('data-testid'));
    expect(order).toEqual(['trace-tree-row-up:m', 'trace-tree-row-up:a', 'trace-tree-row-up:z']);
  });

  it('keeps leaves single-line', () => {
    renderPanel();
    const leafLabel = host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label');
    expect(leafLabel?.querySelector('.ln-tree-suffix')).toBeNull();
    expect(leafLabel?.textContent).toContain('name-a');
  });

  it('keeps side sections fixed: no chevron, a click neither selects nor collapses', () => {
    const props = renderPanel();
    const side = host.querySelector('[data-testid="trace-tree-row-trace-up"]') as HTMLElement;
    expect(side.getAttribute('data-trace-tree-kind')).toBe('side');
    expect(side.querySelector('.ln-tree-chevron')).toBeNull();
    act(() => {
      side.click();
    });
    expect(props.onSelectNode).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).not.toBeNull();
    expect(side.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles a level row on click instead of selecting it', () => {
    const props = renderPanel();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-label') as HTMLElement).click();
    });
    expect(props.onSelectNode).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
  });

  it('collapses and re-expands a level through its chevron', () => {
    renderPanel();
    const chevron = host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-chevron') as HTMLElement;
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
    act(() => {
      chevron.click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-chevron') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
  });

  it('expands and collapses every level from the title bar while the sides stay open', () => {
    renderPanel({ tree: deepTree });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).toBeNull();
    act(() => {
      (host.querySelector('[aria-label="Expand all"]') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).not.toBeNull();
    act(() => {
      (host.querySelector('[aria-label="Collapse all"]') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up"]')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
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
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')).toBeNull();
  });

  it('applies a route on each check, with no separate apply step', () => {
    const props = renderPanel();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith(['a']);
  });

  it('shows the checked routes in the footer and restores everything through Show all', () => {
    const props = renderPanel({ focusTargetIds: ['a'], onStageIds: new Set(['o', 'a']) });
    const box = host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    const footer = host.querySelector('.ln-trace-tree-footer') as HTMLElement;
    expect(footer.textContent).toContain('Viewing 1 route');
    const showAll = [...footer.querySelectorAll('button')].find((button) => button.textContent === 'Show all') as HTMLElement;
    act(() => {
      showAll.click();
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith([]);
  });

  it('adds and removes a route with Cmd/Ctrl+click on a row, without a plain selection', () => {
    const props = renderPanel({ focusTargetIds: ['b'], onStageIds: new Set(['o', 'b']) });
    const label = host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement;
    act(() => {
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith(['b', 'a']);
    expect(props.onSelectNode).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    const again = renderPanel({ focusTargetIds: ['b', 'a'], onStageIds: new Set(['o', 'a', 'b']) });
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    expect(again.onFocusTargets).toHaveBeenCalledWith(['b']);
  });

  it('removes a route when its box is unchecked', () => {
    const props = renderPanel({ focusTargetIds: ['a'], onStageIds: new Set(['o', 'a']) });
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith([]);
  });

  it('dims rows the route view hides from the canvas', () => {
    renderPanel({ focusTargetIds: ['b'], onStageIds: new Set(['o', 'b']) });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')?.className).toContain('ln-tree-row-offstage');
  });

  it('activates the origin through the anchor', () => {
    const props = renderPanel();
    act(() => {
      (host.querySelector('[data-testid="trace-tree-anchor"] .ln-trace-tree-recenter') as HTMLElement).click();
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('o');
  });

  it('offers Reset beside the edit summary only once the scope was edited', () => {
    renderPanel();
    expect(host.querySelector('[data-testid="trace-tree-edits"]')).toBeNull();
    expect(host.querySelector('.ln-trace-tree-footer')?.textContent).toContain('Del: trim');
    act(() => root.unmount());
    root = createRoot(host);
    const props = renderPanel({ editCounts: { added: 2, trimmed: 3 } });
    const edits = host.querySelector('[data-testid="trace-tree-edits"]') as HTMLElement;
    expect(edits.textContent).toContain('3 trimmed · 2 added');
    act(() => {
      (edits.querySelector('button') as HTMLElement).click();
    });
    expect(props.onResetTrace).toHaveBeenCalledTimes(1);
  });

  it('loads one more level from the side header, with the node count in its label', () => {
    const props = renderPanel();
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-grow')).toBeNull();
    const grow = host.querySelector('[data-testid="trace-tree-row-trace-up"] .ln-tree-grow') as HTMLButtonElement;
    expect(grow.disabled).toBe(false);
    expect(grow.getAttribute('aria-label')).toBe('Load one more upstream level (+1 node)');
    act(() => {
      grow.click();
    });
    expect(props.onGrowLevel).toHaveBeenCalledWith(['f']);
  });

  it('disables +1 level when the side has no further level or routes are shown', () => {
    renderPanel();
    const down = host.querySelector('[data-testid="trace-tree-row-trace-down"] .ln-tree-grow') as HTMLButtonElement;
    expect(down.disabled).toBe(true);
    expect(down.getAttribute('aria-label')).toBe('No further downstream level');
    act(() => root.unmount());
    root = createRoot(host);
    renderPanel({ removeKind: 'none' });
    const up = host.querySelector('[data-testid="trace-tree-row-trace-up"] .ln-tree-grow') as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(up.getAttribute('aria-label')).toBe('Show all to load more levels');
  });

  it('reveals a find match inside a collapsed level', () => {
    renderPanel({ tree: deepTree });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).toBeNull();
    const input = host.querySelector('[aria-label="Find node in trace"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'name-deep');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).not.toBeNull();
  });

  it('reveals and selects the canvas selection inside a collapsed level', () => {
    renderPanel({ tree: deepTree, selectedNodeId: 'deep' });
    const row = host.querySelector('[data-testid="trace-tree-row-up:deep"]');
    expect(row).not.toBeNull();
    expect(row?.closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true');
    expect(row?.className).toContain('ln-tree-row-active');
  });

  it('leaves role and selection state to the widget row', () => {
    renderPanel({ selectedNodeId: 'a' });
    const body = host.querySelector('[data-testid="trace-tree-row-up:a"]');
    expect(body?.getAttribute('role')).toBeNull();
    expect(body?.parentElement?.getAttribute('role')).toBe('treeitem');
  });

  it('states a refused route instead of failing silently', () => {
    renderPanel({ onFocusTargets: vi.fn(() => false) });
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-focus-refused"]')).not.toBeNull();
  });

  it('keeps keyboard focus in the list when a trim removes the focused row', () => {
    const twoLeaves: TraceTree = { ...tree, upstream: [{ side: 'up', depth: 1, nodeIds: ['a', 'b'], grow: new Map() }], totalUpstream: 2 };
    renderPanel({ tree: twoLeaves });
    act(() => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement).click();
    });
    expect(document.activeElement?.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
    renderPanel({ tree: { ...tree, upstream: [{ side: 'up', depth: 1, nodeIds: ['b'], grow: new Map() }] } });
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
  });

  it('lists nodes outside both sides under Connected', () => {
    renderPanel({
      tree: { ...tree, connected: { side: 'connected', nodeIds: ['s'], grow: new Map([['s', []]]) } },
    });
    const side = host.querySelector('[data-testid="trace-tree-row-trace-connected"]');
    expect(side?.textContent).toContain('Connected');
    expect(side?.querySelector('.ln-tree-count')?.textContent).toBe('1');
    const box = host.querySelector('[data-testid="trace-tree-row-connected:s"] input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it('hides through the panel close button', () => {
    const props = renderPanel();
    act(() => {
      (host.querySelector('[aria-label="Hide trace navigator"]') as HTMLElement).click();
    });
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('collapses to a reopen button', () => {
    const props = renderPanel({ collapsed: true });
    expect(host.querySelector('[data-testid="trace-tree-panel"]')).toBeNull();
    const rail = host.querySelector('[data-testid="trace-tree-collapsed"] button') as HTMLElement;
    expect(rail?.getAttribute('aria-label')).toBe('Show trace navigator');
    act(() => {
      rail.click();
    });
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});
