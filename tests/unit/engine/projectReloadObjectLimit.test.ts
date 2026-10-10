/**
 * Pins that reopening a saved project whose source grew past `dataLineageViz.maxNodes` loads nothing
 * and reports the one object-limit message — for a DACPAC project and for a database project alike.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';
import type { ProjectStore } from '../../../src/engine/projectStore';
import type { DbCellValue, SimpleExecuteResult } from '../../../src/types/mssql';
import { ColumnStore } from '../../../src/engine/columnStore';
import { formatObjectLimitMessage } from '../../../src/engine/modelFilters';
import { buildSyntheticDacpac } from '../helpers/syntheticDacpac';

const db = vi.hoisted(() => ({ tableCount: 0, gate: undefined as Promise<void> | undefined, started: undefined as (() => void) | undefined }));

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: unknown[]) => parts.join('/') },
  FileSystemError: class FileSystemError extends Error {},
  window: { withProgress: (_o: unknown, task: (p: unknown, t: unknown) => unknown) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }) },
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn(async () => undefined) },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
}));

vi.mock('../../../src/engine/connectionManager', async (importOriginal) => {
  const cell = (displayValue: string): DbCellValue => ({ displayValue, isNull: false });
  const result = (names: string[], rows: DbCellValue[][]): SimpleExecuteResult => ({
    rowCount: rows.length, columnInfo: names.map((columnName) => ({ columnName }) as never), rows,
  });
  return {
    ...await importOriginal<Record<string, unknown>>(),
    connectDatabase: async () => ({
      provider: 'builtIn',
      connectionInfo: { server: 'localhost', database: 'Sales', provider: 'builtIn' },
      getServerInfo: async () => ({ engineEditionId: 3 }),
      executeSimpleQuery: async () => { throw new Error('not scripted'); },
      dispose: async () => undefined,
    }),
    loadDmvQueries: async () => [],
    executeDmvQueries: async () => new Map(),
    executeDmvQueriesFiltered: async () => {
      db.started?.();
      await db.gate;
      return new Map([
        ['nodes', result(['schema_name', 'object_name', 'type_code', 'body_script'],
          Array.from({ length: db.tableCount }, (_, i) => [cell('dbo'), cell(`T${i}`), cell('U '), { displayValue: 'NULL', isNull: true }]))],
        ['columns', result(['schema_name', 'table_name', 'column_name'], [])],
        ['dependencies', result(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], [])],
      ]);
    },
  };
});

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');

function fakeHost(maxNodes: number, bytes?: Uint8Array): BridgeHost {
  return {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getConfiguration: vi.fn().mockReturnValue({ get: (key: string, fallback?: unknown) => (key === 'maxNodes' ? maxNodes : fallback) }),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
    openExternal: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    readFile: vi.fn().mockResolvedValue(bytes),
    writeFile: vi.fn(),
    withProgress: vi.fn((_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })),
    getExtensionUri: vi.fn().mockReturnValue('ext'),
    getGlobalState: vi.fn(),
  } as unknown as BridgeHost;
}

function arrange(host: BridgeHost, connection: Record<string, unknown>) {
  let store = {
    schemaVersion: 1,
    projects: [{ id: 'p1', name: 'Sales', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', connection }],
  } as unknown as ProjectStore;
  const session = { model: null, uiState: {}, renderState: null, isDbSession: false, columnStore: new ColumnStore(), clearDiscoveryTranscript: vi.fn(), clearExternalViews: vi.fn() };
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => session as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), appendLine: vi.fn() } as never,
    () => store,
    vi.fn(async (_context, updated: ProjectStore) => { store = updated; }),
    vi.fn(),
    false,
    vi.fn(),
  );
  return { handlers, readStore: () => store };
}

async function reload(host: BridgeHost, connection: Record<string, unknown>): Promise<Array<{ type: string; message?: string }>> {
  const { handlers } = arrange(host, connection);
  await handlers['load-project']({ type: 'load-project', id: 'p1' });
  return vi.mocked(host.postMessage).mock.calls.map(([m]) => m as { type: string; message?: string });
}

describe('reopening a saved project over dataLineageViz.maxNodes', () => {
  it('a DACPAC project that grew past the limit loads no model and reports the limit', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 30, schemaCount: 2 });
    const schemas = Object.keys(gt.perSchemaObjectCount);
    const posted = await reload(fakeHost(20, gt.buffer), { type: 'dacpac', path: '/tmp/sales.dacpac', displayName: 'Sales', schemas });

    expect(posted.some((m) => m.type === 'dacpac-model')).toBe(false);
    expect(posted.filter((m) => m.type === 'db-error').map((m) => m.message)).toEqual([formatObjectLimitMessage(gt.totalNodeCount, 20)]);
  });

  it('a DACPAC project within the limit loads', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 30, schemaCount: 2 });
    const schemas = Object.keys(gt.perSchemaObjectCount);
    const posted = await reload(fakeHost(1000, gt.buffer), { type: 'dacpac', path: '/tmp/sales.dacpac', displayName: 'Sales', schemas });

    expect(posted.some((m) => m.type === 'dacpac-model')).toBe(true);
    expect(posted.some((m) => m.type === 'db-error')).toBe(false);
  });

  const dbProject = {
    type: 'database', displayName: 'Sales', sourceName: 'Sales', schemas: ['dbo'],
    connectionInfo: { server: 'localhost', database: 'Sales', provider: 'builtIn' },
  };

  it('a database project that grew past the limit loads no model and reports the limit', async () => {
    db.tableCount = 30;
    const posted = await reload(fakeHost(20), dbProject);

    expect(posted.some((m) => m.type === 'db-model')).toBe(false);
    expect(posted.filter((m) => m.type === 'db-error').map((m) => m.message)).toEqual([formatObjectLimitMessage(30, 20)]);
  });

  it('a database project within the limit loads', async () => {
    db.tableCount = 30;
    const posted = await reload(fakeHost(1000), dbProject);

    expect(posted.some((m) => m.type === 'db-model')).toBe(true);
    expect(posted.some((m) => m.type === 'db-error')).toBe(false);
  });
});

describe('refreshing a project against current saved data', () => {
  afterEach(() => { db.gate = undefined; db.started = undefined; });

  it.each(['dacpac', 'database'] as const)('%s refresh preserves a concurrent project and edits to the current project', async (type) => {
    const gt = await buildSyntheticDacpac({ objectCount: 5, schemaCount: 1 });
    const connection = type === 'dacpac'
      ? { type, path: '/tmp/sales.dacpac', displayName: 'Sales', schemas: Object.keys(gt.perSchemaObjectCount) }
      : { type, displayName: 'Sales', sourceName: 'Sales', schemas: ['dbo'], connectionInfo: { server: 'localhost', database: 'Sales', provider: 'builtIn' } };
    const host = fakeHost(1000, gt.buffer);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    if (type === 'dacpac') vi.mocked(host.readFile).mockImplementation(async () => { markStarted(); await gate; return gt.buffer; });
    else { db.tableCount = 5; db.gate = gate; db.started = markStarted; }
    const { handlers, readStore } = arrange(host, connection);
    const loading = handlers['load-project']({ type: 'load-project', id: 'p1' });
    await started;
    const savedView = { id: 'v1', name: 'Saved while loading', createdAt: '2026-01-01', filter: { schemas: ['dbo'], types: ['table'], hideIsolated: false, focusSchemas: [], showExternalRefs: false, externalRefTypes: [], allowlistNodeIds: [] } };
    const savedProject = { ...readStore().projects[0], name: 'Renamed while loading', filterProfiles: [savedView], connection: { ...readStore().projects[0].connection, displayName: 'Updated source label' } };
    await handlers['save-project']({ type: 'save-project', project: savedProject } as never);
    const otherProject = { ...savedProject, id: 'p2', name: 'Saved while loading' };
    await handlers['save-project']({ type: 'save-project', project: otherProject } as never);
    resume();
    await loading;

    expect(readStore().projects.map(project => project.id)).toEqual(['p1', 'p2']);
    expect(readStore().projects[0]).toMatchObject({ name: savedProject.name, connection: { displayName: 'Updated source label' }, filterProfiles: [savedView] });
    expect(vi.mocked(host.postMessage).mock.calls.some(([message]) => message.type === `${type === 'database' ? 'db' : 'dacpac'}-model`)).toBe(true);
  });

  it('does not recreate a project deleted while its DACPAC is loading', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 5, schemaCount: 1 });
    const host = fakeHost(1000, gt.buffer);
    let resume!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    vi.mocked(host.readFile).mockImplementation(async () => { markStarted(); await gate; return gt.buffer; });
    const { handlers, readStore } = arrange(host, { type: 'dacpac', path: '/tmp/sales.dacpac', displayName: 'Sales', schemas: [] });
    const loading = handlers['load-project']({ type: 'load-project', id: 'p1' });
    await started;
    await handlers['delete-project']({ type: 'delete-project', id: 'p1' });
    resume();
    await loading;
    expect(readStore().projects).toEqual([]);
  });
});
