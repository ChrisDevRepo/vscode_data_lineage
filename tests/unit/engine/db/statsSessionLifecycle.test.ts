/**
 * Pins the table-statistics connection lifetime: a built-in connection is opened per request and
 * closed afterwards; an mssql-extension connection is negotiated once and reused; a DACPAC model never
 * reaches a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../../src/bridge/host';

const connectDatabase = vi.fn();
let provider = 'builtIn';
let detailPanelListener: ((message: unknown) => Promise<void>) | undefined;

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    ViewColumn: { Beside: -2 },
    workspace: {
      getConfiguration: () => ({ get: (key: string) => (key === 'connectionProvider' ? provider : undefined) }),
    },
    window: {
      createWebviewPanel: () => ({
        title: '',
        reveal: vi.fn(),
        onDidDispose: () => ({ dispose: () => {} }),
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (uri: unknown) => uri,
          onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
            detailPanelListener = listener;
            return { dispose: () => {} };
          },
          postMessage: async () => true,
        },
      }),
    },
  };
});

vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));

const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');

function fakeSession(kind: string) {
  return {
    provider: kind,
    connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
    getServerInfo: vi.fn().mockResolvedValue({ engineEditionId: 3 }),
    executeSimpleQuery: vi.fn().mockRejectedValue(new Error('query failed')),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

async function requestStatsTwice(isDbSession = true): Promise<void> {
  const host = {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getExtensionUri: () => 'ext',
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  } as unknown as BridgeHost;
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: vi.fn(), update: vi.fn() }, secrets: {} } as never,
    () => ({ isDbSession }) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never,
    () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
    vi.fn(),
    vi.fn(),
    false,
    vi.fn(),
  );
  await handlers['show-detail']({ type: 'show-detail' });
  for (let i = 0; i < 2; i++) {
    await detailPanelListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [] });
  }
}

describe('table statistics connection lifetime', () => {
  beforeEach(() => connectDatabase.mockReset());

  it('opens and closes a built-in connection for every request', async () => {
    provider = 'builtIn';
    const sessions = [fakeSession('builtIn'), fakeSession('builtIn')];
    connectDatabase.mockResolvedValueOnce(sessions[0]).mockResolvedValueOnce(sessions[1]);

    await requestStatsTwice();

    expect(connectDatabase).toHaveBeenCalledTimes(2);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('reuses one mssql-extension connection across requests', async () => {
    provider = 'mssqlExtension';
    const session = fakeSession('mssqlExtension');
    connectDatabase.mockResolvedValue(session);

    await requestStatsTwice();

    expect(connectDatabase).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('a request from a detail panel while a DACPAC model is loaded never connects', async () => {
    provider = 'builtIn';

    await requestStatsTwice(false);

    expect(connectDatabase).not.toHaveBeenCalled();
  });
});
