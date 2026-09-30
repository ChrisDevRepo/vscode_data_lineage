// @vitest-environment jsdom
//
// Package 5, "count before the click": InlineTraceControls shows the object count the current
// upstream/downstream choice would produce, via a caller-supplied BFS-only probe — never disabling
// the choice when it is over the render limit, since the render-limit notice (A2) handles that once
// applied.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineTraceControls } from '../../../src/components/InlineTraceControls';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';

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

const BASE_PROPS = {
  startNodeId: 'n1',
  startNodeName: 'Orders',
  onApply: vi.fn(),
  onClose: vi.fn(),
};

describe('InlineTraceControls — count before the click', () => {
  it('renders no count label when no estimator is supplied', () => {
    mount(<InlineTraceControls {...BASE_PROPS} />);
    expect(host.textContent).not.toContain('objects');
  });

  it('probes with the default depths on first render and shows the count', () => {
    const estimateCount = vi.fn(() => 1420);
    mount(<InlineTraceControls {...BASE_PROPS} defaultUpstream={3} defaultDownstream={3} estimateCount={estimateCount} renderLimit={2000} />);
    expect(estimateCount).toHaveBeenCalledWith(3, 3);
    expect(host.textContent).toContain('1,420 objects');
    expect(host.textContent).not.toContain('over limit');
  });

  it('flags the count as over limit without disabling Apply', () => {
    const estimateCount = vi.fn(() => 5000);
    mount(<InlineTraceControls {...BASE_PROPS} estimateCount={estimateCount} renderLimit={2000} />);
    expect(host.textContent).toContain('5,000 objects — over limit');
    const apply = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Apply') as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
  });

  it('re-probes with the sentinel when a depth is toggled to All', () => {
    const estimateCount = vi.fn(() => 10);
    mount(<InlineTraceControls {...BASE_PROPS} defaultUpstream={3} defaultDownstream={3} estimateCount={estimateCount} />);
    const allButtons = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'All');
    act(() => allButtons[0].click());
    expect(estimateCount).toHaveBeenLastCalledWith(TRACE_ALL_LEVELS, 3);
  });
});
