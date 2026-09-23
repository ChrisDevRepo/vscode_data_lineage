// @vitest-environment jsdom
//
// Cover for the column-view edge marker: `ColumnTraceEdge` draws the marker chip that flags where
// a value changes between two traced columns. A model-classified edge shows one glyph per transform
// class; an unclassified transformation keeps the neutral ring; a `pass_through`-only edge draws no
// chip at all, because identity is what an unmarked line already says.
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
import {
  ColumnTraceEdge,
  ColumnTransformGlyph,
  describeColumnEdge,
  type ColumnTraceEdgeData,
} from '../../../src/components/ColumnTraceEdge';

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

function edgePath(): SVGPathElement | null {
  return host.querySelector<SVGPathElement>('path.react-flow__edge-path');
}

function edgeChip(): HTMLElement | null {
  return portalHost?.querySelector<HTMLElement>('.ln-column-edge-chip') ?? null;
}

function chipClasses(): string[] {
  return [...(edgeChip()?.querySelectorAll<HTMLElement>('[data-transform-class]') ?? [])]
    .map(el => el.getAttribute('data-transform-class')!);
}

function makeData(overrides: Partial<ColumnTraceEdgeData> = {}): ColumnTraceEdgeData {
  return { state: 'transformation', lit: true, sourceColumn: 'OrderId', targetColumn: 'OrderId', ...overrides };
}

describe('ColumnTraceEdge', () => {
  it('draws the marker chip when the endpoints recorded a transformation', () => {
    mountEdge(makeData());
    expect(edgeChip(), 'the only state with something to assert gets the chip').not.toBeNull();
  });

  it('draws the class glyph the model recorded for the edge', () => {
    mountEdge(makeData({ transforms: ['combine'] }));
    expect(chipClasses(), 'the chip shows one glyph per recorded class').toEqual(['combine']);
  });

  it('collapses a third class into a count so the chip cannot grow without bound', () => {
    // A filtering join is combine + filter; a fourth class has no room. Two glyphs plus a count is
    // the whole vocabulary the chip spends on classification.
    mountEdge(makeData({ transforms: ['combine', 'filter', 'compute'] }));
    expect(chipClasses()).toEqual(['combine', 'filter']);
    expect(edgeChip()!.textContent, 'the remainder is a count, not a dropped fact').toContain('+1');
  });

  // `ColumnLineState` is `'passthrough' | 'transformation' | 'unknown'` (src/engine/columnTraceView.ts).
  // An unmarked line already reads as "unchanged", so none of these three inputs earns a chip.
  it.each<[string, Partial<ColumnTraceEdgeData>]>([
    ['a passthrough edge', { state: 'passthrough' }],
    ['an edge whose state could not be determined', { state: 'unknown' }],
    ['a pass_through-only edge — identity is what an unmarked line already says', { transforms: ['pass_through'] }],
  ])('draws no chip for %s', (_label, overrides) => {
    mountEdge(makeData(overrides));
    expect(edgeChip(), 'nothing to assert is not the same as a transformation').toBeNull();
  });

  it('keeps the chip beside pass_through when a real class rides with it', () => {
    mountEdge(makeData({ transforms: ['pass_through', 'filter'] }));
    expect(chipClasses(), 'the identity glyph is dropped, the class that acts is kept').toEqual(['filter']);
  });

  it('breaks the line for a relation that only shaped which rows arrive', () => {
    // OpenLineage's DIRECT/INDIRECT split, said in the line: a column used in a WHERE reaches the
    // output without its value ever landing in it, and lineage viewers draw that edge broken.
    mountEdge(makeData({ transforms: ['filter'] }));
    expect(edgePath()!.style.strokeDasharray, 'filter-only is indirect').not.toBe('');
  });

  it('keeps the line solid when the value itself travels', () => {
    mountEdge(makeData({ transforms: ['filter', 'compute'] }));
    expect(edgePath()!.style.strokeDasharray, 'one direct class makes the whole edge direct').toBe('');
  });

  it('marks a computed value with fx, the formula notation of the tools this reader already uses', () => {
    mountEdge(makeData({ transforms: ['compute'] }));
    const glyph = edgeChip()!.querySelector('[data-transform-class="compute"]')!;
    expect(glyph.textContent, 'the letters are the convention, not a hand-drawn curve').toBe('fx');
  });

  it('marks a join with the two overlapping circles every merge dialog draws', () => {
    mountEdge(makeData({ transforms: ['combine'] }));
    const glyph = edgeChip()!.querySelector('[data-transform-class="combine"]')!;
    expect(glyph.querySelectorAll('circle'), 'two circles — one is the unclassified ring').toHaveLength(2);
  });

  it('draws the unclassified mark as an open ring, never an arrow pair', () => {
    // Edge direction is the canvas's primary signal, so a transform mark carries no direction of
    // its own: opposed arrows would read as bidirectional. This pins the ring shape rather than
    // just the fact that something renders.
    mount(<ColumnTransformGlyph />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('fill'), 'unfilled — a filled dot is the object-type legend mark').toBe('none');
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
    expect(svg.querySelectorAll('path'), 'no leftover arrowhead geometry').toHaveLength(0);
  });

  // The tooltip is the only surface that names the class, so the enum text leads and the model's
  // own clause, or a structural fallback when it offered none, follows.
  it.each<[string, Pick<ColumnTraceEdgeData, 'sourceColumn' | 'targetColumn' | 'transforms' | 'note'>, string]>([
    ['names the class first, then the model note, when one was given',
      { sourceColumn: 'A', targetColumn: 'B', transforms: ['combine'], note: 'JOIN on ProductId' },
      'Combine:\nJOIN on ProductId'],
    ['stacks every recorded class into the tooltip name',
      { sourceColumn: 'A', targetColumn: 'B', transforms: ['combine', 'filter'] },
      'Combine + Filter:\nA → B — shapes which rows reach here.'],
    ['falls back to the structural description when the model offered no note',
      { sourceColumn: 'OrderTotal', targetColumn: 'NetAmount', transforms: ['compute'] },
      'Compute:\nOrderTotal → NetAmount — the value changes here.'],
    ['describes an unclassified transformation without inventing a class',
      { sourceColumn: 'OrderTotal', targetColumn: 'NetAmount' },
      'OrderTotal → NetAmount — the value changes here.'],
  ])('%s', (_label, data, expected) => {
    expect(describeColumnEdge(data)).toBe(expected);
  });
});
