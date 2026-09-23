// @vitest-environment jsdom
//
// A7.3: the context menu's Remove item is always rendered — disabled with a stated reason when
// refused, never removed from the menu — and dispatches to the caller matching `removeAction.kind`.
// Schema boxes get one Expand/Collapse item reflecting `isExpanded`.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeContextMenu, SchemaContextMenu } from '../../../src/components/NodeContextMenu';
import type { RemoveAction } from '../../../src/engine/modeCapabilities';

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

function mount(element: ReactElement): void {
  act(() => root.render(<StrictMode>{element}</StrictMode>));
}

function removeButton(): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'));
  const found = buttons.find(b => /Exclude from view|Remove from trace|Remove from view|^Remove$/.test(b.textContent ?? ''));
  if (!found) throw new Error('Remove item not found');
  return found as HTMLButtonElement;
}

const BASE_PROPS = {
  x: 10,
  y: 10,
  nodeId: 'n1',
  nodeName: 'Orders',
  schema: 'sales',
  objectType: 'table' as const,
  isTracing: false,
  onClose: vi.fn(),
  onTrace: vi.fn(),
  onFindPath: vi.fn(),
  onViewDdl: vi.fn(),
  onShowDetails: vi.fn(),
};

describe('NodeContextMenu — Remove item always present, dispatches per RemoveAction', () => {
  it('exclude action: enabled, labeled "Exclude from view", calls onExcludeNode', () => {
    const onExcludeNode = vi.fn();
    mount(<NodeContextMenu {...BASE_PROPS} removeAction={{ kind: 'exclude' }} onExcludeNode={onExcludeNode} />);
    const btn = removeButton();
    expect(btn.textContent).toContain('Exclude from view');
    expect(btn.disabled).toBe(false);
    act(() => btn.click());
    expect(onExcludeNode).toHaveBeenCalledWith('^sales\\.Orders$');
  });

  it('trace-prune action: enabled, labeled "Remove from trace", calls onTracePruneNode', () => {
    const onTracePruneNode = vi.fn();
    mount(<NodeContextMenu {...BASE_PROPS} removeAction={{ kind: 'trace-prune' }} onTracePruneNode={onTracePruneNode} />);
    const btn = removeButton();
    expect(btn.textContent).toContain('Remove from trace');
    act(() => btn.click());
    expect(onTracePruneNode).toHaveBeenCalledWith('n1');
  });

  it('curated-remove action: enabled, labeled "Remove from view", calls onCuratedRemoveNode', () => {
    const onCuratedRemoveNode = vi.fn();
    mount(<NodeContextMenu {...BASE_PROPS} removeAction={{ kind: 'curated-remove' }} onCuratedRemoveNode={onCuratedRemoveNode} />);
    const btn = removeButton();
    expect(btn.textContent).toContain('Remove from view');
    act(() => btn.click());
    expect(onCuratedRemoveNode).toHaveBeenCalledWith('n1');
  });

  it('refuse action: item stays in the menu, disabled, with the reason as its title — never removed', () => {
    const refusal: RemoveAction = { kind: 'refuse', reason: 'Exit analysis to remove nodes from the view' };
    mount(<NodeContextMenu {...BASE_PROPS} removeAction={refusal} />);
    const btn = removeButton();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Exit analysis to remove nodes from the view');
  });

  it('degrades an exclude action to a local refusal for external file/db references', () => {
    mount(<NodeContextMenu {...BASE_PROPS} objectType="external" externalType="file" removeAction={{ kind: 'exclude' }} />);
    const btn = removeButton();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('External references cannot be excluded here');
  });
});

describe('SchemaContextMenu — one Expand/Collapse item, reflecting isExpanded', () => {
  it('collapsed schema: shows "Expand schema" and calls onExpand', () => {
    const onExpand = vi.fn();
    mount(<SchemaContextMenu x={0} y={0} schema="hr" isExpanded={false} onClose={vi.fn()} onExpand={onExpand} onCollapse={vi.fn()} />);
    const btn = Array.from(document.querySelectorAll('button')).find(b => /schema$/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(btn.textContent).toContain('Expand schema');
    act(() => btn.click());
    expect(onExpand).toHaveBeenCalledWith('hr');
  });

  it('expanded schema: shows "Collapse schema" and calls onCollapse', () => {
    const onCollapse = vi.fn();
    mount(<SchemaContextMenu x={0} y={0} schema="hr" isExpanded={true} onClose={vi.fn()} onExpand={vi.fn()} onCollapse={onCollapse} />);
    const btn = Array.from(document.querySelectorAll('button')).find(b => /schema$/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(btn.textContent).toContain('Collapse schema');
    act(() => btn.click());
    expect(onCollapse).toHaveBeenCalledWith('hr');
  });

  it('disabled while mode-locked: item stays visible, disabled, with the reason as its title', () => {
    mount(<SchemaContextMenu x={0} y={0} schema="hr" isExpanded={false} disabledReason="Exit the active mode to change schema expansion" onClose={vi.fn()} onExpand={vi.fn()} onCollapse={vi.fn()} />);
    const btn = Array.from(document.querySelectorAll('button')).find(b => /schema$/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Exit the active mode to change schema expansion');
  });
});
