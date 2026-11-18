/**
 * Pins how a project saved with the retired SQL Server (mssql) extension connection reopens: one
 * notice says Microsoft deprecated that API, its action opens Add Database Connection prefilled with
 * the stored server and database, the project keeps its schemas, and nothing converts the record to a
 * built-in connection before the user has reconnected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../../src/bridge/host';
import type { ProjectStore } from '../../../../src/engine/projectStore';
import { migrateProjectStore } from '../../../../src/engine/projectStore';
import { ColumnStore } from '../../../../src/engine/columnStore';

const NOTICE = 'Microsoft deprecated the mssql extension connection API. Reconnect to keep using this project.';

const host = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  openBuiltInSession: vi.fn(),
  runAddConnectionFlow: vi.fn(),
  filteredSchemas: [] as string[][],
  connections: [] as unknown[],
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: unknown[]) => parts.join('/') },
    FileSystemError: class FileSystemError extends Error {},
    ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    window: {
      showWarningMessage: (...a: unknown[]) => host.showWarningMessage(...a),
      showInformationMessage: (...a: unknown[]) => host.showInformationMessage(...a),
      showErrorMessage: (...a: unknown[]) => host.showErrorMessage(...a),
      showQuickPick: (...a: unknown[]) => host.showQuickPick(...a),
      showInputBox: (...a: unknown[]) => host.showInputBox(...a),
    },
    commands: { executeCommand: (...a: unknown[]) => host.executeCommand(...a) },
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback?: unknown) => (key === 'connections' ? host.connections : fallback), inspect: () => ({}) }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
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
vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadDmvQueries: async () => [{ name: 'schema-preview', sql: 'SELECT schema_preview', phase: 1 }],
  executeDmvQueries: async () => new Map([['schema-preview', {
    rowCount: 1,
    columnInfo: ['schema_name', 'type_code', 'object_count'].map((columnName) => ({ columnName })),
    rows: [['dbo', 'U', '1'].map((displayValue) => ({ displayValue, isNull: false }))],
  }]]),
  executeDmvQueriesFiltered: async (_session: unknown, _queries: unknown, schemas: string[]) => {
    host.filteredSchemas.push(schemas);
    const result = (names: string[], rows: Array<Array<{ displayValue: string; isNull: boolean }>>) => ({
      rowCount: rows.length, columnInfo: names.map((columnName) => ({ columnName })), rows,
    });
    const cell = (displayValue: string) => ({ displayValue, isNull: false });
    return new Map([
      ['nodes', result(['schema_name', 'object_name', 'type_code', 'body_script'], [[cell('dbo'), cell('T0'), cell('U '), { displayValue: 'NULL', isNull: true }]])],
      ['columns', result(['schema_name', 'table_name', 'column_name'], [])],
      ['dependencies', result(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], [])],
    ]);
  },
}));

const { connectDatabase } = await import('../../../../src/engine/connectionManager');
const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');

const outputChannel = { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as never;
const env = { secrets: {} as never, outputChannel, loadQueries: async () => [] };

/** What a project saved on MAIN with the mssql extension holds: no `provider` or an explicit `mssqlExtension`. */
const LEGACY = { server: 'sql.example.com', port: 1433, database: 'Sales', user: 'reader', authenticationType: 'SqlLogin' } as const;
const LEGACY_FORMS = [
  { name: 'explicit mssqlExtension provider', stored: { ...LEGACY, provider: 'mssqlExtension' as const } },
  { name: 'no provider (written before provider selection existed)', stored: { ...LEGACY } },
];

function builtInSession(connection: Record<string, any>, database: string) {
  return {
    provider: 'builtIn' as const,
    connectionInfo: { server: connection.server, database, provider: 'builtIn', connectionId: connection.id },
    executeSimpleQuery: vi.fn(), getServerInfo: vi.fn(async () => ({ engineEditionId: 3 })), dispose: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  for (const fn of [host.showWarningMessage, host.showInformationMessage, host.showQuickPick, host.showInputBox, host.openBuiltInSession, host.runAddConnectionFlow, host.showErrorMessage, host.executeCommand]) fn.mockReset();
  host.filteredSchemas = [];
  host.connections = [];
  host.openBuiltInSession.mockImplementation(async (connection: Record<string, any>, _env: unknown, options: { database: string }) => builtInSession(connection, options.database));
});

describe.each(LEGACY_FORMS)('connectDatabase with a project saved with the mssql extension — $name', ({ stored }) => {
  it('shows exactly one notice with the deprecation text and connects nothing before the user acts', async () => {
    host.showWarningMessage.mockResolvedValue(undefined);

    const session = await connectDatabase(env, stored);

    expect(session).toBeUndefined();
    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.showWarningMessage.mock.calls[0][0]).toBe(NOTICE);
    expect(host.showInformationMessage).not.toHaveBeenCalled();
    expect(host.runAddConnectionFlow).not.toHaveBeenCalled();
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
  });

  it('opens Add Database Connection prefilled with the stored server and database, then connects the saved connection', async () => {
    const added = { id: 'id-new', name: 'Sales', server: 'sql.example.com', port: 1433, database: 'Sales', authenticationType: 'sqlLogin', user: 'reader' };
    host.showWarningMessage.mockImplementation(async (_text: string, ...actions: unknown[]) => actions.find((a) => typeof a === 'string'));
    host.runAddConnectionFlow.mockResolvedValue(added);

    const session = await connectDatabase(env, stored);

    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.runAddConnectionFlow).toHaveBeenCalledTimes(1);
    expect(host.runAddConnectionFlow.mock.calls[0][2]).toEqual({ server: 'sql.example.com', port: 1433, user: 'reader', database: 'Sales' });
    expect(host.openBuiltInSession).toHaveBeenCalledWith(added, env, expect.objectContaining({ database: 'Sales' }));
    expect(session?.provider).toBe('builtIn');
  });

  it('does not convert silently to a saved built-in connection for the same server', async () => {
    host.showWarningMessage.mockResolvedValue(undefined);
    host.connections = [{ id: 'id-existing', name: 'Existing', server: 'sql.example.com', port: 1433, authenticationType: 'sqlLogin', user: 'reader' }];

    const session = await connectDatabase(env, stored);

    expect(session).toBeUndefined();
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });
});

function fakeHost(): BridgeHost {
  return {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getConfiguration: vi.fn().mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback }),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
    readFile: vi.fn(),
    withProgress: vi.fn((_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })),
    getExtensionUri: vi.fn().mockReturnValue('ext'),
    getGlobalState: vi.fn(),
    getWorkspaceState: vi.fn(),
  } as unknown as BridgeHost;
}

type SavedStore = { projects: Array<{ connection: { schemas: string[]; connectionInfo: Record<string, unknown> } }> };

/** A panel over a project store that keeps what `load-project` saves, so a second load reads it. */
function projectPanel(stored: unknown) {
  const saved: SavedStore[] = [];
  let store = migrateProjectStore({ schemaVersion: 1, projects: [stored] }) as ProjectStore;
  const session = { model: null, uiState: {}, renderState: null, isDbSession: false, columnStore: new ColumnStore(), clearDiscoveryTranscript: vi.fn() };
  const { handlers } = createMessageHandlers(
    fakeHost(),
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => session as never,
    outputChannel,
    () => store,
    async (_context: unknown, saving: ProjectStore) => { store = saving; saved.push(saving as unknown as SavedStore); },
    vi.fn(),
    false,
    vi.fn(),
  );
  return { saved, load: () => handlers['load-project']({ type: 'load-project', id: 'p1' } as never) };
}

describe('a project record saved with the mssql extension', () => {
  const record = {
    id: 'p1', name: 'Sales', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    connection: {
      type: 'database', displayName: 'Sales', sourceName: 'sql.example.com / Sales', schemas: ['dbo', 'sales'],
      connectionInfo: { ...LEGACY, provider: 'mssqlExtension' },
    },
  };

  it('loads with its stored server, database and schemas, still marked mssqlExtension', () => {
    const dropped = vi.fn();
    const store = migrateProjectStore({ schemaVersion: 1, projects: [record] }, dropped);

    expect(dropped).not.toHaveBeenCalled();
    expect(store.projects).toHaveLength(1);
    expect(store.projects[0].connection).toMatchObject({
      type: 'database', schemas: ['dbo', 'sales'],
      connectionInfo: { server: 'sql.example.com', database: 'Sales', provider: 'mssqlExtension' },
    });
  });

  async function open() {
    const panel = projectPanel(record);
    await panel.load();
    return panel.saved;
  }

  it('dismissed notice: nothing loads and the stored project is left unchanged', async () => {
    host.showWarningMessage.mockResolvedValue(undefined);

    const saved = await open();

    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).not.toHaveBeenCalled();
    expect(host.filteredSchemas).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('after the reconnect the project loads its own schemas and stores the reconnected connection', async () => {
    host.showWarningMessage.mockImplementation(async (_text: string, ...actions: unknown[]) => actions.find((a) => typeof a === 'string'));
    host.runAddConnectionFlow.mockResolvedValue({ id: 'id-new', name: 'Sales', server: 'sql.example.com', port: 1433, authenticationType: 'sqlLogin', user: 'reader' });

    const saved = await open();

    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.filteredSchemas).toEqual([['dbo', 'sales']]);
    const project = saved.at(-1)!.projects[0];
    expect(project.connection.schemas).toEqual(['dbo', 'sales']);
    expect(project.connection.connectionInfo).toMatchObject({ server: 'sql.example.com', database: 'Sales', provider: 'builtIn', connectionId: 'id-new' });
  });

  it('a failed connect after the reconnect retries the reconnected connection and never shows the notice or the wizard again', async () => {
    const added = { id: 'id-new', name: 'Sales', server: 'sql.example.com', port: 1433, authenticationType: 'sqlLogin', user: 'reader' };
    host.showWarningMessage.mockImplementation(async (_text: string, ...actions: unknown[]) => actions.find((a) => typeof a === 'string'));
    host.runAddConnectionFlow.mockImplementation(async () => { host.connections = [added]; return added; });
    host.openBuiltInSession.mockRejectedValueOnce(Object.assign(new Error("Login failed for user 'reader'."), { number: 18456 }));
    host.showErrorMessage.mockImplementation(async (_message: string, ...labels: string[]) => labels[0]);
    host.executeCommand.mockImplementation(async (command: string) => command === 'dataLineageViz.updateDatabasePassword');

    await open();
    await vi.waitFor(() => expect(host.filteredSchemas).toEqual([['dbo', 'sales']]));

    expect(host.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledTimes(2);
    expect(host.openBuiltInSession.mock.calls[1][0]).toMatchObject({ id: 'id-new' });
    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.runAddConnectionFlow).toHaveBeenCalledTimes(1);
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });
});

describe.each(LEGACY_FORMS)('a legacy project saved without schemas — $name', ({ stored }) => {
  const noSchemas = {
    id: 'p1', name: 'Sales', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    connection: { type: 'database', displayName: 'Sales', sourceName: 'sql.example.com / Sales', schemas: [], connectionInfo: stored },
  };
  const added = { id: 'id-new', name: 'Sales', server: 'sql.example.com', port: 1433, authenticationType: 'sqlLogin', user: 'reader' };

  it('stores the reconnected connection, so the next open shows no notice and asks for no second connection', async () => {
    host.showWarningMessage.mockImplementation(async (_text: string, ...actions: unknown[]) => actions.find((a) => typeof a === 'string'));
    host.runAddConnectionFlow.mockImplementation(async () => { host.connections = [added]; return added; });
    const { saved, load } = projectPanel(noSchemas);

    await load();

    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)?.projects[0].connection).toMatchObject({
      schemas: [], connectionInfo: { server: 'sql.example.com', database: 'Sales', provider: 'builtIn', connectionId: 'id-new' },
    });

    await load();

    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.runAddConnectionFlow).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledTimes(2);
  });
});

describe('a built-in project saved without schemas', () => {
  it('opens without being saved again, so the recent-projects order does not change', async () => {
    host.connections = [{ id: 'id-local', name: 'Local', server: 'sql.example.com', port: 1433, authenticationType: 'sqlLogin', user: 'reader' }];
    const panel = projectPanel({
      id: 'p1', name: 'Sales', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      connection: {
        type: 'database', displayName: 'Sales', sourceName: 'sql.example.com / Sales', schemas: [],
        connectionInfo: { server: 'sql.example.com', database: 'Sales', provider: 'builtIn', connectionId: 'id-local' },
      },
    });

    await panel.load();

    expect(host.openBuiltInSession).toHaveBeenCalledTimes(1);
    expect(host.showWarningMessage).not.toHaveBeenCalled();
    expect(panel.saved).toEqual([]);
  });
});
