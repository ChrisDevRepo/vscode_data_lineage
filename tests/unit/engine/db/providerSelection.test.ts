/**
 * Pins provider selection: the setting default, the built-in path never reaching the mssql
 * extension, stored records without a provider reading as mssqlExtension, and the setting winning
 * over a stored provider with a single notice.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  showQuickPick: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  getExtension: vi.fn(),
  openBuiltInSession: vi.fn(),
  runAddConnectionFlow: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    extensions: { ...actual.extensions, getExtension: (...a: unknown[]) => host.getExtension(...a) },
    window: {
      showQuickPick: (...a: unknown[]) => host.showQuickPick(...a),
      showInformationMessage: (...a: unknown[]) => host.showInformationMessage(...a),
      showWarningMessage: (...a: unknown[]) => host.showWarningMessage(...a),
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
    },
    commands: { executeCommand: vi.fn() },
    workspace: {
      getConfiguration: (section: string) => ({
        get: (key: string, d: unknown) => host.settings[`${section}.${key}`] ?? d,
        inspect: (key: string) => ({ globalValue: host.settings[`${section}.${key}`] }),
      }),
    },
  };
});

vi.mock('../../../../src/engine/db/builtInProvider', () => ({
  openBuiltInSession: (...a: unknown[]) => host.openBuiltInSession(...a),
}));
vi.mock('../../../../src/engine/db/connectionCommands', () => ({
  runAddConnectionFlow: (...a: unknown[]) => host.runAddConnectionFlow(...a),
}));

const { connectDatabase, getConnectionAvailability } = await import('../../../../src/engine/connectionManager');
const { getConnectionProvider, DbConnectionError } = await import('../../../../src/engine/db/dbSession');

const outputChannel = { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as never;
const env = { secrets: {} as never, outputChannel, loadQueries: async () => [] };
const MSSQL_ID = 'ms-mssql.mssql';

const local = {
  id: 'id-local', name: 'Local', server: 'localhost', database: 'AdventureWorks', authenticationType: 'sqlLogin', user: 'sa',
};
const cloud = {
  id: 'id-cloud', name: 'Cloud', server: 'x.database.windows.net', database: 'db1', authenticationType: 'entraId',
};

function fakeBuiltInSession(conn: Record<string, any>) {
  return {
    provider: 'builtIn' as const,
    connectionInfo: { server: conn.server, database: conn.database ?? '', provider: 'builtIn', connectionId: conn.id },
    executeSimpleQuery: vi.fn(), getServerInfo: vi.fn(), dispose: vi.fn(),
  };
}

const activate = vi.fn();
const mssqlConnect = vi.fn(async () => 'uri://mssql');
const mssqlExecute = vi.fn(async () => ({ rowCount: 0, columnInfo: [], rows: [] }));
const mssqlDisconnect = vi.fn(async () => {});

function installMssql() {
  host.getExtension.mockImplementation((id: string) => id === MSSQL_ID ? {
    isActive: true,
    activate,
    packageJSON: { version: '1.45.1' },
    exports: {
      promptForConnection: async () => ({ server: 'localhost', database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin', port: 1433 }),
      connect: mssqlConnect,
      connectionSharing: { executeSimpleQuery: mssqlExecute, disconnect: mssqlDisconnect, getServerInfo: vi.fn() },
    },
  } : undefined);
}

beforeEach(() => {
  host.settings = {};
  for (const fn of [host.showQuickPick, host.showInformationMessage, host.showWarningMessage, host.getExtension, host.openBuiltInSession, host.runAddConnectionFlow, activate, mssqlConnect, mssqlExecute, mssqlDisconnect]) fn.mockClear();
  host.getExtension.mockReset();
  host.openBuiltInSession.mockImplementation(async (conn: Record<string, any>) => fakeBuiltInSession(conn));
});

describe('getConnectionProvider', () => {
  it('defaults to mssqlExtension', () => {
    expect(getConnectionProvider()).toBe('mssqlExtension');
  });

  it('reads builtIn from the setting and falls back on an unknown value', () => {
    host.settings['dataLineageViz.database.connectionProvider'] = 'builtIn';
    expect(getConnectionProvider()).toBe('builtIn');
    host.settings['dataLineageViz.database.connectionProvider'] = 'carrierPigeon';
    expect(getConnectionProvider()).toBe('mssqlExtension');
  });
});

describe('getConnectionAvailability', () => {
  it('builtIn is always available and does not look up the mssql extension', () => {
    host.settings['dataLineageViz.database.connectionProvider'] = 'builtIn';
    expect(getConnectionAvailability()).toEqual({ provider: 'builtIn', available: true });
    expect(host.getExtension).not.toHaveBeenCalled();
  });

  it('mssqlExtension is available only when the extension is installed and enabled', () => {
    expect(getConnectionAvailability()).toEqual({ provider: 'mssqlExtension', available: false });
    installMssql();
    expect(getConnectionAvailability()).toEqual({ provider: 'mssqlExtension', available: true });
  });
});

describe('connectDatabase — builtIn', () => {
  beforeEach(() => {
    host.settings['dataLineageViz.database.connectionProvider'] = 'builtIn';
    host.settings['dataLineageViz.database.connections'] = [local, cloud];
    installMssql();
  });

  it('offers the saved connections plus an add item, and opens the chosen one', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string; connection?: unknown }>) => items.find((i) => i.label === 'Cloud'));

    const session = await connectDatabase(env);

    const items = host.showQuickPick.mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((i) => i.label)).toEqual(['Local', 'Cloud', '$(add) Add Connection…']);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-cloud' }), env, expect.anything());
    expect(session?.provider).toBe('builtIn');
  });

  it('the add item runs the add flow and connects the new connection', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Add Connection')));
    host.runAddConnectionFlow.mockResolvedValue({ ...local, id: 'id-new', name: 'New' });

    const session = await connectDatabase(env);

    expect(host.runAddConnectionFlow).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-new' }), env, expect.anything());
    expect(session?.provider).toBe('builtIn');
  });

  it('returns undefined when the picker is dismissed', async () => {
    host.showQuickPick.mockResolvedValue(undefined);
    await expect(connectDatabase(env)).resolves.toBeUndefined();
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
  });

  it('never looks up, activates or calls the mssql extension', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items[0]);
    await connectDatabase(env);
    await connectDatabase(env, { server: 'localhost', database: 'AdventureWorks', provider: 'builtIn', connectionId: 'id-local' });

    expect(host.getExtension.mock.calls.filter(([id]) => id === MSSQL_ID)).toHaveLength(0);
    expect(activate).not.toHaveBeenCalled();
    expect(mssqlConnect).not.toHaveBeenCalled();
  });

  it('reconnects a stored built-in project by connectionId without a picker', async () => {
    const session = await connectDatabase(env, {
      server: 'localhost', database: 'Sales', provider: 'builtIn', connectionId: 'id-local',
    });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-local' }), env, expect.objectContaining({ database: 'Sales' }),
    );
    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(session?.provider).toBe('builtIn');
  });

  it('a stored mssql record maps onto a saved built-in connection with the same server and user, and says the setting won once', async () => {
    const session = await connectDatabase(env, {
      server: 'LOCALHOST', database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin',
    });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, expect.anything());
    expect(host.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(String(host.showInformationMessage.mock.calls[0][0])).toMatch(/built-in/i);
    expect(session?.provider).toBe('builtIn');
  });

  it('falls back to the picker when no saved connection matches the stored record', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items[0]);
    await connectDatabase(env, { server: 'unknown-host', database: 'db', provider: 'builtIn', connectionId: 'gone' });
    expect(host.showQuickPick).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, expect.anything());
  });

  it('pre-fills the add flow from a stored project that matches no saved connection', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Add Connection')));
    host.runAddConnectionFlow.mockResolvedValue({ ...local, id: 'id-new', name: 'New' });

    await connectDatabase(env, {
      server: 'sql.example.com', port: 14333, database: 'Sales', user: 'reader', authenticationType: 'SqlLogin', email: 'x@example.com',
    });

    expect(host.runAddConnectionFlow).toHaveBeenCalledWith(env, undefined, {
      server: 'sql.example.com', port: 14333, database: 'Sales', user: 'reader',
    });
  });
});

describe('connectDatabase — builtIn failures', () => {
  beforeEach(() => {
    host.settings['dataLineageViz.database.connectionProvider'] = 'builtIn';
    host.settings['dataLineageViz.database.connections'] = [local];
    installMssql();
  });

  it('wraps an open failure in DbConnectionError with the connection name and the unchanged text', async () => {
    const original = Object.assign(new Error("Login failed for user 'sa'."), { number: 18456 });
    host.openBuiltInSession.mockRejectedValueOnce(original);
    const err = await connectDatabase(env, { server: 'localhost', database: 'AdventureWorks', provider: 'builtIn', connectionId: 'id-local' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbConnectionError);
    expect((err as Error).message).toBe("Login failed for user 'sa'.");
    expect((err as InstanceType<typeof DbConnectionError>).original).toBe(original);
    expect((err as InstanceType<typeof DbConnectionError>).target).toMatchObject({ name: 'Local', provider: 'builtIn', connectionId: 'id-local' });
  });
});

describe('connectDatabase — mssqlExtension', () => {
  beforeEach(() => installMssql());

  it('reads a stored record without a provider as mssqlExtension and reconnects through the extension', async () => {
    const session = await connectDatabase(env, { server: 'localhost', database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin' });

    expect(mssqlConnect).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(session?.provider).toBe('mssqlExtension');
    expect(session?.connectionInfo).toMatchObject({ server: 'localhost', database: 'AdventureWorks' });

    await session!.executeSimpleQuery('SELECT 1');
    expect(mssqlExecute).toHaveBeenCalledWith('uri://mssql', 'SELECT 1');
    await session!.dispose();
    expect(mssqlDisconnect).toHaveBeenCalledWith('uri://mssql');
  });

  it('prompts through the mssql extension when nothing is stored', async () => {
    const session = await connectDatabase(env);
    expect(session?.provider).toBe('mssqlExtension');
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
  });

  it('a stored built-in record yields to the setting with one notice', async () => {
    const session = await connectDatabase(env, {
      server: 'localhost', database: 'AdventureWorks', provider: 'builtIn', connectionId: 'id-local',
    });

    expect(session?.provider).toBe('mssqlExtension');
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
    expect(host.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(String(host.showInformationMessage.mock.calls[0][0])).toMatch(/mssql|SQL Server/i);
  });

  it('wraps a connect failure in DbConnectionError carrying the original driver text', async () => {
    mssqlConnect.mockRejectedValue(new Error("Login failed for user 'sa'."));
    const err = await connectDatabase(env).catch((e: unknown) => e);
    mssqlConnect.mockReset();
    mssqlConnect.mockResolvedValue('uri://mssql');
    expect(err).toBeInstanceOf(DbConnectionError);
    expect((err as Error).message).toBe("Login failed for user 'sa'.");
    expect((err as InstanceType<typeof DbConnectionError>).target.provider).toBe('mssqlExtension');
  });

  it('reports a missing extension with the install instruction', async () => {
    host.getExtension.mockReset();
    await expect(connectDatabase(env)).rejects.toThrow(/not installed or is disabled/);
  });
});
