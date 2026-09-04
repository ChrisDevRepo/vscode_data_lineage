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

/**
 * Stands in for `GraphCanvas` as the hover owner: it holds the thread the rows read and lights
 * exactly the row that reported the hover. The canvas widens that to the connected column path;
 * the node's own contract is only "dim what is not in the thread", which this exercises.
 */
function HoverHarness({ children }: { children: ReactNode }) {
  const [hoveredPath, setHoveredPath] = useState<ReadonlySet<string> | null>(null);
  return (
    <ColumnHoverProvider
      value={{
        hoveredPath,
        onColumnHover: (nodeId, column) =>
          setHoveredPath(column === null ? null : new Set([columnRowKey(nodeId, column)])),
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
