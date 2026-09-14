// @vitest-environment jsdom
//
// Behavioural cover for the AI report header's dock dropdown — the replacement for the three
// always-visible glyph buttons. The trigger must advertise a menu (aria-haspopup/expanded), the
// open menu must list every dock position as a radio entry with the current one checked, and
// choosing an entry must report it and close the menu. Only observable by mounting.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  viewName: 'Test view',
  description: 'Body text',
  expanded: true,
};

function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[];
}

describe('AI report dock dropdown', () => {
  it('renders one menu trigger advertising the current position, not three buttons', () => {
    mount(<AiDescriptionOverlay {...PROPS} dockPosition="right" />);
    const triggers = document.querySelectorAll('button[aria-label="Report panel dock position"]');
    expect(triggers.length).toBe(1);
    const trigger = triggers[0] as HTMLElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('lists every dock position with the active one checked', () => {
    mount(<AiDescriptionOverlay {...PROPS} dockPosition="bottom" />);
    const trigger = document.querySelector('button[aria-label="Report panel dock position"]') as HTMLElement;
    act(() => trigger.click());
    const items = menuItems();
    expect(items.map(item => item.textContent)).toEqual(['Dock left', '✓Dock bottom', 'Dock right']);
    const checked = items.filter(item => item.getAttribute('aria-checked') === 'true');
    expect(checked.length).toBe(1);
    expect(checked[0].textContent).toBe('✓Dock bottom');
  });

  it('reports the chosen position and closes the menu', () => {
    const onDockPositionChange = vi.fn();
    mount(<AiDescriptionOverlay {...PROPS} dockPosition="right" onDockPositionChange={onDockPositionChange} />);
    const trigger = document.querySelector('button[aria-label="Report panel dock position"]') as HTMLElement;
    act(() => trigger.click());
    expect(menuItems().length).toBe(3);
    const left = menuItems().find(item => item.textContent === 'Dock left');
    expect(left).toBeDefined();
    act(() => left!.click());
    expect(onDockPositionChange).toHaveBeenCalledWith('left');
    expect(menuItems().length).toBe(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
