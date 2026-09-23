// @vitest-environment jsdom
//
// Reduced motion has one owner: the stylesheet.
//
// `ColumnTraceNode` never probes `matchMedia('(prefers-reduced-motion: reduce)')`: a media query
// read per node per frame would answer a question the stylesheet already answers, and could answer
// it differently from the stylesheet whenever the OS preference and the editor setting differ.
//
// Both halves of that are checked here against behaviour rather than source text. The component is
// mounted with the preference mocked ON: it must never consult it, and the inline motion it does
// write must stay overridable, so the stylesheet's `!important` rules still win. jsdom resolves no
// `@media` block against a mounted tree, so the rules themselves are checked by parsing the
// stylesheet into real CSSOM rules — a parse, not a substring search.
import { StrictMode, act, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ColumnTraceNode } from '../../../src/components/ColumnTraceNode';
import { ColumnHoverProvider } from '../../../src/contexts/ColumnHoverContext';
import type { ColumnTraceNodeData } from '../../../src/engine/types';

// React 19 reads this to decide whether `act` may drive updates; without it every act() warns.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** The reduced-motion media query the component must never read; `matches: true` is the reduced-motion user. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

let host: HTMLDivElement;
let root: Root;
let matchMedia: ReturnType<typeof vi.fn>;

/** Installs a `matchMedia` that answers "reduce" to everything and records every query asked. */
function installReducedMotionMatchMedia(): void {
  matchMedia = vi.fn((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('matchMedia', matchMedia);
}

beforeEach(() => {
  installReducedMotionMatchMedia();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
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

function mountNode(columns: string[]): void {
  mount(
    <ReactFlowProvider>
      <ColumnHoverProvider
        value={{ hoveredPath: null, onColumnHover: () => {}, onColumnSelect: () => {}, pinnedRow: null }}
      >
        <ColumnTraceNode id="dbo.orders" data={makeData(columns)} />
      </ColumnHoverProvider>
    </ReactFlowProvider>,
  );
}

/** Parses `src/index.css` into CSSOM rules inside the jsdom document. */
function stylesheetRules(): CSSRule[] {
  const style = document.createElement('style');
  // `@import 'tailwindcss'` is dropped before parsing: jsdom cannot resolve it from `about:blank`
  // and the rules under test are this stylesheet's own, not Tailwind's.
  style.textContent = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')
    .replace(/^@import[^;]*;$/m, '');
  document.head.appendChild(style);
  try {
    return [...style.sheet!.cssRules];
  } finally {
    style.remove();
  }
}

describe('reduced motion is owned by the stylesheet', () => {
  it('renders a column-trace node without ever asking for the preference', () => {
    mountNode(['OrderId', 'CustomerId', 'Total']);

    expect(host.querySelectorAll('[role="listitem"]'), 'the node really rendered').toHaveLength(3);
    const asked = matchMedia.mock.calls.map(call => String(call[0]));
    expect(asked, 'nothing under the node reads the motion preference').not.toContain(REDUCED_MOTION_QUERY);
    expect(matchMedia, 'the node reads no media query at all').not.toHaveBeenCalled();
  });

  it('leaves every inline motion declaration overridable, so the reduced-motion rules outrank it', () => {
    // The rows do carry an inline row transition, and that is fine precisely because it is written
    // without `!important`: the stylesheet's `transition: none !important` beats an inline
    // declaration, and only an inline `!important` would put the component back in charge of a
    // decision the preference owns.
    mountNode(['OrderId', 'Total']);
    const motionProperties = ['transition', 'transition-duration', 'animation', 'animation-duration'];
    const declared = [...host.querySelectorAll<HTMLElement>('*')].flatMap(el =>
      motionProperties
        .filter(property => el.style.getPropertyValue(property) !== '')
        .map(property => `${property}=${el.style.getPropertyPriority(property)}`),
    );
    expect(declared.length, 'the row transition is still applied inline').toBeGreaterThan(0);
    expect(
      declared.filter(entry => entry.endsWith('=important')),
      'no inline motion declaration can outrank the reduced-motion rules',
    ).toEqual([]);
  });

  it('drops transitions under the OS preference, for every element and both pseudo-elements', () => {
    const media = stylesheetRules().filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule);
    const reduced = media.find(rule => rule.media.mediaText.includes('prefers-reduced-motion'));
    expect(reduced, 'the stylesheet declares a reduced-motion block').toBeDefined();
    expect(reduced!.media.mediaText).toBe(REDUCED_MOTION_QUERY);

    const inner = [...reduced!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    expect(inner.length, 'one rule carries the whole block').toBe(1);
    const selectors = inner[0].selectorText.split(',').map(part => part.trim());
    expect(selectors).toEqual(['*', '*::before', '*::after']);
    expect(inner[0].style.getPropertyValue('transition')).toBe('none');
    expect(inner[0].style.getPropertyPriority('transition'), 'it must beat the animated rules').toBe('important');
  });

  it('drops them the same way under the editor setting, which VS Code does not mirror to the OS query', () => {
    const classRule = stylesheetRules()
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .find(rule => rule.selectorText.includes('vscode-reduce-motion'));
    expect(classRule, 'the stylesheet honours `workbench.reduceMotion` too').toBeDefined();
    const selectors = classRule!.selectorText.split(',').map(part => part.trim());
    expect(selectors).toEqual([
      'body.vscode-reduce-motion *',
      'body.vscode-reduce-motion *::before',
      'body.vscode-reduce-motion *::after',
    ]);
    expect(classRule!.style.getPropertyValue('transition')).toBe('none');
    expect(classRule!.style.getPropertyPriority('transition')).toBe('important');
  });
});
