// @vitest-environment jsdom
//
// Two small CustomNode behaviours: the "+N" count on the add trace control reads
// `TraceSideControls.add.length` directly (no new data), and the low-zoom simple render drops
// label/badge/trace-control decorations down to a plain box with its handles kept for edge
// connectivity. The zoom-gated selector itself (`isZoomBelowSimpleThreshold`) is a pure function,
// pinned at its threshold boundary without a mount.
import { StrictMode, act, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomNode, isZoomBelowSimpleThreshold } from '../../../src/components/CustomNode';
import { SIMPLE_NODE_ZOOM_THRESHOLD } from '../../../src/engine/nodeDecoration';
import type { CustomNodeData, TraceNeighborOption, TraceNodeControls, TraceSideControls } from '../../../src/engine/types';

// React 19 reads this to decide whether `act` may drive updates; without it every act() warns.
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

/** Sets the store's zoom directly — the same seam `useStore` reads in `CustomNode`. */
function SetZoom({ zoom }: { zoom: number }) {
  const store = useStoreApi();
  useEffect(() => {
    store.setState({ transform: [0, 0, zoom] });
  }, [store, zoom]);
  return null;
}

function sideControls(addCount: number): TraceSideControls {
  const add: TraceNeighborOption[] = Array.from({ length: addCount }, (_, i) => ({
    id: `n${i}`,
    label: `N${i}`,
    schema: 'dbo',
    objectType: 'table',
  }));
  return {
    add,
    prune: [],
    addDisabledReason: '',
    pruneDisabledReason: '',
    neighborCount: addCount,
    visibleNeighborCount: 0,
  };
}

function makeTraceControls(inAddCount: number): TraceNodeControls {
  return {
    in: sideControls(inAddCount),
    out: sideControls(0),
    onAdd: () => {},
    onPrune: () => {},
  };
}

function makeNodeData(overrides: Partial<CustomNodeData> = {}): CustomNodeData {
  return {
    label: 'Orders',
    schema: 'dbo',
    fullName: 'dbo.Orders',
    objectType: 'table',
    inDegree: 2,
    outDegree: 1,
    ...overrides,
  };
}

function mountNode(data: CustomNodeData, zoom = 1): void {
  mount(
    <ReactFlowProvider>
      <SetZoom zoom={zoom} />
      <CustomNode id="dbo.Orders" data={data} />
    </ReactFlowProvider>,
  );
}

describe('isZoomBelowSimpleThreshold', () => {
  it('is false at and above the threshold', () => {
    expect(isZoomBelowSimpleThreshold(SIMPLE_NODE_ZOOM_THRESHOLD)).toBe(false);
    expect(isZoomBelowSimpleThreshold(SIMPLE_NODE_ZOOM_THRESHOLD + 0.1)).toBe(false);
  });

  it('is true just below the threshold', () => {
    expect(isZoomBelowSimpleThreshold(SIMPLE_NODE_ZOOM_THRESHOLD - 0.01)).toBe(true);
  });
});

describe('CustomNode — "+N" on the add trace control', () => {
  it('shows the add candidate count next to the enabled add control', () => {
    mountNode(makeNodeData({ traceControls: makeTraceControls(12) }));
    const counts = [...host.querySelectorAll('.ln-trace-node-action-count')].map(el => el.textContent);
    expect(counts).toEqual(['+12']);
  });

  it('shows no count when the add control has nothing to add', () => {
    mountNode(makeNodeData({ traceControls: makeTraceControls(0) }));
    expect(host.querySelectorAll('.ln-trace-node-action-count')).toHaveLength(0);
  });

  it('never shows a count on the prune control', () => {
    mountNode(makeNodeData({ traceControls: makeTraceControls(5) }));
    const pruneButtons = host.querySelectorAll('.ln-trace-node-action--prune');
    for (const btn of pruneButtons) {
      expect(btn.parentElement?.querySelector('.ln-trace-node-action-count')).toBeNull();
    }
  });
});

describe('CustomNode — plain box below the zoom threshold', () => {
  it('renders the label at a normal zoom', () => {
    mountNode(makeNodeData(), 1);
    expect(host.textContent).toContain('Orders');
  });

  it('keeps the label at mid zoom-outs a user can still read', () => {
    mountNode(makeNodeData(), 0.3);
    expect(host.textContent).toContain('Orders');
  });

  it('renders no label text, badge or trace-control decoration below the threshold, keeping both handles', () => {
    mountNode(
      makeNodeData({
        aiBadge: { text: '1 note' },
        traceControls: makeTraceControls(3),
      }),
      SIMPLE_NODE_ZOOM_THRESHOLD - 0.1,
    );

    expect(host.textContent).not.toContain('Orders');
    expect(host.querySelectorAll('.ln-trace-node-action')).toHaveLength(0);
    expect(host.querySelectorAll('.ln-trace-node-action-count')).toHaveLength(0);
    expect(host.querySelector('[class*="ai-badge"]')).toBeNull();
    expect(host.querySelectorAll('.ln-handle')).toHaveLength(2);
  });
});
