// @vitest-environment jsdom
//
// Behavioural cover for the two column-view components the release is built on. Both are leaves —
// `ColumnTraceNode` takes `{ id, data }` and `ColumnViewToggle` takes two props — so they mount for
// real here, unlike `GraphCanvas` (107 props behind two providers), whose contract is asserted from
// source in `graph-canvas-object-positions.test.ts`.
//
// The keyboard case is the reason this file exists: every row used to be `tabIndex={0}`, so a
// forty-column table put forty stops in the page order and a trace holds many such nodes. The node
// is now one stop with the arrow keys moving inside it, and that is only observable by mounting.
import { StrictMode, act, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ColumnTraceNode } from '../../../src/components/ColumnTraceNode';
import { ColumnViewToggle } from '../../../src/components/ColumnViewToggle';
import { ColumnHoverProvider } from '../../../src/contexts/ColumnHoverContext';
import { COLUMN_ROW_DIM_OPACITY, columnRowKey } from '../../../src/engine/columnTraceView';
import type { ColumnTraceNodeData } from '../../../src/engine/types';

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

function makeData(columns: string[]): ColumnTraceNodeData {
  return {
    view: {
      id: 'dbo.orders',
      label: 'Orders',
      schema: 'dbo',
      objectType: 'table',
      isTransformNode: false,
      rows: columns.map(name => ({ name })),
      width: 214,
      height: 28 + columns.length * 22,
      x: 0,
      y: 0,
    },
  } as unknown as ColumnTraceNodeData;
}

function makeTransformData(portCount: number): ColumnTraceNodeData {
  return {
    view: {
      id: 'ai.spbuildsalesreport',
      label: 'spBuildSalesReport',
      schema: 'ai',
      objectType: 'procedure',
      isTransformNode: true,
      rows: Array.from({ length: portCount }, (_, i) => ({ name: `@p${i}` })),
      width: 150,
      height: 96,
      x: 0,
      y: 0,
    },
  } as unknown as ColumnTraceNodeData;
}

/**
 * Stands in for `GraphCanvas` as the hover owner: it holds the thread the rows read and lights
 * exactly the row that reported the hover. The canvas widens that to the connected column path;
 * the node's own contract is only "dim what is not in the thread", which this exercises.
 */
function HoverHarness({ children, seed }: { children: ReactNode; seed?: ReadonlySet<string> }) {
  const [hoveredPath, setHoveredPath] = useState<ReadonlySet<string> | null>(seed ?? null);
  const [pinnedRow, setPinnedRow] = useState<string | null>(null);
  return (
    <ColumnHoverProvider
      value={{
        hoveredPath,
        onColumnHover: (nodeId, column) => {
          if (pinnedRow !== null) return;
          setHoveredPath(column === null ? null : new Set([columnRowKey(nodeId, column)]));
        },
        onColumnSelect: (nodeId, column) => {
          setPinnedRow(columnRowKey(nodeId, column));
          setHoveredPath(new Set([columnRowKey(nodeId, column)]));
        },
        pinnedRow,
      }}
    >
      {children}
    </ColumnHoverProvider>
  );
}

function mountNode(columns: string[]): void {
  mount(
    <ReactFlowProvider>
      <HoverHarness>
        <ColumnTraceNode id="dbo.orders" data={makeData(columns)} />
      </HoverHarness>
    </ReactFlowProvider>,
  );
}

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="listitem"]')];
}

function pressArrow(row: HTMLElement, key: string): void {
  act(() => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('ColumnTraceNode', () => {
  it('renders one row per traced column, each naming its object as well as its column', () => {
    mountNode(['OrderId', 'CustomerId', 'Total']);
    const rendered = rows();
    expect(rendered).toHaveLength(3);
    expect(rendered.map(r => r.textContent)).toEqual(['OrderId', 'CustomerId', 'Total']);
    // A bare column name is ambiguous across a multi-node trace, so the object rides the label.
    expect(rendered[0].getAttribute('aria-label')).toBe('dbo.Orders column OrderId');
  });

  it('shows the declared backend data type beside the column name, and no shape annotation', () => {
    // The type comes from the extracted model, never from the AI; the structural shape annotation
    // it replaced ("incoming (2)") is gone from the row entirely.
    mount(
      <ReactFlowProvider>
        <HoverHarness>
          <ColumnTraceNode id="dbo.orders" data={{
            ...makeData(['OrderId', 'Total']),
            view: {
              ...makeData(['OrderId', 'Total']).view,
              rows: [
                { name: 'OrderId', dataType: 'int' },
                { name: 'Total', shape: 'incoming', contributors: 2, dataType: 'money' },
              ],
            },
          }} />
        </HoverHarness>
      </ReactFlowProvider>,
    );
    const rendered = rows();
    expect(rendered[0].textContent).toBe('OrderIdint');
    expect(rendered[1].textContent, 'the shape annotation does not survive next to the type').toBe('Totalmoney');
    expect(rendered[1].getAttribute('aria-label')).toBe('dbo.Orders column Total, money');
  });

  it('renders a procedure as a circle-and-gear super node instead of a port card', () => {
    mount(
      <ReactFlowProvider>
        <HoverHarness>
          <ColumnTraceNode id="ai.spbuildsalesreport" data={makeTransformData(2)} />
        </HoverHarness>
      </ReactFlowProvider>,
    );
    // No port rows in the page: the hub's identity is the circle, not a borrowed column list.
    expect(rows(), 'no row is focusable on the super node').toHaveLength(0);
    expect(host.querySelector('circle'), 'the gear body is a stroked circle').not.toBeNull();
    expect(host.textContent).toContain('ai.spBuildSalesReport');
  });

  it('keeps one invisible port handle pair per traced column on the super node', () => {
    // The handles are the edges' attachment points; removing the port card must not remove them,
    // or every line through the hub would have nowhere to land.
    mount(
      <ReactFlowProvider>
        <HoverHarness>
          <ColumnTraceNode id="ai.spbuildsalesreport" data={makeTransformData(3)} />
        </HoverHarness>
      </ReactFlowProvider>,
    );
    expect(document.querySelectorAll('.react-flow__handle')).toHaveLength(6);
  });

  it('is a single tab stop however many columns it traces', () => {
    mountNode(['A', 'B', 'C', 'D', 'E']);
    const focusable = rows().filter(r => r.getAttribute('tabindex') === '0');
    expect(focusable, 'exactly one row is in the page tab order').toHaveLength(1);
    expect(focusable[0].getAttribute('aria-label')).toContain('column A');
    expect(rows().slice(1).every(r => r.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('moves the tab stop and the focus with the arrow keys, and clamps at both ends', () => {
    mountNode(['A', 'B', 'C']);
    pressArrow(rows()[0], 'ArrowDown');
    expect(rows()[1].getAttribute('tabindex'), 'the stop follows the arrow').toBe('0');
    expect(rows()[0].getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(rows()[1]);

    pressArrow(rows()[1], 'ArrowUp');
    expect(document.activeElement).toBe(rows()[0]);
    pressArrow(rows()[0], 'ArrowUp');
    expect(document.activeElement, 'ArrowUp at the first row stays put').toBe(rows()[0]);

    pressArrow(rows()[0], 'End');
    expect(document.activeElement).toBe(rows()[2]);
    pressArrow(rows()[2], 'ArrowDown');
    expect(document.activeElement, 'ArrowDown at the last row stays put').toBe(rows()[2]);
    pressArrow(rows()[2], 'Home');
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('claims the arrow keys so React Flow does not pan the canvas out from under the user', () => {
    mountNode(['A', 'B']);
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    act(() => { rows()[0].dispatchEvent(event); });
    expect(event.defaultPrevented, 'the row consumes the key').toBe(true);
  });

  it('leaves keys it does not own to the rest of the page', () => {
    mountNode(['A', 'B']);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { rows()[0].dispatchEvent(event); });
    expect(event.defaultPrevented, 'Tab still leaves the node').toBe(false);
  });

  it('dims the rows off the hovered path and leaves the hovered one at full strength', () => {
    mountNode(['A', 'B', 'C']);
    expect(rows().every(r => r.style.opacity === '1'), 'nothing is dimmed before a hover').toBe(true);

    act(() => { rows()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(rows()[1].style.opacity, 'the hovered row stays lit').toBe('1');
    expect(rows()[0].style.opacity).toBe(String(COLUMN_ROW_DIM_OPACITY));
    expect(rows()[2].style.opacity).toBe(String(COLUMN_ROW_DIM_OPACITY));
  });

  it('pins the thread on a click and keeps it lit after the pointer leaves', () => {
    mountNode(['A', 'B', 'C']);
    act(() => { rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(rows()[1].style.opacity, 'the clicked row is the thread').toBe('1');
    expect(rows()[0].style.opacity).toBe(String(COLUMN_ROW_DIM_OPACITY));

    // The gesture the hover-only thread could not serve: reading the answer with the pointer gone.
    act(() => { rows()[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    act(() => { rows()[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(rows()[1].style.opacity, 'the pinned thread survives a later hover').toBe('1');
    expect(rows()[2].style.opacity).toBe(String(COLUMN_ROW_DIM_OPACITY));
  });

  it('claims the row click so React Flow does not select the object instead of the column', () => {
    // React Flow reads a node click from a handler on the node wrapper above this component, so the
    // ancestor here is a React onClick — the same dispatch path, not a native listener on the host.
    let reachedWrapper = false;
    mount(
      <ReactFlowProvider>
        <HoverHarness>
          <div onClick={() => { reachedWrapper = true; }}>
            <ColumnTraceNode id="dbo.orders" data={makeData(['A', 'B'])} />
          </div>
        </HoverHarness>
      </ReactFlowProvider>,
    );
    act(() => { rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(reachedWrapper, 'the click stops at the row').toBe(false);
  });

  it('dims the whole card when no row of it is on the active thread', () => {
    // An object off the thread is context, not answer — it takes the object view's dim rather than
    // standing at full weight with only its rows faded.
    mount(
      <ReactFlowProvider>
        <HoverHarness seed={new Set([columnRowKey('dbo.other', 'X')])}>
          <ColumnTraceNode id="dbo.orders" data={makeData(['A', 'B'])} />
        </HoverHarness>
      </ReactFlowProvider>,
    );
    const card = host.querySelector<HTMLElement>('.ln-node-card')!;
    expect(card.style.opacity, 'a card with no row on the thread is dimmed').toBe('0.25');
  });

  it('leaves a card carrying the thread at full strength', () => {
    mount(
      <ReactFlowProvider>
        <HoverHarness seed={new Set([columnRowKey('dbo.orders', 'B')])}>
          <ColumnTraceNode id="dbo.orders" data={makeData(['A', 'B'])} />
        </HoverHarness>
      </ReactFlowProvider>,
    );
    const card = host.querySelector<HTMLElement>('.ln-node-card')!;
    expect(card.style.opacity, 'one row on the thread keeps the card lit').toBe('1');
  });

  it('summarises instead of listing rows when rows are hidden', () => {
    mount(
      <ReactFlowProvider>
        <HoverHarness>
          <ColumnTraceNode id="dbo.orders" data={{ ...makeData(['A', 'B']), rowsVisible: false }} />
        </HoverHarness>
      </ReactFlowProvider>,
    );
    expect(rows(), 'no row is focusable while they are collapsed').toHaveLength(0);
    expect(host.textContent).toContain('2 traced columns');
  });
});

describe('ColumnViewToggle', () => {
  it('reports which view is on stage through aria-pressed', () => {
    mount(<ColumnViewToggle active={false} onToggle={() => {}} />);
    const [objects, detail] = [...host.querySelectorAll('button')];
    expect(objects.getAttribute('aria-pressed')).toBe('true');
    expect(detail.getAttribute('aria-pressed')).toBe('false');

    mount(<ColumnViewToggle active onToggle={() => {}} />);
    const [objects2, detail2] = [...host.querySelectorAll('button')];
    expect(objects2.getAttribute('aria-pressed')).toBe('false');
    expect(detail2.getAttribute('aria-pressed')).toBe('true');
  });

  it('asks for the view its button names, not for the opposite of the current one', () => {
    const asked: boolean[] = [];
    mount(<ColumnViewToggle active onToggle={v => asked.push(v)} />);
    const [objects, detail] = [...host.querySelectorAll('button')];
    // Both are pressed while Detail is already active: a toggle that inverted current state would
    // send `false` twice and make the Detail button a no-op on the view it is meant to select.
    act(() => { detail.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { objects.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(asked).toEqual([true, false]);
  });
});
