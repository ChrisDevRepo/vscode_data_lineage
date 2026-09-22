// @vitest-environment jsdom
//
// Behavioural cover for the collapsed AI report rail: it must sit on the edge the panel was docked
// to, not always on the right. The placement itself is CSS, keyed off a dock modifier class, so the
// contract this file pins is the pair the stylesheet reads — the modifier class on the railwrap and
// the expand glyph that points the way the panel reopens. A left- or bottom-docked report that
// collapsed its rail to the right edge is only observable by mounting collapsed.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiDescriptionOverlay } from '../../../src/components/AiDescriptionOverlay';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

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

/** Inert host API: the overlay posts through the typed context, never through `window.vscode`. */
const api: VsCodeAPI = { postMessage: () => {}, getState: () => undefined, setState: () => {} };

function mount(element: ReactElement): void {
  act(() => root.render(<StrictMode><VsCodeProvider api={api}>{element}</VsCodeProvider></StrictMode>));
}

const PROPS = {
  viewName: 'Orders view',
  description: 'Body text',
  expanded: false,
};

function railwrap(): HTMLElement {
  const el = host.querySelector<HTMLElement>('.ln-ai-description-railwrap');
  expect(el, 'the collapsed report renders a rail').not.toBeNull();
  return el!;
}

function railToggle(): HTMLElement {
  return host.querySelector<HTMLElement>('.ln-ai-description-rail-toggle')!;
}

describe('collapsed AI report rail', () => {
  it.each([
    ['explicit right dock', 'right' as const],
    ['no dock position named (defaults to right)', undefined],
  ])('carries no dock modifier — %s, so the base right-edge rule applies', (_label, dockPosition) => {
    mount(<AiDescriptionOverlay {...PROPS} dockPosition={dockPosition} />);
    expect(railwrap().className).toBe('ln-ai-description-railwrap');
    expect(railToggle().textContent, 'a right rail reopens leftwards').toBe('◀');
  });

  it('moves to the left edge, mirroring the glyph, when the report was docked left', () => {
    mount(<AiDescriptionOverlay {...PROPS} dockPosition="left" />);
    const classes = railwrap().className.split(' ');
    expect(classes).toContain('ln-ai-description-railwrap');
    expect(classes).toContain('ln-ai-description-railwrap--left');
    expect(classes).not.toContain('ln-ai-description-railwrap--bottom');
    expect(railToggle().textContent, 'a left rail reopens rightwards').toBe('▶');
  });

  it('moves to the bottom edge and points its glyph up when the report was docked bottom', () => {
    mount(<AiDescriptionOverlay {...PROPS} dockPosition="bottom" />);
    const classes = railwrap().className.split(' ');
    expect(classes).toContain('ln-ai-description-railwrap--bottom');
    expect(classes).not.toContain('ln-ai-description-railwrap--left');
    expect(railToggle().textContent, 'a bottom strip reopens upwards').toBe('▲');
  });

  it('keeps the rail one expand control whatever edge it is on', () => {
    for (const dock of ['right', 'left', 'bottom'] as const) {
      mount(<AiDescriptionOverlay {...PROPS} dockPosition={dock} />);
      const buttons = host.querySelectorAll('button[aria-label="Expand AI report"]');
      expect(buttons, `one expand button on the ${dock} dock`).toHaveLength(1);
      expect(host.querySelector('.ln-ai-description-rail-name')?.textContent).toBe('Orders view');
    }
  });
});

describe('AI report rail dock styling', () => {
  // The modifier class proves nothing without a rule that reads it, and jsdom resolves no
  // stylesheet against the mounted tree — so the pairing is checked by parsing the stylesheet into
  // real rules and looking for the selectors, never by searching the file for a substring.
  it('has a stylesheet rule for every modifier the component can emit', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const style = document.createElement('style');
    // `@import 'tailwindcss'` is dropped before parsing: jsdom cannot resolve it from `about:blank`
    // and the rules under test are this file's own, not Tailwind's.
    style.textContent = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')
      .replace(/^@import[^;]*;$/m, '');
    document.head.appendChild(style);
    try {
      const selectors = [...style.sheet!.cssRules]
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .map(rule => rule.selectorText);
      expect(selectors).toContain('.ln-ai-description-railwrap--left');
      expect(selectors).toContain('.ln-ai-description-railwrap--bottom');
      expect(selectors).toContain('.ln-ai-description-railwrap--left .ln-ai-description-rail');
      expect(selectors).toContain('.ln-ai-description-railwrap--bottom .ln-ai-description-rail');
    } finally {
      style.remove();
    }
  });
});
