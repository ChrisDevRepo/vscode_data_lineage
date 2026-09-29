// @vitest-environment jsdom
/**
 * Pins that an inline delete confirmation that replaces the button the user pressed moves keyboard
 * focus to its Cancel choice, and that Cancel hands focus back to that button, so focus is never
 * dropped to the page.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartScreen } from '../../../src/components/StartScreen';
import { SavedViewsDropdown } from '../../../src/components/SavedViewsDropdown';

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

/** Waits until keyboard focus sits on the button with the given text or accessible name. */
const focusSettlesOn = (name: string) => act(() => vi.waitFor(() => {
  const active = document.activeElement;
  expect(active?.textContent?.trim() === name || active?.getAttribute('aria-label') === name).toBe(true);
}, { timeout: 2000, interval: 10 }));
const noop = () => {};

function button(text: string | RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text || b.getAttribute('aria-label') === text : text.test(b.textContent ?? ''));
  if (!found) throw new Error(`button ${String(text)} not found`);
  return found as HTMLButtonElement;
}

const project = {
  id: 'p1',
  name: 'Sales',
  updatedAt: '2026-09-01T00:00:00Z',
  connection: { type: 'dacpac', path: '/tmp/sales.dacpac', schemas: ['dbo'] },
  filterProfiles: [],
};

describe('inline delete confirmations focus Cancel and return focus on Cancel', () => {
  it('saved project delete', async () => {
    act(() => {
      root.render(
        <StartScreen projects={[project, { ...project, id: 'p2', name: 'Finance' }] as never} lastOpenedId={null} initialShowProjects loadingProjectId={null} startMessage={null}
          onCreateNew={noop} onOpenProject={noop} onOpenLatest={noop} onDeleteProject={noop} onDeleteAllProjects={noop} onDemo={noop} />
      );
    });
    act(() => button('Delete Sales').click());
    await focusSettlesOn('Cancel');
    act(() => (document.activeElement as HTMLButtonElement).click());
    await focusSettlesOn('Delete Sales');

    act(() => button('Delete all').click());
    await focusSettlesOn('Cancel');
    act(() => (document.activeElement as HTMLButtonElement).click());
    await focusSettlesOn('Delete all');
  });

  it('bookmark delete', async () => {
    const profile = { id: 'v1', name: 'Morning', filter: {} };
    act(() => {
      root.render(
        <SavedViewsDropdown filterProfiles={[profile] as never} isEnabled onSaveView={noop} onApplyView={noop} onDeleteView={noop} />
      );
    });
    act(() => button('Bookmarks').click());
    await focusSettlesOn('Save current view');
    act(() => button('Delete Morning').click());
    await focusSettlesOn('Cancel');
    act(() => (document.activeElement as HTMLButtonElement).click());
    await focusSettlesOn('Delete Morning');
  });
});
