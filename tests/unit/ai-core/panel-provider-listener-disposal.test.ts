import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The webview `onDidReceiveMessage` listener is scoped to the panel's own disposable array (drained from `panel.onDidDispose`), never to `context.subscriptions` (extension lifetime). */

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
    expect(context.subscriptions).not.toContain(listenerDisposable);

    for (const listener of vscodeMocks.panelDisposeListeners) listener();

    expect(listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(context.subscriptions.length).toBe(0);
  });
});
