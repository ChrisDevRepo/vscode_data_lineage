// @vitest-environment jsdom
/**
 * Pins that an inline delete confirmation that replaces the button the user pressed moves keyboard
 * focus to its Cancel choice, so focus is never dropped to the page.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
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

describe('inline delete confirmations focus Cancel', () => {
  it('saved project delete', async () => {
    act(() => {
      root.render(
        <StartScreen projects={[project, { ...project, id: 'p2', name: 'Finance' }] as never} lastOpenedId={null} initialShowProjects loadingProjectId={null} startMessage={null}
          onCreateNew={noop} onOpenProject={noop} onOpenLatest={noop} onDeleteProject={noop} onDeleteAllProjects={noop} onDemo={noop} />
      );
    });
    act(() => button('Delete Sales').click());
    await flush();
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');

    act(() => (document.activeElement as HTMLButtonElement).click());
    act(() => button('Delete all').click());
    await flush();
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
  });

  it('bookmark delete', async () => {
    const profile = { id: 'v1', name: 'Morning', filter: {} };
    act(() => {
      root.render(
        <SavedViewsDropdown filterProfiles={[profile] as never} isEnabled onSaveView={noop} onApplyView={noop} onDeleteView={noop} />
      );
    });
    act(() => button('Bookmarks').click());
    await flush();
    act(() => button('Delete Morning').click());
    await flush();
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
  });
});
