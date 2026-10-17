import { detailHandlers } from '../../helpers/testUtils';
/** Pins the table-statistics connection lifetime: a built-in connection is opened per request and closed afterwards; a DACPAC model never reaches a database. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectDatabase = vi.fn();
let detailPanelListener: ((message: unknown) => Promise<void>) | undefined;

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { detailPanelStub } = await import('../../helpers/testUtils');
  return {
    ...actual,
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    ViewColumn: { Beside: -2 },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
    },
    window: {
      createWebviewPanel: () => detailPanelStub(listener => { detailPanelListener = listener; }),
    },
  };
});

vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));


const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');

function fakeSession() {
  return {
    connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
    getServerInfo: vi.fn().mockResolvedValue({ engineEditionId: 3 }),
    executeSimpleQuery: vi.fn().mockRejectedValue(new Error('query failed')),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOutputChannel() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
}

async function requestStatsTwice(
  isDbSession = true,
  outputChannel = makeOutputChannel(),
  settings: Record<string, unknown> = {},
): Promise<() => Promise<void>> {
  const { handlers, cleanup } = detailHandlers(createMessageHandlers, { isDbSession, outputChannel: outputChannel as never, settings });
  await handlers['show-detail']({ type: 'show-detail' });
  for (let i = 0; i < 2; i++) {
    await detailPanelListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [] });
  }
  return cleanup;
}

describe('table statistics connection lifetime', () => {
  beforeEach(() => connectDatabase.mockReset());

  it('opens and closes a built-in connection for every request', async () => {
    const sessions = [fakeSession(), fakeSession()];
    connectDatabase.mockResolvedValueOnce(sessions[0]).mockResolvedValueOnce(sessions[1]);

    await requestStatsTwice();

    expect(connectDatabase).toHaveBeenCalledTimes(2);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1].dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a failed profiling query', {}, (session: ReturnType<typeof fakeSession>) => session],
    ['a table with no profileable columns', {}, (session: ReturnType<typeof fakeSession>) => {
      session.executeSimpleQuery.mockResolvedValue({ rowCount: 1, columnInfo: [], rows: [[{ displayValue: '5', isNull: false }]] });
      return session;
    }],
    ['profiling switched off', { 'tableStatistics.enabled': false }, (session: ReturnType<typeof fakeSession>) => session],
  ] as const)('%s logs the object name at debug only', async (_case, settings, prepare) => {
    connectDatabase.mockImplementation(async () => prepare(fakeSession()));
    const channel = makeOutputChannel();

    await requestStatsTwice(true, channel, settings);

    const lines = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(([line]) => String(line));
    expect(lines(channel.info).length).toBeGreaterThan(0);
    expect(lines(channel.info).filter((line) => line.includes('Orders'))).toEqual([]);
    expect(lines(channel.debug).some((line) => line.includes('dbo.Orders'))).toBe(true);
  });

  it('a request from a detail panel while a DACPAC model is loaded never connects', async () => {

    await requestStatsTwice(false);

    expect(connectDatabase).not.toHaveBeenCalled();
  });
});
