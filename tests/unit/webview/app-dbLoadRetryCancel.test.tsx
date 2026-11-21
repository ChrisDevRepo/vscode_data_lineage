// @vitest-environment jsdom
/**
 * A failed database load in the App: the countdown retries the load instead of falling back to the
 * start view, and Cancel (during the countdown or the wait) ends it with no further attempt and
 * returns to where the load came from. A load started from the create form returns to that form
 * with its name and schema choice, and Visualize there goes to the database again.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/components/App';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { type: string; loadId?: string; [key: string]: unknown };

const COUNTDOWN_MS = 8000;
const PROJECT = {
  id: 'p1', name: 'Azure project', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  connection: {
    type: 'database', sourceName: 'x / db', schemas: ['dbo'],
    connectionInfo: { server: 'x.database.windows.net', database: 'db', authenticationType: 'entraId' },
  },
};
const PREVIEW = { schemas: [{ name: 'dbo', nodeCount: 3, types: { table: 3, view: 0, procedure: 0, function: 0, external: 0 } }], totalObjects: 3 };

describe('App database load failure', () => {
  let container: HTMLDivElement;
  let root: Root;
  let posted: Posted[];

  const send = (msg: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...msg } })); });
  const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  const click = (text: string) => { const b = button(text); expect(b, `button "${text}"`).toBeDefined(); act(() => b?.click()); };
  const last = (type: string) => posted.filter((m) => m.type === type).at(-1);
  const count = (type: string) => posted.filter((m) => m.type === type).length;
  const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<VsCodeProvider api={{ postMessage: (m: Posted) => { posted.push(m); }, getState: () => undefined, setState: () => undefined } as never}><App /></VsCodeProvider>);
    });
    send({ type: 'projects-list', projects: [PROJECT], lastOpenedId: 'p1', lastWizardView: 'main' });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('retries a saved project when the countdown ends, then returns to start after a second failure', () => {
    click('Azure project');
    expect(count('load-project')).toBe(1);
    send({ type: 'db-error', message: 'raw', loadId: last('load-project')?.loadId });
    tick(COUNTDOWN_MS + 250);
    expect(count('load-project')).toBe(2);
    expect(container.textContent).toContain('Load');
    send({ type: 'db-error', message: 'raw', loadId: last('load-project')?.loadId });
    tick(COUNTDOWN_MS + 250);
    expect(count('load-project')).toBe(2);
    expect(button('Open')).toBeUndefined();
    expect(button('Create New Project')).toBeDefined();
  });

  it('Cancel during the countdown starts no retry and returns to start', () => {
    click('Azure project');
    send({ type: 'db-error', message: 'raw', loadId: last('load-project')?.loadId });
    tick(3000);
    click('Cancel');
    tick(COUNTDOWN_MS * 3);
    expect(count('load-project')).toBe(1);
    expect(button('Create New Project')).toBeDefined();
  });

  it('a saved project waiting on the database is not timed out by the 20 s file watchdog', () => {
    click('Azure project');
    send({ type: 'db-progress', label: 'Waking up the database.', loadId: last('load-project')?.loadId });
    tick(60_000);
    expect(container.textContent).not.toContain('timed out');
    expect(container.textContent).toContain('Waking up the database.');
    expect(count('load-project')).toBe(1);
  });

  it('Cancel during the wait aborts the load on the host', () => {
    click('Azure project');
    const loadId = last('load-project')?.loadId;
    send({ type: 'db-progress', label: 'Waking up the database.', loadId });
    expect(container.textContent).toContain('Waking up the database.');
    tick(5000);
    expect(container.textContent).toContain('(5s)');
    click('Cancel');
    expect(last('cancel-load')?.loadId).toBe(loadId);
    expect(button('Create New Project')).toBeDefined();
  });

  describe('from the create form', () => {
    const toFailedVisualize = () => {
      click('Create New Project');
      click('Connect to database');
      send({ type: 'db-schema-preview', preview: PREVIEW, config: DEFAULT_CONFIG, sourceName: 'x / db', loadId: last('db-connect')?.loadId });
      const name = container.querySelector('input[type="text"]') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'My lineage');
        name.dispatchEvent(new Event('input', { bubbles: true }));
      });
      click('Visualize');
      expect(count('db-visualize')).toBe(1);
      send({ type: 'db-error', message: 'raw', loadId: last('db-visualize')?.loadId });
    };

    it('retries the database load when the countdown ends', () => {
      toFailedVisualize();
      tick(COUNTDOWN_MS + 250);
      expect(count('db-visualize')).toBe(2);
      expect(count('dacpac-visualize')).toBe(0);
    });

    it('Cancel returns to the form with the name and schemas kept, and Visualize goes to the database', () => {
      toFailedVisualize();
      click('Cancel');
      expect(container.textContent).toContain('Connection canceled. Your details are still filled in.');
      tick(COUNTDOWN_MS * 3);
      expect(count('db-visualize')).toBe(1);
      expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('My lineage');
      click('Visualize');
      expect(count('db-visualize')).toBe(2);
      expect(count('dacpac-visualize')).toBe(0);
    });
  });
});
