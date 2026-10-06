/**
 * Pins that reopening a saved project whose source grew past `dataLineageViz.maxNodes` loads nothing
 * and reports the one object-limit message — for a DACPAC project and for a database project alike.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';
import type { ProjectStore } from '../../../src/engine/projectStore';
import type { DbCellValue, SimpleExecuteResult } from '../../../src/types/mssql';
import { ColumnStore } from '../../../src/engine/columnStore';
import { formatObjectLimitMessage } from '../../../src/engine/modelFilters';
import { buildSyntheticDacpac } from '../helpers/syntheticDacpac';

const db = vi.hoisted(() => ({ tableCount: 0 }));

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
    executeDmvQueriesFiltered: async () => new Map([
      ['nodes', result(['schema_name', 'object_name', 'type_code', 'body_script'],
        Array.from({ length: db.tableCount }, (_, i) => [cell('dbo'), cell(`T${i}`), cell('U '), { displayValue: 'NULL', isNull: true }]))],
      ['columns', result(['schema_name', 'table_name', 'column_name'], [])],
      ['dependencies', result(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], [])],
    ]),
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
    getWorkspaceState: vi.fn(),
  } as unknown as BridgeHost;
}

async function reload(host: BridgeHost, connection: Record<string, unknown>): Promise<Array<{ type: string; message?: string }>> {
  const store = {
    schemaVersion: 1,
    projects: [{ id: 'p1', name: 'Sales', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', connection }],
  } as unknown as ProjectStore;
  const session = { model: null, uiState: {}, renderState: null, isDbSession: false, columnStore: new ColumnStore(), clearDiscoveryTranscript: vi.fn() };
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => session as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), appendLine: vi.fn() } as never,
    () => store,
    vi.fn().mockResolvedValue(undefined),
    vi.fn(),
    false,
    vi.fn(),
  );
  await handlers["load-project"]({ type: "load-project", id: "p1" } as never);
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
