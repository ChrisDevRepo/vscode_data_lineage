/**
 * Pins how a saved database connection reopens: the picker and add flow for a new connection, the
 * saved built-in connection a stored project maps onto, and the errors a failed open carries. A
 * project saved with the retired mssql extension is pinned in `mssqlReconnectNotice.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  openBuiltInSession: vi.fn(),
  runAddConnectionFlow: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    window: {
      showQuickPick: (...a: unknown[]) => host.showQuickPick(...a),
      showInformationMessage: (...a: unknown[]) => host.showInformationMessage(...a),
      showWarningMessage: (...a: unknown[]) => host.showWarningMessage(...a),
      showErrorMessage: vi.fn(),
      showInputBox: (...a: unknown[]) => host.showInputBox(...a),
    },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    commands: { executeCommand: (...a: unknown[]) => host.executeCommand(...a) },
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
vi.mock('../../../../src/engine/db/connectionCommands', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAddConnectionFlow: (...a: unknown[]) => host.runAddConnectionFlow(...a),
}));

const { connectDatabase } = await import('../../../../src/engine/connectionManager');
const { DbConnectionError } = await import('../../../../src/engine/db/dbSession');

const outputChannel = { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as never;
const env = { secrets: {} as never, outputChannel, loadQueries: async () => [] };
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

beforeEach(() => {
  host.settings = {};
  for (const fn of [host.showQuickPick, host.showInputBox, host.showInformationMessage, host.showWarningMessage, host.openBuiltInSession, host.runAddConnectionFlow, host.executeCommand]) fn.mockClear();
  host.openBuiltInSession.mockImplementation(async (conn: Record<string, any>) => fakeBuiltInSession(conn));
});

describe('connectDatabase — builtIn', () => {
  beforeEach(() => {
    host.settings['dataLineageViz.database.connections'] = [local, cloud];
  });

  it('offers the saved connections plus an add item, and opens the chosen one', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string; connection?: unknown }>) => items.find((i) => i.label === 'Cloud'));

    const session = await connectDatabase(env);

    const items = host.showQuickPick.mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((i) => i.label)).toEqual(['Local', 'Cloud', '$(add) Add Connection…', 'Manage', '$(edit) Edit Connection…', '$(key) Update Password…', '$(trash) Remove Connection…']);
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

  it('a manage item runs its command, then shows the picker again', async () => {
    host.showQuickPick
      .mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Update Password')))
      .mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Local'));

    const session = await connectDatabase(env);

    expect(host.executeCommand).toHaveBeenCalledWith('dataLineageViz.updateDatabasePassword');
    expect(host.showQuickPick).toHaveBeenCalledTimes(2);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, expect.anything());
    expect(session?.provider).toBe('builtIn');
  });

  it('returns undefined when the picker is dismissed', async () => {
    host.showQuickPick.mockResolvedValue(undefined);
    await expect(connectDatabase(env)).resolves.toBeUndefined();
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
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

  it('several saved connections for the same login: the one with the project database wins, by server, user and sign-in type', async () => {
    const sales = { ...local, id: 'id-sales', name: 'Sales', database: 'Sales' };
    host.settings['dataLineageViz.database.connections'] = [local, sales];

    await connectDatabase(env, { server: 'localhost', database: 'Sales', user: 'sa', authenticationType: 'sqlLogin', provider: 'builtIn' });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-sales' }), env, { database: 'Sales' });
  });

  it('several saved connections for the same login and none with the project database: the first match opens the project database', async () => {
    const other = { ...local, id: 'id-other', name: 'Other', database: 'Other' };
    host.settings['dataLineageViz.database.connections'] = [local, other];

    await connectDatabase(env, { server: 'localhost', database: 'Archive', user: 'sa', authenticationType: 'sqlLogin', provider: 'builtIn' });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, { database: 'Archive' });
  });

  it('a stored host,port server string matches a saved connection that stores the port separately', async () => {
    const docker = { ...local, id: 'id-docker', server: 'localhost', port: 14333 };
    host.settings['dataLineageViz.database.connections'] = [docker];

    await connectDatabase(env, { server: 'localhost,14333', database: 'AdventureWorks', user: 'sa', authenticationType: 'sqlLogin', provider: 'builtIn' });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-docker' }), env, { database: 'AdventureWorks' });
  });

  it('the sign-in type must match: a stored Entra record maps to the Entra connection on the same server', async () => {
    const entraLocal = { id: 'id-entra', name: 'Entra', server: 'localhost', authenticationType: 'entraId' };
    host.settings['dataLineageViz.database.connections'] = [local, entraLocal];

    await connectDatabase(env, { server: 'localhost', database: 'AdventureWorks', authenticationType: 'entraId', provider: 'builtIn' });

    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-entra' }), env, { database: 'AdventureWorks' });
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
      server: 'sql.example.com', port: 14333, database: 'Sales', user: 'reader', authenticationType: 'sqlLogin', provider: 'builtIn',
    });

    expect(host.runAddConnectionFlow).toHaveBeenCalledWith(env, undefined, {
      server: 'sql.example.com', port: 14333, database: 'Sales', user: 'reader',
    });
  });
});

describe('connectDatabase — builtIn failures', () => {
  beforeEach(() => {
    host.settings['dataLineageViz.database.connections'] = [local];
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

describe('connectDatabase — builtIn database choice', () => {
  const noDatabase = { id: 'id-nodb', name: 'NoDb', server: 'x.database.windows.net', authenticationType: 'entraId' };

  beforeEach(() => {
    host.settings['dataLineageViz.database.connections'] = [noDatabase];
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items[0]);
  });

  it('the database name is typed and the only connection opened is the one to that database', async () => {
    host.showInputBox.mockResolvedValue(' SalesDb ');

    const session = await connectDatabase(env);

    expect(host.showInputBox).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-nodb' }), env, { database: 'SalesDb', token: undefined });
    expect(session?.provider).toBe('builtIn');
  });

  it('a database that cannot be opened surfaces as DbConnectionError naming the typed database', async () => {
    host.showInputBox.mockResolvedValue('Missing');
    host.openBuiltInSession.mockRejectedValueOnce(Object.assign(new Error('Cannot open database "Missing" requested by the login.'), { number: 4060 }));

    const err = await connectDatabase(env).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DbConnectionError);
    expect((err as InstanceType<typeof DbConnectionError>).target).toMatchObject({ name: 'NoDb', connectionId: 'id-nodb', database: 'Missing' });
  });

  it('an empty or dismissed database name cancels the connection without opening one', async () => {
    host.showInputBox.mockResolvedValueOnce('  ').mockResolvedValueOnce(undefined);
    await expect(connectDatabase(env)).resolves.toBeUndefined();
    await expect(connectDatabase(env)).resolves.toBeUndefined();
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
  });
});
