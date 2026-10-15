import { detailHandlers } from '../helpers/testUtils';
/**
 * Pins how table statistics report sampling: a table that refuses `TABLESAMPLE` is profiled again
 * with a full scan, and that result is reported as unsampled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const detailMessages: Array<Record<string, unknown>> = [];
let detailPanelListener: ((message: unknown) => Promise<void>) | undefined;
const connectDatabase = vi.fn();

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { detailPanelStub } = await import('../helpers/testUtils');
  return {
    ...actual,
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    ViewColumn: { Beside: -2 },
    window: {
      createWebviewPanel: () => detailPanelStub(listener => { detailPanelListener = listener; }, message => { detailMessages.push(message as Record<string, unknown>); }),
    },
  };
});

vi.mock('../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));


const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');

const cell = (displayValue: string) => ({ displayValue, isNull: false });

const arrange = () => detailHandlers(createMessageHandlers);

beforeEach(() => { detailMessages.length = 0; connectDatabase.mockReset(); });

describe('table statistics sampling', () => {
  it('reports a full-scan retry after a refused TABLESAMPLE as unsampled', async () => {
    const executeSimpleQuery = vi.fn(async (sql: string) => {
      if (sql.includes('sys.partitions')) return { rowCount: 1, columnInfo: [{ columnName: 'row_count' }], rows: [[cell('500000')]] };
      if (sql.includes('TABLESAMPLE')) throw new Error('TABLESAMPLE cannot be applied to this object');
      return { rowCount: 1, columnInfo: [{ columnName: 'c0_d' }], rows: [[cell('42')]] };
    });
    connectDatabase.mockResolvedValue({
      connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
      getServerInfo: vi.fn().mockResolvedValue({ engineEditionId: 3 }),
      executeSimpleQuery,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const log = vi.fn();
    const { handlers } = detailHandlers(createMessageHandlers, { log });

    const node = { id: '[dbo].[Orders]', schema: 'dbo', name: 'Orders', fullName: '[dbo].[Orders]', type: 'table' as const };
    await handlers['show-detail']({ type: 'show-detail', node });
    expect(log.mock.calls.filter(([level]) => level !== 'debug').map(([, , text]) => text).join('\n')).not.toContain(node.id);
    expect(log.mock.calls.filter(([level]) => level === 'debug').map(([, , text]) => text).join('\n')).toContain(node.id);
    await detailPanelListener!({
      type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick',
      columns: [{ name: 'Id', type: 'int', nullable: 'NOT NULL', extra: '' }],
    });

    expect(executeSimpleQuery.mock.calls.map(([sql]) => /TABLESAMPLE/.test(sql))).toEqual([false, true, false]);
    const result = detailMessages.find((message) => message.type === 'table-stats-result');
    expect(result).toMatchObject({ objectRef: { schema: 'dbo', objectName: 'Orders' }, stats: { rowCount: 500000, sampled: false } });
    expect((result?.stats as { samplePercent?: number }).samplePercent).toBeUndefined();
  });
});

describe('profiling request cleanup', () => {
  it.each([false, true])('releases a request connection when cleanup begins with pending=%s', async (pending) => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const session = {
      connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
      getServerInfo: async () => ({ engineEditionId: 3 }), dispose,
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
    expect(detailMessages).toContainEqual(expect.objectContaining({ type: 'table-stats-error', objectRef: { schema: 'dbo', objectName: 'Orders' }, message: 'synthetic negotiation failure' }));
  });

});
