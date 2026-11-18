// @vitest-environment jsdom
/**
 * Pins the cancel race of the project loader: a result that the host posts after the user pressed
 * Cancel carries the cancelled load's id and is dropped, so a late model never lands. Cancel tells the
 * host which load to stop (`cancel-load`), and a load started afterwards still works.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { useDacpacLoader, type DacpacLoaderState } from '../../../src/hooks/useDacpacLoader';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let loader: DacpacLoaderState;
const postMessage = vi.fn();

function Probe() {
  loader = useDacpacLoader(() => {});
  return null;
}

beforeEach(() => {
  postMessage.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<VsCodeProvider api={{ postMessage } as never}><Probe /></VsCodeProvider>));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const MODEL = { nodes: [], edges: [], schemas: [], neighborIndex: {}, catalog: {} };

function receive(msg: Record<string, unknown>): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { ...msg, protocolVersion: BRIDGE_PROTOCOL_VERSION } })); });
}
const model = (loadId: string | undefined, sourceName = 'Sales') =>
  ({ type: 'dacpac-model', model: MODEL, config: DEFAULT_CONFIG, sourceName, ...(loadId ? { loadId } : {}) });

/** The id the webview put on its last request of `type`. */
const sentId = (type: string): string => {
  const sent = postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === type);
  return sent[sent.length - 1].loadId as string;
};

describe('cancelLoading', () => {
  it('sends its own load id with the request and cancels that id', () => {
    act(() => loader.loadProject('p1'));
    const loadId = sentId('load-project');
    expect(loadId).toBeTruthy();

    act(() => loader.cancelLoading());
    expect(postMessage).toHaveBeenCalledWith({ type: 'cancel-load', loadId });
  });

  it('drops a model that arrives after the cancel', () => {
    act(() => loader.loadProject('p1'));
    const loadId = sentId('load-project');
    act(() => loader.cancelLoading());

    receive(model(loadId));
    expect(loader.model).toBeNull();
    expect(loader.isLoading).toBe(false);
    expect(loader.pendingVisualize).toBe(false);
  });

  it('drops the model of a load cancelled right after the send, before the host answered anything', () => {
    act(() => { loader.connectToDatabase(); loader.cancelLoading(); });
    const loadId = sentId('db-connect');
    expect(postMessage).toHaveBeenCalledWith({ type: 'cancel-load', loadId });

    receive(model(loadId));
    expect(loader.model).toBeNull();
  });

  it('also drops progress and error messages of the cancelled load', () => {
    act(() => loader.connectToDatabase());
    const loadId = sentId('db-connect');
    act(() => loader.cancelLoading());

    receive({ type: 'db-progress', step: 1, total: 3, label: 'Loading', loadId });
    receive({ type: 'db-error', message: 'late failure', phase: 'connect', loadId });
    expect(loader.status).toBeNull();
  });

  it('a load started after a cancel still applies its model, and the cancelled id stays dropped', () => {
    act(() => loader.loadProject('p1'));
    const first = sentId('load-project');
    act(() => loader.cancelLoading());

    act(() => loader.loadProject('p2'));
    const second = sentId('load-project');
    expect(second).not.toBe(first);
    receive(model(first, 'Late'));
    expect(loader.model).toBeNull();
    receive(model(second, 'Fresh'));
    expect(loader.fileName).toBe('Fresh');
  });

  it('a second load supersedes the first without a cancel, and only the second model applies', () => {
    act(() => loader.loadProject('p1'));
    const first = sentId('load-project');
    act(() => loader.loadProject('p2'));
    const second = sentId('load-project');

    receive(model(first, 'Superseded'));
    expect(loader.model).toBeNull();
    receive(model(second, 'Current'));
    expect(loader.fileName).toBe('Current');
    receive(model(first, 'Superseded'));
    expect(loader.fileName).toBe('Current');
    expect(postMessage.mock.calls.some(([m]) => m.type === 'cancel-load')).toBe(false);
  });

  it('a result that carries no load id still applies (host-initiated restore)', () => {
    receive(model(undefined, 'Restored'));
    expect(loader.fileName).toBe('Restored');
  });

  it('a result for a load this webview never sent still applies after a reload', () => {
    receive(model('sent-before-the-reload', 'In flight'));
    expect(loader.fileName).toBe('In flight');
  });

  it('does not send cancel-load when no load was sent', () => {
    act(() => loader.cancelLoading());
    expect(postMessage.mock.calls.some(([m]) => m.type === 'cancel-load')).toBe(false);
  });

  it.each([
    ['openFile', () => loader.openFile(), 'open-dacpac'],
    ['loadDemo', () => loader.loadDemo(), 'load-demo'],
    ['connectToDatabase', () => loader.connectToDatabase(), 'db-connect'],
    ['visualize', () => loader.visualize(new Set(['dbo'])), 'db-visualize'],
  ] as const)('%s sends a load id', (_name, send, type) => {
    act(() => send());
    expect(sentId(type)).toBeTruthy();
  });
});
