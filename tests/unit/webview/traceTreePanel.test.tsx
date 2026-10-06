// @vitest-environment jsdom
//
// Trace navigator: L0 starting point as the title, fixed sides with +1 level, leaves directly under
// levels, widget-owned row activation and selection, find on demand with reveal into collapsed levels,
// instant route checkboxes and Cmd/Ctrl+click, Expand/Collapse all, content-sized card, status footer, collapse.
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceTreePanel, type TraceTreeNodeMeta } from '../../../src/components/TraceTreePanel';
import type { TraceTree } from '../../../src/engine/traceTree';

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
  color: '#123456',
});

async function renderPanel(overrides: Partial<React.ComponentProps<typeof TraceTreePanel>> = {}) {
  const props = {
    tree,
    originName: 'Origin Object',
    collapsed: false,
    onToggleCollapse: vi.fn(),
    resolveNode,
    selectedNodeId: null as string | null,
    onSelectNode: vi.fn(),
    onFocusNode: vi.fn(),
    onShowWhole: vi.fn(),
    focusTargetIds: [] as readonly string[],
    onFocusTargets: vi.fn((_ids: string[]) => true),
    onStageIds: null as ReadonlySet<string> | null,
    editCounts: { added: 0, trimmed: 0 },
    onResetTrace: vi.fn(),
    onGrowLevel: vi.fn(),
    canGrow: true,
    ...overrides,
  };
  await act(async () => {
    root.render(
      <StrictMode>
        <TraceTreePanel {...props} />
      </StrictMode>,
    );
  });
  return props;
}

/** Opens find from the title bar and returns its input. */
async function openFind(): Promise<HTMLInputElement> {
  await act(async () => {
    (host.querySelector('button[aria-label="Find node"]') as HTMLButtonElement).click();
  });
  return host.querySelector('[aria-label="Find node in trace"]') as HTMLInputElement;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe('TraceTreePanel', () => {
  it('titles the panel with the L0 starting point, find closed until asked for', async () => {
    await renderPanel();
    const anchor = host.querySelector('[data-testid="trace-tree-anchor"]');
    expect(anchor?.textContent).toContain('L0');
    expect(anchor?.textContent).toContain('Origin Object');
    expect(host.querySelector('[aria-label="Find node in trace"]')).toBeNull();
  });

  it('opens find with Cmd/Ctrl+F and closes it on Escape', async () => {
    await renderPanel();
    const panel = host.querySelector('[data-testid="trace-tree-panel"]') as HTMLElement;
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    });
    const input = host.querySelector('[aria-label="Find node in trace"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[aria-label="Find node in trace"]')).toBeNull();
  });

  it('sizes the card to its visible rows', async () => {
    await renderPanel({ tree: deepTree });
    const body = host.querySelector('.ln-trace-tree-body') as HTMLElement;
    // Up side, L1, a, L2, b, L3 (closed), down side.
    expect(body.style.height).toBe(`${7 * 22}px`);
    await act(async () => {
      (host.querySelector('button[aria-label="Collapse all"]') as HTMLButtonElement).click();
    });
    // Up side, L1, L2, L3, down side.
    expect(body.style.height).toBe(`${5 * 22}px`);
  });

  it('shows the canvas type symbol on leaves in the schema color', async () => {
    await renderPanel();
    const leaf = host.querySelector('[data-testid="trace-tree-row-up:a"]') as HTMLElement;
    expect(leaf?.querySelector('.ln-tree-type')?.textContent).toBe('●');
    expect(leaf?.style.getPropertyValue('--ln-tree-schema'), 'the caller-resolved canvas colour').toBe('#123456');
    const group = host.querySelector('[data-testid="trace-tree-row-trace-up"]');
    expect(group?.querySelector('.ln-tree-type')).toBeNull();
  });

  it('activates a leaf row on click', async () => {
    const props = await renderPanel();
    // Sides and the first levels start open; the leaf label activates selection.
    const leaf = host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement;
    expect(leaf?.textContent).toContain('name-a');
    await act(async () => {
      leaf.click();
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('a');
  });

  it('lists leaves directly under their level, sorted by schema then name', async () => {
    const mixed: TraceTree = { ...tree, upstream: [{ side: 'up', depth: 1, nodeIds: ['z', 'm', 'a'], grow: new Map() }], totalUpstream: 3 };
    await renderPanel({
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

  it('keeps leaves single-line', async () => {
    await renderPanel();
    const leafLabel = host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label');
    expect(leafLabel?.querySelector('.ln-tree-suffix')).toBeNull();
    expect(leafLabel?.textContent).toContain('name-a');
  });

  it('keeps side sections fixed: no chevron, a click neither selects nor collapses', async () => {
    const props = await renderPanel();
    const side = host.querySelector('[data-testid="trace-tree-row-trace-up"]') as HTMLElement;
    expect(side.getAttribute('data-trace-tree-kind')).toBe('side');
    expect(side.querySelector('.ln-tree-chevron')).toBeNull();
    await act(async () => {
      side.click();
    });
    expect(props.onSelectNode).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).not.toBeNull();
    expect(side.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles a level row on click instead of selecting it', async () => {
    const props = await renderPanel();
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-label') as HTMLElement).click();
    });
    expect(props.onSelectNode).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
  });

  it('collapses and re-expands a level through its chevron', async () => {
    await renderPanel();
    const chevron = host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-chevron') as HTMLElement;
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
    await act(async () => {
      chevron.click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-chevron') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
  });

  it('sizes the card to the rows it shows again after being hidden and reopened', async () => {
    await renderPanel({ tree: deepTree });
    await act(async () => {
      (host.querySelector('button[aria-label="Collapse all"]') as HTMLButtonElement).click();
    });
    // Up side, L1, L2, L3, down side.
    expect((host.querySelector('.ln-trace-tree-body') as HTMLElement).style.height).toBe(`${5 * 22}px`);
    await renderPanel({ tree: deepTree, collapsed: true });
    await renderPanel({ tree: deepTree, collapsed: false });
    // The reopened tree starts from its initial open levels: up side, L1, a, L2, b, L3 (closed), down side.
    expect((host.querySelector('.ln-trace-tree-body') as HTMLElement).style.height).toBe(`${7 * 22}px`);
    expect(host.querySelector('[data-testid="trace-tree-row-up:b"]'), 'the last open leaf is not clipped').not.toBeNull();
  });

  it('expands and collapses every level from the title bar while the sides stay open', async () => {
    await renderPanel({ tree: deepTree });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).toBeNull();
    await act(async () => {
      (host.querySelector('[aria-label="Expand all"]') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).not.toBeNull();
    await act(async () => {
      (host.querySelector('[aria-label="Collapse all"]') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up"]')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('finds without hiding: count shown, rows intact, Enter selects', async () => {
    const props = await renderPanel();
    const input = await openFind();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'name-a');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')?.textContent).toBe('1/1');
    // Non-matching structure stays mounted: find never filters.
    expect(host.querySelector('[data-testid="trace-tree-row-trace-down"]')).not.toBeNull();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.onSelectNode).toHaveBeenCalledWith('a');
  });

  it('shows 0/0 for a miss and clears on Escape', async () => {
    await renderPanel();
    const input = await openFind();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'zzz-no-such-node');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')?.textContent).toBe('0/0');
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-find-count"]')).toBeNull();
  });

  it('applies a route on each check, with no separate apply step', async () => {
    const props = await renderPanel();
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith(['a']);
  });

  it('shows the checked routes in the footer and restores everything through Show all', async () => {
    const props = await renderPanel({ focusTargetIds: ['a'], onStageIds: new Set(['o', 'a']) });
    const box = host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    const footer = host.querySelector('.ln-trace-tree-footer') as HTMLElement;
    expect(footer.textContent).toContain('Viewing 1 route');
    const showAll = [...footer.querySelectorAll('button')].find((button) => button.textContent === 'Show all') as HTMLElement;
    await act(async () => {
      showAll.click();
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith([]);
  });

  it('adds and removes a route with Cmd/Ctrl+click on a row, without a plain selection', async () => {
    const props = await renderPanel({ focusTargetIds: ['b'], onStageIds: new Set(['o', 'b']) });
    const label = host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement;
    await act(async () => {
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith(['b', 'a']);
    expect(props.onSelectNode).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const again = await renderPanel({ focusTargetIds: ['b', 'a'], onStageIds: new Set(['o', 'a', 'b']) });
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    expect(again.onFocusTargets).toHaveBeenCalledWith(['b']);
  });

  it('removes a route when its box is unchecked', async () => {
    const props = await renderPanel({ focusTargetIds: ['a'], onStageIds: new Set(['o', 'a']) });
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(props.onFocusTargets).toHaveBeenCalledWith([]);
  });

  it('dims rows the route view hides from the canvas', async () => {
    await renderPanel({ focusTargetIds: ['b'], onStageIds: new Set(['o', 'b']) });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')?.className).toContain('ln-tree-row-offstage');
  });

  it('shows the whole trace from the starting point, without selecting it', async () => {
    const props = await renderPanel();
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-anchor"]') as HTMLElement).click();
    });
    expect(props.onShowWhole).toHaveBeenCalledTimes(1);
    expect(props.onSelectNode).not.toHaveBeenCalled();
  });

  it('offers Reset beside the edit summary only once the scope was edited', async () => {
    await renderPanel();
    expect(host.querySelector('[data-testid="trace-tree-edits"]')).toBeNull();
    expect(host.querySelector('.ln-trace-tree-footer')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const props = await renderPanel({ editCounts: { added: 2, trimmed: 3 } });
    const edits = host.querySelector('[data-testid="trace-tree-edits"]') as HTMLElement;
    expect(edits.textContent).toContain('3 trimmed · 2 added');
    await act(async () => {
      (edits.querySelector('button') as HTMLElement).click();
    });
    expect(props.onResetTrace).toHaveBeenCalledTimes(1);
  });

  it('loads one more level from the side header, with the node count in its label', async () => {
    const props = await renderPanel();
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-grow')).toBeNull();
    const grow = host.querySelector('[data-testid="trace-tree-row-trace-up"] .ln-tree-grow') as HTMLButtonElement;
    expect(grow.disabled).toBe(false);
    expect(grow.getAttribute('aria-label')).toBe('Load one more upstream level (+1 node)');
    await act(async () => {
      grow.click();
    });
    expect(props.onGrowLevel).toHaveBeenCalledWith(['f']);
  });

  it('disables +1 level when the side has no further level or routes are shown', async () => {
    await renderPanel();
    const down = host.querySelector('[data-testid="trace-tree-row-trace-down"] .ln-tree-grow') as HTMLButtonElement;
    expect(down.disabled).toBe(true);
    expect(down.getAttribute('aria-label')).toBe('No further downstream level');
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await renderPanel({ canGrow: false });
    const up = host.querySelector('[data-testid="trace-tree-row-trace-up"] .ln-tree-grow') as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(up.getAttribute('aria-label')).toBe('Show all to load more levels');
  });

  it('reveals a find match inside a collapsed level', async () => {
    await renderPanel({ tree: deepTree });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).toBeNull();
    const input = await openFind();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'name-deep');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:deep"]')).not.toBeNull();
  });

  it('reveals and selects the canvas selection inside a collapsed level', async () => {
    await renderPanel({ tree: deepTree, selectedNodeId: 'deep' });
    const row = host.querySelector('[data-testid="trace-tree-row-up:deep"]');
    expect(row).not.toBeNull();
    expect(row?.closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true');
    expect(row?.className).toContain('ln-tree-row-active');
  });

  it('leaves role and selection state to the widget row', async () => {
    await renderPanel({ selectedNodeId: 'a' });
    const body = host.querySelector('[data-testid="trace-tree-row-up:a"]');
    expect(body?.getAttribute('role')).toBeNull();
    expect(body?.parentElement?.getAttribute('role')).toBe('treeitem');
  });

  it('states a refused route instead of failing silently', async () => {
    await renderPanel({ onFocusTargets: vi.fn(() => false) });
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-focus-refused"]')).not.toBeNull();
  });

  it('keeps keyboard focus in the list when a trim removes the focused row', async () => {
    const twoLeaves: TraceTree = { ...tree, upstream: [{ side: 'up', depth: 1, nodeIds: ['a', 'b'], grow: new Map() }], totalUpstream: 2 };
    await renderPanel({ tree: twoLeaves });
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-up:a"] .ln-tree-label') as HTMLElement).click();
    });
    expect(document.activeElement?.querySelector('[data-testid="trace-tree-row-up:a"]')).not.toBeNull();
    await renderPanel({ tree: { ...tree, upstream: [{ side: 'up', depth: 1, nodeIds: ['b'], grow: new Map() }] } });
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
  });

  it('lists nodes outside both sides under Connected', async () => {
    await renderPanel({
      tree: { ...tree, connected: { side: 'connected', nodeIds: ['s'], grow: new Map([['s', []]]) } },
    });
    const side = host.querySelector('[data-testid="trace-tree-row-trace-connected"]');
    expect(side?.textContent).toContain('Connected');
    expect(side?.querySelector('.ln-tree-count')?.textContent).toBe('1');
    const box = host.querySelector('[data-testid="trace-tree-row-connected:s"] input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it('hides through the panel close button', async () => {
    const props = await renderPanel();
    await act(async () => {
      (host.querySelector('[aria-label="Hide trace navigator"]') as HTMLElement).click();
    });
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('collapses to a reopen button', async () => {
    const props = await renderPanel({ collapsed: true });
    expect(host.querySelector('[data-testid="trace-tree-panel"]')).toBeNull();
    const rail = host.querySelector('[data-testid="trace-tree-collapsed"] button') as HTMLElement;
    expect(rail?.getAttribute('aria-label')).toBe('Show trace navigator');
    await act(async () => {
      rail.click();
    });
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('hides Reset while routes are shown and keeps Show all', async () => {
    await renderPanel({ focusTargetIds: ['a'], editCounts: { added: 0, trimmed: 1 } });
    const footer = host.querySelector('.ln-trace-tree-footer') as HTMLElement;
    expect(footer.textContent).toContain('Show all');
    expect(footer.textContent).toContain('1 trimmed');
    expect([...footer.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Show all']);
  });

  it('opens a level that appears after mount, and a collapse stays closed when the trace grows again', async () => {
    await renderPanel();
    const grown: TraceTree = {
      ...tree,
      upstream: [
        { side: 'up', depth: 1, nodeIds: ['a'], grow: new Map() },
        { side: 'up', depth: 2, nodeIds: ['b'], grow: new Map() },
      ],
      totalUpstream: 2,
    };
    await renderPanel({ tree: grown });
    expect(host.querySelector('[data-testid="trace-tree-row-up:b"]')).not.toBeNull();
    await act(async () => {
      (host.querySelector('[data-testid="trace-tree-row-trace-up-L1"] .ln-tree-label') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
    await renderPanel({
      tree: {
        ...grown,
        upstream: [
          { side: 'up', depth: 1, nodeIds: ['a', 'a2'], grow: new Map() },
          { side: 'up', depth: 2, nodeIds: ['b'], grow: new Map() },
        ],
        totalUpstream: 3,
      },
    });
    expect(host.querySelector('[data-testid="trace-tree-row-trace-up-L1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-up:a"]')).toBeNull();
    expect(host.querySelector('[data-testid="trace-tree-row-up:a2"]')).toBeNull();
  });

  it('selects the leaf keyboard focus lands on', async () => {
    const props = await renderPanel();
    const treeEl = host.querySelector('[role="tree"]') as HTMLElement;
    await act(async () => { treeEl.focus(); });
    const down = () => act(async () => {
      treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await down();
    await down();
    expect(props.onFocusNode).toHaveBeenCalledWith('a');
  });
});
