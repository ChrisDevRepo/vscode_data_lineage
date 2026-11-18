/**
 * Pins the output-channel level rule for the bridge handlers: info, warn and error lines carry a
 * generic operation text, and a path, project or view name, node id or schema list is written to a
 * debug line only. One spy channel records every line while the handlers run real, so a new
 * call site that leaks an identifier fails here without its own test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../../../src/engine/projectStore';
import type { DbCellValue, SimpleExecuteResult } from '../../../src/types/database';
import { ColumnStore } from '../../../src/engine/columnStore';
import { buildSyntheticDacpac } from '../helpers/syntheticDacpac';

const PATH = '/tmp/SentinelDir/SentinelSales.dacpac';
const NODE_ID = '[dbo].[SentinelNode]';
const PROJECT = 'SentinelProject';
const VIEW = 'SentinelView';
const SCHEMA = 'SentinelSchema';
const SENTINELS = ['SentinelDir', 'SentinelSales', 'SentinelNode', 'SentinelProject', 'SentinelView', 'SentinelSchema', 'SentinelProc', 'SentinelId', 'SentinelUnresolved'];

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: unknown[]) => parts.join('/') },
  FileSystemError: class FileSystemError extends Error {},
  ViewColumn: { Beside: 2 },
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    withProgress: (_o: unknown, task: (p: unknown, t: unknown) => unknown) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    createWebviewPanel: () => ({
      webview: { asWebviewUri: (u: unknown) => u, cspSource: 'csp', onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
      onDidDispose: () => ({ dispose() {} }),
      reveal() {},
      dispose() {},
    }),
  },
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
      ['nodes', result(['schema_name', 'object_name', 'type_code', 'body_script'], [
        [cell('dbo'), cell('T0'), cell('U '), { displayValue: 'NULL', isNull: true }],
        [cell('dbo'), cell('SentinelProc'), cell('P '), { displayValue: 'NULL', isNull: true }],
      ])],
      ['columns', result(['schema_name', 'table_name', 'column_name'], [])],
      ['dependencies', result(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], [])],
    ]),
  };
});

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');
const { createBridgeHost } = await import('../../../src/bridge/host');
const vscode = await import('vscode');

type Level = 'info' | 'debug' | 'warn' | 'error';
type Spy = Record<Level | 'trace', ReturnType<typeof vi.fn>>;

function setup(options: { bytes?: Uint8Array; readFileError?: Error; store?: ProjectStore; saveFails?: boolean } = {}) {
  const channel: Spy = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
  const panel = { webview: { postMessage: vi.fn().mockResolvedValue(true) } };
  const base = createBridgeHost(panel as never, { extensionUri: 'ext' } as never, channel as never);
  const host = {
    ...base,
    postMessage: vi.fn().mockResolvedValue(true),
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) as never,
    getExtensionUri: () => 'ext' as never,
    getGlobalState: () => ({ get: () => ({}), update: async () => undefined }) as never,
    showOpenDialog: async () => [{ fsPath: PATH }] as never,
    readFile: async () => {
      if (options.readFileError) throw options.readFileError;
      return options.bytes as Uint8Array;
    },
  };
  const store = options.store ?? ({ schemaVersion: 1, lastOpenedId: null, projects: [] } as unknown as ProjectStore);
  const session = {
    model: null, uiState: {}, renderState: null, isDbSession: false, projectName: undefined,
    columnStore: new ColumnStore(), clearDiscoveryTranscript: vi.fn(),
  } as Record<string, unknown>;
  const { handlers } = createMessageHandlers(
    host as never,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {}, extensionUri: 'ext' } as never,
    () => session as never,
    channel as never,
    () => store,
    options.saveFails ? vi.fn().mockRejectedValue(new Error('disk full')) : vi.fn().mockResolvedValue(undefined),
    vi.fn(),
    false,
    vi.fn(),
  );
  return { handlers, channel, session };
}

type Handlers = ReturnType<typeof setup>['handlers'];
const call = (handlers: Handlers, type: string, msg: Record<string, unknown> = {}) =>
  (handlers as unknown as Record<string, (m: unknown) => unknown>)[type]({ type, ...msg });

const project = (connection: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'SentinelId', name: PROJECT, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', connection, ...extra,
});
const storeOf = (...projects: unknown[]) => ({ schemaVersion: 1, lastOpenedId: null, projects }) as unknown as ProjectStore;

/** Lines that reach the default output level (info, warn, error) and name a sentinel identifier. */
function leakedLines(channel: Spy): string[] {
  return (['info', 'warn', 'error'] as const)
    .flatMap((level) => channel[level].mock.calls.map(([line]) => `${level}: ${String(line)}`))
    .filter((line) => SENTINELS.some((s) => line.includes(s)));
}
const debugText = (channel: Spy) => channel.debug.mock.calls.map(([line]) => String(line)).join('\n');

describe('info, warn and error lines carry no path, name, node id or schema list', () => {
  it('stays generic across the dacpac, project, view, detail and webview handlers', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 6, schemaCount: 1 });
    const schemas = Object.keys(gt.perSchemaObjectCount);

    const picked = setup({ bytes: gt.buffer });
    await call(picked.handlers, 'open-dacpac');

    const broken = setup({ bytes: new TextEncoder().encode('not a zip') });
    await call(broken.handlers, 'open-dacpac');

    const missing = setup({ store: storeOf() });
    await call(missing.handlers, 'load-project', { id: 'SentinelId' });

    const gone = setup({
      store: storeOf(project({ type: 'dacpac', path: PATH, displayName: PROJECT, schemas: [] })),
      readFileError: Object.assign(new (vscode as unknown as { FileSystemError: new () => Error }).FileSystemError(), { code: 'FileNotFound' }),
    });
    await call(gone.handlers, 'load-project', { id: 'SentinelId' });

    const unreadable = setup({
      store: storeOf(project({ type: 'dacpac', path: PATH, displayName: PROJECT, schemas: [] })),
      readFileError: new Error('EIO'),
    });
    await call(unreadable.handlers, 'load-project', { id: 'SentinelId' });

    const filtered = setup({ bytes: gt.buffer, store: storeOf(project({ type: 'dacpac', path: PATH, displayName: PROJECT, schemas })) });
    await call(filtered.handlers, 'load-project', { id: 'SentinelId' });

    const database = setup({
      store: storeOf(project({
        type: 'database', sourceName: PROJECT, schemas: [SCHEMA],
        connectionInfo: { server: 'localhost', database: 'Sales', provider: 'builtIn' },
      })),
    });
    await call(database.handlers, 'load-project', { id: 'SentinelId' });

    const restored = setup({
      store: { ...storeOf(project({ type: 'dacpac', path: PATH, displayName: PROJECT, schemas: [] })), lastOpenedId: 'SentinelId' } as ProjectStore,
    });
    restored.session.model = { nodes: [], edges: [], schemas: [] };
    await call(restored.handlers, 'ready');

    const detail = setup();
    await call(detail.handlers, 'show-detail', { node: { id: NODE_ID, name: 'SentinelNode' } });

    const rejected = setup({ store: storeOf({ id: 'SentinelId', name: 5 }) });
    await call(rejected.handlers, 'request-projects');

    const saved = setup({ store: storeOf(project({ type: 'dacpac', path: PATH, displayName: PROJECT, schemas: [] })) });
    await call(saved.handlers, 'save-view', { projectId: 'SentinelId', profile: { id: 'v1', name: VIEW } });

    const saveFails = setup({ store: storeOf(), saveFails: true });
    await expect(call(saveFails.handlers, 'save-view', { projectId: 'SentinelId', profile: { id: 'v1', name: VIEW } })).rejects.toThrow();

    const webview = setup();
    await call(webview.handlers, 'error', { source: 'error-boundary', error: 'boom', context: { path: PATH, node: NODE_ID } });
    await call(webview.handlers, 'show-warning', { text: 'Resize failed' });
    await call(webview.handlers, 'view-render-result', { rendered: 1, of: 2, unresolved: ['SentinelUnresolved'] });
    await call(webview.handlers, 'view-render-result', { rendered: 0, of: 2, unresolved: ['SentinelUnresolved'] });

    const scenarios = { picked, broken, missing, gone, unreadable, filtered, database, restored, detail, rejected, saved, saveFails, webview };
    const leaks = Object.entries(scenarios).flatMap(([name, s]) => leakedLines(s.channel).map((line) => `${name} ${line}`));
    expect(leaks).toEqual([]);

    // The detail moves to debug, so a diagnosis still has it.
    expect(debugText(picked.channel)).toContain(PATH);
    expect(debugText(detail.channel)).toContain(NODE_ID);
    expect(debugText(database.channel)).toContain(SCHEMA);
    expect(debugText(database.channel)).toContain('Definitions not readable: [dbo].[SentinelProc]');
  });
});

describe('webview warning text', () => {
  it('is logged once at warn', async () => {
    const { handlers, channel } = setup();
    await call(handlers, 'show-warning', { text: 'Resize failed' });
    const lines = ['debug', 'info', 'warn', 'error'].flatMap((level) => channel[level as Level].mock.calls.map(([l]) => String(l)));
    expect(lines.filter((l) => l.includes('Resize failed'))).toHaveLength(1);
    expect(channel.warn).toHaveBeenCalledTimes(1);
  });
});
