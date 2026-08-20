import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for A20 — the webview `onDidReceiveMessage` listener was registered against
 * `context.subscriptions` (extension lifetime) instead of the panel's own disposable array, so a
 * closed-and-reopened panel left the previous listener attached to a disposed webview. Fixed by
 * `4e5b885`, which scopes the registration to a `panelDisposables` array drained from
 * `panel.onDidDispose`. This pins that release: no `vscode` webview mock existed for
 * `panelProvider.ts` before this test.
 */

const vscodeMocks = vi.hoisted(() => ({
  panelDisposeListeners: [] as Array<() => void>,
  messageListenerDisposable: { dispose: vi.fn() },
  createWebviewPanel: vi.fn(),
}));

vi.mock('vscode', () => {
  const fakeWebview = {
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: vi.fn((uri: unknown) => uri),
    onDidReceiveMessage: vi.fn(
      (
        _listener: (...args: unknown[]) => unknown,
        _thisArg: unknown,
        disposables: Array<{ dispose: () => void }>,
      ) => {
        vscodeMocks.messageListenerDisposable = { dispose: vi.fn() };
        disposables.push(vscodeMocks.messageListenerDisposable);
        return vscodeMocks.messageListenerDisposable;
      },
    ),
  };
  const fakePanel = {
    webview: fakeWebview,
    reveal: vi.fn(),
    onDidDispose: vi.fn((listener: () => void) => {
      vscodeMocks.panelDisposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
  };
  vscodeMocks.createWebviewPanel.mockReturnValue(fakePanel);
  return {
    ViewColumn: { One: 1 },
    Uri: { joinPath: vi.fn(() => ({})) },
    window: { createWebviewPanel: vscodeMocks.createWebviewPanel },
    commands: { executeCommand: vi.fn() },
    extensions: {
      getExtension: vi.fn(() => undefined),
      onDidChange: vi.fn(
        (
          _listener: (...args: unknown[]) => unknown,
          _thisArg: unknown,
          disposables: Array<{ dispose: () => void }>,
        ) => {
          const disposable = { dispose: vi.fn() };
          disposables.push(disposable);
          return disposable;
        },
      ),
    },
  };
});

vi.mock('../../../src/bridge/host', () => ({
  createBridgeHost: vi.fn(() => ({ showErrorMessage: vi.fn() })),
  summarizeZodError: vi.fn(() => 'zod-error'),
}));

vi.mock('../../../src/bridge/messageHandlers', () => ({
  PROJECT_STORE_KEY: 'dataLineageViz.projectStore',
  createMessageHandlers: vi.fn(() => ({
    handlers: {},
    cleanup: vi.fn().mockResolvedValue(undefined),
    triggerDemoLoad: vi.fn(),
  })),
  buildDebugDump: vi.fn(() => ''),
  isMssqlAvailable: vi.fn(() => false),
}));

function makeFakeSession() {
  return {
    phase: { kind: 'idle' },
    resetExploration: vi.fn(),
    model: null,
    graph: null,
    columnStore: { clear: vi.fn() },
    clearDiscoveryTranscript: vi.fn(),
  };
}

function makeOutputChannel() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('openPanel — webview message listener disposal (A20)', () => {
  beforeEach(() => {
    vi.resetModules();
    vscodeMocks.panelDisposeListeners.length = 0;
    vscodeMocks.createWebviewPanel.mockClear();
  });

  it('disposes the message listener when the panel is disposed, and never through context.subscriptions', async () => {
    const { openPanel } = await import('../../../src/panelProvider');
    const fakeSession = makeFakeSession();
    const context = { extensionUri: {}, subscriptions: [] as unknown[] };

    openPanel(
      context as never,
      'Data Lineage',
      () => fakeSession as never,
      makeOutputChannel() as never,
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
      false,
    );

    expect(vscodeMocks.panelDisposeListeners.length).toBeGreaterThan(0);
    const listenerDisposable = vscodeMocks.messageListenerDisposable;
    expect(listenerDisposable.dispose).not.toHaveBeenCalled();
    // The bug registered this same disposable against context.subscriptions instead.
    expect(context.subscriptions).not.toContain(listenerDisposable);

    // Fire every onDidDispose listener, as vscode does when the panel's tab closes.
    for (const listener of vscodeMocks.panelDisposeListeners) listener();

    expect(listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(context.subscriptions.length).toBe(0);
  });
});
