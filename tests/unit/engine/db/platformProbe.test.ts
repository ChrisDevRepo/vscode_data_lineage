/**
 * Pins platform detection on a failed `platform-info` probe: the mssql extension's server metadata is
 * the fallback, while a built-in session — whose server info runs that same query — goes straight to
 * the explicit unknown platform without sending it twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../../src/bridge/host';
import type { SimpleExecuteResult } from '../../../../src/types/mssql';

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: unknown[]) => parts.join('/') },
  ProgressLocation: { Notification: 15 },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
}));

const connectDatabase = vi.fn();
vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
  loadDmvQueries: async () => [
    { name: 'schema-preview', sql: 'SELECT schema_preview', phase: 1 },
    { name: 'platform-info', sql: 'SELECT platform_info', phase: 1 },
  ],
}));

const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');

const preview: SimpleExecuteResult = {
  rowCount: 1,
  columnInfo: ['schema_name', 'type_code', 'object_count'].map((columnName, columnOrdinal) => ({ columnName, columnOrdinal, dataType: 'nvarchar', dataTypeName: 'nvarchar' })),
  rows: [['dbo', 'U', '1'].map((displayValue) => ({ displayValue, isNull: false }))],
};

function fakeSession(provider: 'builtIn' | 'mssqlExtension') {
  return {
    provider,
    connectionInfo: { server: 'localhost', database: 'Sales' },
    executeSimpleQuery: vi.fn(async (sql: string) => {
      if (sql.includes('platform_info')) throw new Error('VIEW SERVER STATE permission denied');
      return preview;
    }),
    getServerInfo: vi.fn(async () => ({ engineEditionId: 3, serverMajorVersion: 16, serverEdition: 'Developer Edition' })),
    dispose: vi.fn(async () => undefined),
  };
}

async function connect(session: ReturnType<typeof fakeSession>) {
  connectDatabase.mockResolvedValue(session);
  const host = {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    getExtensionUri: () => 'ext',
    withProgress: vi.fn((_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })),
  } as unknown as BridgeHost;
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: vi.fn(), update: vi.fn() }, secrets: {}, extensionUri: 'ext' } as never,
    () => ({ isDbSession: true }) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never,
    () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
    vi.fn(),
    vi.fn(),
    false,
    vi.fn(),
  );
  await handlers['db-connect']({ type: 'db-connect' });
  const posted = vi.mocked(host.postMessage).mock.calls.map(([message]) => message as { type: string });
  return posted.find((m) => m.type === 'db-schema-preview') as { preview: { platform?: string } } | undefined;
}

describe('platform detection after a failed platform-info probe', () => {
  beforeEach(() => connectDatabase.mockReset());

  it('a built-in session does not resend platform-info through getServerInfo', async () => {
    const session = fakeSession('builtIn');
    const result = await connect(session);

    expect(session.getServerInfo).not.toHaveBeenCalled();
    expect(session.executeSimpleQuery.mock.calls.filter(([sql]) => sql.includes('platform_info'))).toHaveLength(1);
    expect(result).toBeDefined();
  });

  it('an mssql-extension session falls back to its server metadata', async () => {
    const session = fakeSession('mssqlExtension');
    const result = await connect(session);

    expect(session.getServerInfo).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });
});
