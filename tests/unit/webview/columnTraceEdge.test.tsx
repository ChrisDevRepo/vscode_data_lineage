// @vitest-environment jsdom
//
// Cover for the column-view edge marker: `ColumnTraceEdge` draws the transform-chip that flags
// where a value changes between two traced columns, and `ColumnTransformGlyph` is the ring drawn
// inside both that chip and the legend key.
//
// Everything here mounts for real, including `ColumnTraceEdge` itself. The one obstacle is
// `EdgeLabelRenderer`, which portals into a node the real `<ReactFlow>` wrapper creates from a
// live DOM ref (`store.domNode`) after its own resize/measurement pass runs. Pulling in that full
// layout engine to get one ref populated needs `ResizeObserver` and `DOMMatrixReadOnly` polyfills
// jsdom does not ship — pure scaffolding, unrelated to anything this component decides. Rather
// than fake the chip's own output, `FakeDomNode` below supplies just that one piece of store state
// — a detached div holding the same `.react-flow__edgelabel-renderer` marker class the real
// wrapper uses — the same seam a production `<ReactFlow>` writes to, just written directly instead
// of grown from a measured layout. `ColumnTraceEdge`, `EdgeLabelRenderer`, `BaseEdge` and the
// `Tooltip` it wraps all run unmodified after that, so what renders is the genuine component tree.
import { StrictMode, act, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Position, ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ColumnTraceEdge, ColumnTransformGlyph, type ColumnTraceEdgeData } from '../../../src/components/ColumnTraceEdge';
import { Legend } from '../../../src/components/Legend';

// React 19 reads this to decide whether `act` may drive updates; without it every act() warns.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
/** Detached portal target `FakeDomNode` registers on the store, torn down alongside `host`. */
let portalHost: HTMLDivElement | null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  portalHost = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  portalHost?.remove();
  portalHost = null;
});

function mount(element: ReactElement): void {
  act(() => root.render(<StrictMode>{element}</StrictMode>));
}

/**
 * Registers a detached `.react-flow__edgelabel-renderer` host as `store.domNode`, the one field
 * `EdgeLabelRenderer` reads before it will portal its children anywhere. See file header for why
 * this stands in for the full `<ReactFlow>` wrapper rather than growing it in this harness.
 */
function FakeDomNode() {
  const store = useStoreApi();
  useEffect(() => {
    const wrapper = document.createElement('div');
    const renderer = document.createElement('div');
    renderer.className = 'react-flow__edgelabel-renderer';
    wrapper.appendChild(renderer);
    document.body.appendChild(wrapper);
    portalHost = wrapper;
    store.setState({ domNode: wrapper });
  }, [store]);
  return null;
}

/** Two endpoints 200px apart on the same horizontal line — the path shape itself is not under test. */
const ENDPOINTS = {
  sourceX: 0,
  sourceY: 0,
  targetX: 200,
  targetY: 0,
  sourcePosition: Position.Bottom,
  targetPosition: Position.Top,
} as const;

function mountEdge(data: ColumnTraceEdgeData): void {
  mount(
    <ReactFlowProvider>
      <FakeDomNode />
      <svg>
        <ColumnTraceEdge id="e1" source="a" target="b" data={data} {...ENDPOINTS} />
      </svg>
    </ReactFlowProvider>,
  );
}

function edgeChip(): HTMLElement | null {
  return portalHost?.querySelector<HTMLElement>('.ln-column-edge-chip') ?? null;
}

function makeData(state: ColumnTraceEdgeData['state']): ColumnTraceEdgeData {
  return { state, lit: true, sourceColumn: 'OrderId', targetColumn: 'OrderId' };
}

describe('ColumnTraceEdge', () => {
  it('draws the marker chip when the endpoints recorded a transformation', () => {
    mountEdge(makeData('transformation'));
    expect(edgeChip(), 'the only state with something to assert gets the chip').not.toBeNull();
  });

  // `ColumnLineState` is `'passthrough' | 'transformation' | 'unknown'` (src/engine/columnTraceView.ts).
  // An unmarked line already reads as "unchanged", so `passthrough` earns no chip; `unknown` has
  // nothing to assert either. Both are exercised by name, not inferred from the one positive case.
  it('draws no chip for a passthrough edge', () => {
    mountEdge(makeData('passthrough'));
    expect(edgeChip(), 'an unremarkable line stays unmarked').toBeNull();
  });

  it('draws no chip for an edge whose state could not be determined', () => {
    mountEdge(makeData('unknown'));
    expect(edgeChip(), 'nothing to assert is not the same as a transformation').toBeNull();
  });

  it('renders the same glyph markup the legend key promises', () => {
    // The legend imports `ColumnTransformGlyph` expressly so its key cannot describe a symbol the
    // canvas no longer draws (see the export's own remarks in ColumnTraceEdge.tsx). Rendering both
    // through their real call sites — the edge chip and the legend row — and diffing the resulting
    // SVG is what would catch one of them drifting to a second, hand-copied glyph.
    mountEdge(makeData('transformation'));
    const canvasGlyph = edgeChip()!.querySelector('svg')!.outerHTML;

    mount(<Legend schemas={[]} showColumnFlowKey />);
    const legendGlyph = host.querySelector('.ln-column-edge-chip svg')!.outerHTML;

    expect(legendGlyph).toBe(canvasGlyph);

    // Both call sites resolve to the exported component itself, not merely to visually similar
    // markup — pin that against a bare, unwrapped render too.
    mount(<ColumnTransformGlyph />);
    expect(host.querySelector('svg')!.outerHTML).toBe(canvasGlyph);
  });

  it('draws the glyph as an open ring, never the arrow pair it replaced', () => {
    // Two opposed arrows used to mark a transform; on a canvas where edge direction is already the
    // primary signal they read as bidirectional, which is backwards. A ring carries no direction,
    // so this pins the shape that fixed the misreading rather than just the fact that something
    // still renders.
    mount(<ColumnTransformGlyph />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('fill'), 'unfilled — a filled dot is the object-type legend mark').toBe('none');
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
    expect(svg.querySelectorAll('path'), 'no leftover arrowhead geometry').toHaveLength(0);
  });
});
