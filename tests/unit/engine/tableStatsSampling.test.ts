/**
 * Pins how table statistics report sampling: a table that refuses `TABLESAMPLE` is profiled again
 * with a full scan, and that result is reported as unsampled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';

const detailMessages: Array<Record<string, unknown>> = [];
let detailPanelListener: ((message: unknown) => Promise<void>) | undefined;
const connectDatabase = vi.fn();
const legacy = vi.hoisted(() => ({ enabled: false }));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    ViewColumn: { Beside: -2 },
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
          postMessage: async (message: Record<string, unknown>) => { detailMessages.push(message); return true; },
        },
      }),
    },
  };
});

vi.mock('../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));

vi.mock('../../../src/engine/db/dbSession', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getConnectionProvider: () => legacy.enabled ? 'mssqlExtension' : 'builtIn',
}));

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');

const cell = (displayValue: string) => ({ displayValue, isNull: false });

function arrange() {
  const host = {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getExtensionUri: () => 'ext',
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  } as unknown as BridgeHost;
  const outputChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
  return createMessageHandlers(
    host,
    { globalState: { get: vi.fn(), update: vi.fn() }, secrets: {} } as never,
    () => ({ isDbSession: true }) as never,
    outputChannel as never,
    () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
    vi.fn(),
    vi.fn(),
    false,
    vi.fn(),
  );
}

beforeEach(() => { detailMessages.length = 0; connectDatabase.mockReset(); legacy.enabled = false; });

describe('table statistics sampling', () => {
  it('reports a full-scan retry after a refused TABLESAMPLE as unsampled', async () => {
    const executeSimpleQuery = vi.fn(async (sql: string) => {
      if (sql.includes('sys.partitions')) return { rowCount: 1, columnInfo: [{ columnName: 'row_count' }], rows: [[cell('500000')]] };
      if (sql.includes('TABLESAMPLE')) throw new Error('TABLESAMPLE cannot be applied to this object');
      return { rowCount: 1, columnInfo: [{ columnName: 'c0_d' }], rows: [[cell('42')]] };
    });
    connectDatabase.mockResolvedValue({
      provider: 'builtIn',
      connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
      getServerInfo: vi.fn().mockResolvedValue({ engineEditionId: 3 }),
      executeSimpleQuery,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const { handlers } = arrange();

    await handlers['show-detail']({ type: 'show-detail' });
    await detailPanelListener!({
      type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick',
      columns: [{ name: 'Id', type: 'int', nullable: 'NOT NULL', extra: '' }],
    });

    expect(executeSimpleQuery.mock.calls.map(([sql]) => /TABLESAMPLE/.test(sql))).toEqual([false, true, false]);
    const result = detailMessages.find((message) => message.type === 'table-stats-result');
    expect(result).toMatchObject({ schema: 'dbo', objectName: 'Orders', stats: { rowCount: 500000, sampled: false } });
    expect((result?.stats as { samplePercent?: number }).samplePercent).toBeUndefined();
  });
});

describe('kept profiling connection cleanup', () => {
  it.each([false, true])('releases a negotiated fallback when cleanup begins with pending=%s', async (pending) => {
    legacy.enabled = true;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const session = {
      provider: 'builtIn', connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
      isOpen: () => true, getServerInfo: async () => ({ engineEditionId: 3 }), dispose,
      executeSimpleQuery: async (sql: string) => ({ rowCount: 1, columnInfo: [{ columnName: sql.includes('sys.partitions') ? 'row_count' : 'c0_d' }], rows: [[cell('0')]] }),
    };
    let finishNegotiation!: () => void;
    const negotiation = new Promise<typeof session>(resolve => { finishNegotiation = () => resolve(session); });
    connectDatabase.mockReturnValue(pending ? negotiation : Promise.resolve(session));
    const { handlers, cleanup } = arrange();
    await handlers['show-detail']({ type: 'show-detail' });
    const request = detailPanelListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [{ name: 'Id', type: 'int', nullable: 'NOT NULL', extra: '' }] });
    await vi.waitFor(() => expect(connectDatabase).toHaveBeenCalledTimes(1));
    if (!pending) await request;
    const closing = cleanup();
    finishNegotiation();
    await Promise.all([request, closing]);
    expect(dispose).toHaveBeenCalledTimes(1);
    await cleanup();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleanup completes when the in-flight negotiation rejects', async () => {
    legacy.enabled = true;
    let rejectNegotiation!: (error: Error) => void;
    connectDatabase.mockReturnValue(new Promise((_, reject) => { rejectNegotiation = reject; }));
    const { handlers, cleanup } = arrange();
    await handlers['show-detail']({ type: 'show-detail' });
    const request = detailPanelListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [] });
    await vi.waitFor(() => expect(connectDatabase).toHaveBeenCalledTimes(1));
    const closing = cleanup();
    rejectNegotiation(new Error('synthetic negotiation failure'));
    await expect(closing).resolves.toBeUndefined();
    await request;
    expect(detailMessages).toContainEqual(expect.objectContaining({ type: 'table-stats-error', schema: 'dbo', objectName: 'Orders', message: 'synthetic negotiation failure' }));
  });

});
