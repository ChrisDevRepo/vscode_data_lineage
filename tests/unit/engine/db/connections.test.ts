import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  bridgeConnect: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
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
    ProgressLocation: { Notification: 15 },
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

vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return { ...actual, connectDatabase: (...args: unknown[]) =>
    host.bridgeConnect ? host.bridgeConnect(...args) : actual.connectDatabase(...args) };
});

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
    connectionInfo: { server: conn.server, database: conn.database ?? '', connectionId: conn.id },
    executeSimpleQuery: vi.fn(), getServerInfo: vi.fn(), dispose: vi.fn(),
  };
}

beforeEach(() => {
  host.settings = {};
  host.bridgeConnect = undefined;
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
    expect(session?.connectionInfo.connectionId).toBe('id-cloud');
  });

  it('the add item runs the add flow and connects the new connection', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Add Connection')));
    host.runAddConnectionFlow.mockResolvedValue({ ...local, id: 'id-new', name: 'New' });

    const session = await connectDatabase(env);

    expect(host.runAddConnectionFlow).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-new' }), env, expect.anything());
    expect(session?.connectionInfo.connectionId).toBe('id-new');
  });

  it('a manage item runs its command, then shows the picker again', async () => {
    host.showQuickPick
      .mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Update Password')))
      .mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Local'));

    const session = await connectDatabase(env);

    expect(host.executeCommand).toHaveBeenCalledWith('dataLineageViz.updateDatabasePassword');
    expect(host.showQuickPick).toHaveBeenCalledTimes(2);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, expect.anything());
    expect(session?.connectionInfo.connectionId).toBe('id-local');
  });

  it('returns undefined when the picker is dismissed', async () => {
    host.showQuickPick.mockResolvedValue(undefined);
    await expect(connectDatabase(env)).resolves.toBeUndefined();
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
  });

  it('reconnects a stored built-in project by connectionId without a picker', async () => {
    const session = await connectDatabase(env, {
      server: 'localhost', database: 'Sales', connectionId: 'id-local',
    });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-local' }), env, expect.objectContaining({ database: 'Sales' }),
    );
    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(session?.connectionInfo.connectionId).toBe('id-local');
  });

  it('a legacy record matches a saved connection without a provider notice', async () => {
    const session = await connectDatabase(env, {
      server: 'LOCALHOST', database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin',
    });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, expect.anything());
    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(session?.connectionInfo.connectionId).toBe('id-local');
  });

  it('several saved connections for the same login: the one with the project database wins', async () => {
    const sales = { ...local, id: 'id-sales', name: 'Sales', database: 'Sales' };
    host.settings['dataLineageViz.database.connections'] = [local, sales];

    await connectDatabase(env, { server: 'localhost', database: 'Sales', user: 'sa', authenticationType: 'SqlLogin' });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-sales' }), env, { database: 'Sales' });
  });

  it('several saved connections for the same login and none with the project database: the first match opens the project database', async () => {
    const other = { ...local, id: 'id-other', name: 'Other', database: 'Other' };
    host.settings['dataLineageViz.database.connections'] = [local, other];

    await connectDatabase(env, { server: 'localhost', database: 'Archive', user: 'sa', authenticationType: 'SqlLogin' });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, { database: 'Archive' });
  });

  it('an mssql server string with a port matches a saved connection that stores the port separately', async () => {
    const docker = { ...local, id: 'id-docker', server: 'localhost', port: 14333 };
    host.settings['dataLineageViz.database.connections'] = [docker];

    await connectDatabase(env, { server: 'localhost,14333', database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin' });

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-docker' }), env, { database: 'AdventureWorks' });
  });

  it.each([
    { server: 'localhost', storedPort: undefined, wrongPort: 1444, correctPort: undefined },
    { server: 'localhost', storedPort: 1444, wrongPort: undefined, correctPort: 1444 },
    { server: 'localhost\\reporting', storedPort: undefined, wrongPort: 1433, correctPort: undefined },
  ])('never treats an unspecified port as a wildcard: %j', async ({ server, storedPort, wrongPort, correctPort }) => {
    host.settings['dataLineageViz.database.connections'] = [
      { ...local, id: 'wrong', server, port: wrongPort },
      { ...local, id: 'correct', server, port: correctPort },
    ];
    await connectDatabase(env, { server, port: storedPort, database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin' });
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'correct' }), env, expect.anything());
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });

  it.each([[undefined, 1433], [1433, undefined]])('matches an omitted default port to1433 (stored %s, saved %s)', async (storedPort, savedPort) => {
    host.settings['dataLineageViz.database.connections'] = [{ ...local, port: savedPort }];
    await connectDatabase(env, { server: 'localhost', port: storedPort, database: 'AdventureWorks', user: 'sa', authenticationType: 'SqlLogin' });
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: local.id }), env, expect.anything());
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });

  it('the sign-in type must match: an mssql Entra record maps to the Entra connection on the same server', async () => {
    const entraLocal = { id: 'id-entra', name: 'Entra', server: 'localhost', authenticationType: 'entraId' };
    host.settings['dataLineageViz.database.connections'] = [local, entraLocal];

    await connectDatabase(env, { server: 'localhost', database: 'AdventureWorks', authenticationType: 'AzureMFA', email: 'a@b.c' });

    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-entra' }), env, { database: 'AdventureWorks' });
  });

  it('falls back to the picker when no saved connection matches the stored record', async () => {
    host.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items[0]);
    await connectDatabase(env, { server: 'unknown-host', database: 'db', connectionId: 'gone' });
    expect(host.showQuickPick).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-local' }), env, expect.anything());
  });

  it('unmatched saved projects open the connection picker', async () => {
    host.showQuickPick.mockResolvedValue(undefined);

    await connectDatabase(env, { server: 'sql.example.com', database: 'Sales', user: 'reader', authenticationType: 'SqlLogin' });
    await connectDatabase(env, { server: 'unknown-host', database: 'db', connectionId: 'gone' });
    await connectDatabase(env);

    expect(host.showQuickPick.mock.calls.map((call) => call[1].placeHolder)).toEqual([
      'Select a database connection',
      'Select a database connection',
      'Select a database connection',
    ]);
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
    host.settings['dataLineageViz.database.connections'] = [local];
  });

  it('wraps an open failure in DbConnectionError with the connection name and the unchanged text', async () => {
    const original = Object.assign(new Error("Login failed for user 'sa'."), { number: 18456 });
    host.openBuiltInSession.mockRejectedValueOnce(original);
    const err = await connectDatabase(env, { server: 'localhost', database: 'AdventureWorks', connectionId: 'id-local' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbConnectionError);
    expect((err as Error).message).toBe("Login failed for user 'sa'.");
    expect((err as InstanceType<typeof DbConnectionError>).original).toBe(original);
    expect((err as InstanceType<typeof DbConnectionError>).target).toMatchObject({ name: 'Local', connectionId: 'id-local' });
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
    expect(session?.connectionInfo.connectionId).toBe('id-nodb');
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

describe('migration from the mssql extension to the built-in connection', () => {
  it('a project saved through mssql reopens once through a pre-filled new connection, then silently', async () => {
    host.settings['dataLineageViz.database.connections'] = [];
    const savedByMssql = { server: 'localhost,14333', database: 'AdventureWorks2022', user: 'dlv_reader', authenticationType: 'SqlLogin' };
    const added = { id: 'id-added', name: 'Local', server: 'localhost', port: 14333, database: 'AdventureWorks2022', authenticationType: 'sqlLogin', user: 'dlv_reader' };
    host.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Add Connection')));
    host.runAddConnectionFlow.mockImplementationOnce(async () => {
      host.settings['dataLineageViz.database.connections'] = [added];
      return added;
    });

    const first = await connectDatabase(env, savedByMssql);

    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(host.runAddConnectionFlow).toHaveBeenCalledWith(env, undefined, {
      server: 'localhost,14333', port: undefined, user: 'dlv_reader', database: 'AdventureWorks2022',
    });
    expect(first?.connectionInfo).toMatchObject({ connectionId: 'id-added', database: 'AdventureWorks2022' });

    host.showInformationMessage.mockClear();
    host.showQuickPick.mockClear();
    const second = await connectDatabase(env, first!.connectionInfo);

    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(second?.connectionInfo).toMatchObject({ connectionId: 'id-added' });
  });
});


// Preserve supported bridge error contracts previously mixed with provider-switch tests.
const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');
const { createBridgeHost } = await import('../../../../src/bridge/host');

function bridgeErrors() {
  const lines: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), trace: vi.fn(), appendLine: vi.fn(),
    error: (message: string) => { lines.push(message); } };
  const realHost = createBridgeHost({ webview: { postMessage: (message: Record<string, unknown>) => {
    posted.push(message); return Promise.resolve(true);
  } } } as never, {} as never, channel as never);
  const bundle = createMessageHandlers(
    { ...realHost, withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => Promise<void>) =>
      task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }) } as never,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => ({ model: null, uiState: {}, renderState: null }) as never,
    channel as never,
    () => ({ schemaVersion: 1, projects: [] }) as never,
    vi.fn().mockResolvedValue(undefined), vi.fn(), false, vi.fn(),
  );
  return { lines, posted, channel, host: realHost, handlers: bundle.handlers };
}

describe('supported bridge connection failures and logging', () => {
  it('redacts secrets in the log and in the message posted to the webview', async () => {
    host.bridgeConnect = vi.fn().mockRejectedValue(new Error('Bad connection string Password=abc123;Server=x'));
    const { handlers, posted, lines } = bridgeErrors();
    await handlers['db-connect']({ type: 'db-connect' });
    const error = posted.find((message) => message.type === 'db-error');
    expect(String(error?.message)).not.toContain('abc123');
    expect(String(error?.message)).toContain('Password=[removed]');
    expect(lines.join('\n')).not.toContain('abc123');
  });

  it('writes one FAILED line naming the operation and the redacted message through the real host logger', async () => {
    host.bridgeConnect = vi.fn().mockRejectedValue(new Error('Missing schema-preview query Password=abc123;'));
    const { handlers, lines } = bridgeErrors();
    await handlers['db-connect']({ type: 'db-connect' });
    expect(lines.filter(line => line.includes('FAILED:'))).toEqual(['[DB] FAILED: Connecting — Missing schema-preview query Password=[removed];']);
    expect(lines.join('\n')).not.toContain('abc123');
    expect(lines.join('\n')).not.toContain('undefined');
    expect(lines, 'no stack of the logging site: the redacted text is the whole record').toHaveLength(1);
  });

  it('redacts a connection string in the message and in the stack of a caught Error', () => {
    const { lines, host: realHost } = bridgeErrors();
    const err = new Error('Login failed Server=x;Password=abc123;Database=d');
    err.stack = 'Error: Login failed Server=x;Password=abc123;\n    at connect (driver.js:1:1)\n    at auth Bearer abcdefgh12345678';
    realHost.log('error', 'Bridge', 'Load project', err);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[Bridge] FAILED: Load project — Login failed Server=x;Password=[removed];Database=d');
    expect(lines[1]).toMatch(/^\[Bridge\] Stack: Error: Login failed Server=x;Password=\[removed\];/);
    expect(lines[1]).toContain('Bearer [token removed]');
    expect(lines.join('\n')).not.toMatch(/abc123|abcdefgh12345678/);
  });

  it('redacts a thrown string, which carries no stack', () => {
    const { lines, host: realHost } = bridgeErrors();
    realHost.log('error', 'Dacpac', 'Dacpac visualize', 'rejected pwd=abc123 Bearer abcdefgh12345678');
    expect(lines).toEqual(['[Dacpac] FAILED: Dacpac visualize — rejected pwd=[removed] Bearer [token removed]']);
  });

  it('redacts the operation text', () => {
    const { lines, host: realHost } = bridgeErrors();
    realHost.log('error', 'Bridge', 'Load project Password=abc123', 'boom');
    expect(lines).toEqual(['[Bridge] FAILED: Load project Password=[removed] — boom']);
  });

  it.each(['warn', 'info', 'debug'] as const)('redacts a caught driver message carried in %s-level text', (level) => {
    const { host: realHost, channel } = bridgeErrors();
    realHost.log(level, 'DB', 'Disconnect failed: Login failed Server=x;Password=abc123; Bearer abcdefgh12345678');
    expect(channel[level]).toHaveBeenCalledTimes(1);
    expect(channel[level]).toHaveBeenCalledWith('[DB] Disconnect failed: Login failed Server=x;Password=[removed]; Bearer [token removed]');
  });

  it.each([
    ['load-project', { type: 'load-project', id: 'missing' }, 'FAILED: Load project — Project not found: missing'],
    ['dacpac-visualize', { type: 'dacpac-visualize', schemas: ['dbo'] }, 'FAILED: Dacpac visualize — Session expired (no cached dacpac preview)'],
    ['db-visualize', { type: 'db-visualize', schemas: ['dbo'] }, 'FAILED: Database visualize — No stored connection info'],
  ])('%s logs its synthetic failure as message text with no stack of the logging site', async (key, message, expected) => {
    const { lines, handlers } = bridgeErrors();
    await (handlers as Record<string, (message: unknown) => Promise<void>>)[key as string](message);
    expect(lines).toEqual([expect.stringContaining(expected)]);
    expect(lines.join('\n')).not.toContain('Stack:');
  });
});
