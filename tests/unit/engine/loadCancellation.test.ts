/** Deferred host boundaries exercise cancellation and panel ownership without database services. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ColumnStore } from '../../../src/engine/columnStore';
import type { BridgeHost } from '../../../src/bridge/host';
import type { DbSession } from '../../../src/engine/db/dbSession';
import type { DatabaseModel } from '../../../src/engine/types';
import type { ProjectStore } from '../../../src/engine/projectStore';
import type { SimpleExecuteResult } from '../../../src/types/mssql';

const ports = vi.hoisted(() => ({ connect: vi.fn(), extract: vi.fn(), preview: vi.fn(), filtered: vi.fn(), build: vi.fn() }));
vi.mock('vscode', async (original) => ({
  ...await original<object>(),
  Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: unknown[]) => ({ fsPath: parts.join('/') }) },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  CancellationError: class CancellationError extends Error {},
  commands: { executeCommand: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
}));
vi.mock('../../../src/engine/connectionManager', async (original) => ({
  ...await original<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => ports.connect(...args),
  loadDmvQueries: async () => [
    { name: 'schema-preview', sql: 'preview', phase: 1 },
    { name: 'platform-info', sql: 'platform', phase: 1 },
    { name: 'nodes', sql: 'nodes WHERE schema_name IN ({{SCHEMAS}})', phase: 2 },
    { name: 'columns', sql: 'columns WHERE schema_name IN ({{SCHEMAS}})', phase: 2 },
    { name: 'dependencies', sql: 'dependencies WHERE schema_name IN ({{SCHEMAS}})', phase: 2 },
  ],
}));
vi.mock('../../../src/engine/dacpacExtractor', () => ({
  extractDacpac: (...args: unknown[]) => ports.extract(...args),
  extractSchemaPreview: (...args: unknown[]) => ports.preview(...args),
  extractDacpacFiltered: (...args: unknown[]) => ports.filtered(...args),
}));
vi.mock('../../../src/engine/dmvExtractor', async (original) => ({
  ...await original<Record<string, unknown>>(),
  buildModelFromDmv: (...args: unknown[]) => ports.build(...args),
  buildSchemaPreview: () => ({ schemas: [], totalObjects: 0 }),
}));
const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const model = (): DatabaseModel => ({ nodes: [], edges: [], schemas: [], catalog: {}, neighborIndex: {} });
const rows: SimpleExecuteResult = { rowCount: 0, columnInfo: [], rows: [] };
const preview = { preview: { schemas: [], totalObjects: 0 }, elements: [], dspName: '', identifierCaseSensitive: false };
const project = (type: 'dacpac' | 'database', schemas = ['dbo']): ProjectStore => ({
  schemaVersion: 1, lastOpenedId: 'p1', projects: [{ id: 'p1', name: 'Saved', createdAt: '2026-01-01', updatedAt: '2026-01-01', connection: type === 'dacpac'
    ? { type, path: '/tmp/synthetic.dacpac', displayName: 'Saved', schemas }
    : { type, sourceName: 'Saved', schemas, connectionInfo: { provider: 'builtIn', server: 'localhost', database: 'Test' } } }],
});
function dbSession() {
  const session: DbSession = {
    provider: 'builtIn', connectionInfo: { provider: 'builtIn', server: 'localhost', database: 'Test' },
    isOpen: () => true, getServerInfo: vi.fn(), executeSimpleQuery: vi.fn(async () => rows), dispose: vi.fn(async () => undefined),
  };
  return session;
}
function arrange(store: ProjectStore = { schemaVersion: 1, lastOpenedId: null, projects: [] }, session = { model: null as DatabaseModel | null, uiState: {}, renderState: null, columnStore: new ColumnStore(), clearDiscoveryTranscript: vi.fn(), clearExternalViews: vi.fn() }, loadDemoFlag = false) {
  const progressTokens: vscode.CancellationTokenSource[] = [];
  const host = {
    postMessage: vi.fn(async () => true), log: vi.fn(), getExtensionUri: () => '/ext',
    getGlobalState: () => ({ get: () => store }), getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    readFile: vi.fn(async () => new Uint8Array()), showOpenDialog: vi.fn(async () => [{ fsPath: '/tmp/synthetic.dacpac' }]),
    withProgress: vi.fn((_options, task) => { const token = new vscode.CancellationTokenSource(); progressTokens.push(token); return task({ report() {} }, token.token); }),
  } as unknown as BridgeHost;
  const save = vi.fn(async (_context, value: ProjectStore) => { store = value; });
  const bundle = createMessageHandlers(host, { globalState: {}, secrets: {}, extensionUri: '/ext' } as never, () => session as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never,
    () => store, save, vi.fn(), loadDemoFlag, vi.fn());
  return { ...bundle, host, session, save, progressTokens, readStore: () => store, frames: () => vi.mocked(host.postMessage).mock.calls.map(([frame]) => frame) };
}
async function cancelUi(bundle: ReturnType<typeof arrange>) {
  const handler = (bundle.handlers as unknown as Record<string, (message: unknown) => unknown>)['cancel-load'];
  await handler?.({ type: 'cancel-load' });
}
beforeEach(() => {
  ports.connect.mockReset(); ports.extract.mockReset().mockResolvedValue(model()); ports.preview.mockReset().mockResolvedValue(preview);
  ports.filtered.mockReset().mockReturnValue(model()); ports.build.mockReset().mockReturnValue(model());
});

it('switches the wizard provider globally and publishes refreshed availability', async () => {
  let provider = 'mssqlExtension';
  const update = vi.fn(async (_key: string, value: string) => { await Promise.resolve(); provider = value; });
  const configuration = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (key: string, fallback: unknown) => key === 'connectionProvider' ? provider : fallback,
    update,
  } as never);
  try {
    const app = arrange();
    await app.handlers['use-builtin-connection']({ type: 'use-builtin-connection' });
    expect(configuration).toHaveBeenCalledWith('dataLineageViz.database');
    expect(update).toHaveBeenCalledExactlyOnceWith('connectionProvider', 'builtIn', vscode.ConfigurationTarget.Global);
    expect(app.frames()).toContainEqual(expect.objectContaining({ type: 'mssql-status', provider: 'builtIn', available: true }));
    expect(ports.connect).not.toHaveBeenCalled();
  } finally {
    configuration.mockRestore();
  }
});

describe('database load cancellation', () => {
  it.each(['preview', 'platform', 'nodes'] as const)('notification Cancel during %s stops publication and subsequent queries', async (sql) => {
    const query = deferred<SimpleExecuteResult>();
    const session = dbSession();
    vi.mocked(session.executeSimpleQuery).mockImplementation(async text => text.startsWith(sql) ? query.promise : rows);
    ports.connect.mockResolvedValue(session);
    const app = arrange(sql === 'nodes' ? project('database') : undefined);
    const loading = sql === 'nodes' ? app.handlers['load-project']({ type: 'load-project', id: 'p1' }) : app.handlers['db-connect']({ type: 'db-connect' });
    await vi.waitFor(() => expect(session.executeSimpleQuery).toHaveBeenCalledWith(expect.stringContaining(sql), expect.anything()));
    const count = vi.mocked(session.executeSimpleQuery).mock.calls.length;
    app.progressTokens[0].cancel();
    query.resolve(rows);
    await loading;
    expect(vi.mocked(session.executeSimpleQuery).mock.calls).toHaveLength(count);
    expect(app.frames().some(frame => frame.type === 'db-model' || frame.type === 'db-schema-preview' || frame.type === 'db-error')).toBe(false);
    expect(app.frames().filter(frame => frame.type === 'db-cancelled')).toHaveLength(1);
    expect(app.session.model).toBeNull();
    expect(app.save).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('Cancel during a legacy platform probe stops the fallback without closing Microsoft-owned sessions', async () => {
    const query = deferred<SimpleExecuteResult>();
    const session = { ...dbSession(), provider: 'mssqlExtension' as const };
    vi.mocked(session.executeSimpleQuery).mockImplementation(async sql => sql === 'platform' ? query.promise : rows);
    ports.connect.mockResolvedValue(session);
    const app = arrange(); const loading = app.handlers['db-connect']({ type: 'db-connect' });
    await vi.waitFor(() => expect(session.executeSimpleQuery).toHaveBeenCalledWith('platform', expect.anything()));
    app.progressTokens[0].cancel(); query.resolve(rows); await loading;
    expect(session.getServerInfo).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(app.frames().some(frame => frame.type === 'db-schema-preview' || frame.type === 'db-error')).toBe(false);
  });

  it('Cancel releases an in-flight built-in query without waiting for it to settle', async () => {
    const query = deferred<SimpleExecuteResult>();
    const session = dbSession();
    vi.mocked(session.executeSimpleQuery).mockReturnValue(query.promise);
    vi.mocked(session.dispose).mockImplementation(async () => { query.reject(new Error('connection closed')); });
    ports.connect.mockResolvedValue(session);
    const app = arrange();
    const loading = app.handlers['db-connect']({ type: 'db-connect' });
    await vi.waitFor(() => expect(session.executeSimpleQuery).toHaveBeenCalled());
    app.progressTokens[0].cancel();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledTimes(1));
    await loading;
    expect(app.frames().some(frame => frame.type === 'db-error' || frame.type === 'db-schema-preview')).toBe(false);
  });

  it('panel close during connection negotiation releases the arriving session without querying', async () => {
    const connected = deferred<DbSession>();
    ports.connect.mockReturnValue(connected.promise);
    const session = dbSession();
    const app = arrange();
    const loading = app.handlers['db-connect']({ type: 'db-connect' });
    await vi.waitFor(() => expect(ports.connect).toHaveBeenCalled());
    const before = app.frames();
    await app.cleanup();
    connected.resolve(session);
    await loading;
    expect(session.executeSimpleQuery).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(app.frames()).toEqual(before);
  });

  it('closed old DB completion cannot overwrite a new panel or release its new connection', async () => {
    const query = deferred<SimpleExecuteResult>();
    const oldSession = dbSession(); const currentSession = dbSession();
    vi.mocked(oldSession.executeSimpleQuery).mockImplementation(async sql => sql.startsWith('nodes') ? query.promise : rows);
    ports.connect.mockResolvedValueOnce(oldSession).mockResolvedValueOnce(currentSession);
    const oldPanel = arrange(project('database'));
    const oldLoad = oldPanel.handlers['load-project']({ type: 'load-project', id: 'p1' });
    await vi.waitFor(() => expect(oldSession.executeSimpleQuery).toHaveBeenCalledWith(expect.stringContaining('nodes'), expect.anything()));
    await oldPanel.cleanup();
    const before = oldPanel.frames().length;
    const newPanel = arrange(project('database'), oldPanel.session);
    const current = model(); ports.build.mockReturnValue(current);
    await newPanel.handlers['load-project']({ type: 'load-project', id: 'p1' });
    query.resolve(rows); await oldLoad;
    expect(newPanel.session.model).toBe(current);
    expect(oldPanel.frames()).toHaveLength(before);
    expect(oldPanel.save).not.toHaveBeenCalled();
    expect(oldSession.dispose).toHaveBeenCalledTimes(1);
    expect(currentSession.dispose).toHaveBeenCalledTimes(1);
  });

});

describe('closed or cancelled DACPAC loads', () => {
  it.each(['demo', 'open', 'saved-preview', 'saved-model'] as const)('panel close during %s extraction suppresses late model, preview and refresh', async (kind) => {
    const extracted = deferred<DatabaseModel | typeof preview>();
    const app = arrange(kind.startsWith('saved') ? project('dacpac', kind === 'saved-preview' ? [] : ['dbo']) : undefined);
    if (kind === 'demo') ports.extract.mockReturnValue(extracted.promise);
    else ports.preview.mockReturnValue(extracted.promise);
    const loading = kind === 'demo' ? app.handlers['load-demo']({ type: 'load-demo' }) : kind === 'open' ? app.handlers['open-dacpac']({ type: 'open-dacpac' }) : app.handlers['load-project']({ type: 'load-project', id: 'p1' });
    await vi.waitFor(() => expect(kind === 'demo' ? ports.extract : ports.preview).toHaveBeenCalled());
    await app.cleanup();
    const frames = app.frames().length;
    const refreshed = app.save.mock.calls.length;
    const replacement = model();
    app.session.model = replacement;
    extracted.resolve(kind === 'demo' ? model() : preview);
    await loading;
    expect(app.session.model).toBe(replacement);
    expect(app.frames()).toHaveLength(frames);
    expect(app.save.mock.calls).toHaveLength(refreshed);
  });

  it.each([
    ['close', []], ['close', ['dbo']], ['cancel', []], ['cancel', ['dbo']],
  ] as const)('%s during saved extraction preserves remembered project fields (schemas=%j)', async (action, schemas) => {
    const extraction = deferred<typeof preview>(); ports.preview.mockReturnValue(extraction.promise);
    const initial = { ...project('dacpac', [...schemas]), lastOpenedId: null };
    const app = arrange(initial);
    const loading = app.handlers['load-project']({ type: 'load-project', id: 'p1' });
    await vi.waitFor(() => expect(ports.preview).toHaveBeenCalled());
    if (action === 'close') await app.cleanup(); else await cancelUi(app);
    extraction.resolve(preview); await loading;
    expect(app.save).not.toHaveBeenCalled();
    expect(app.readStore()).toBe(initial);
    expect(app.readStore().lastOpenedId).toBeNull();
    expect(app.readStore().projects[0].updatedAt).toBe('2026-01-01');
  });

  it('closed saved-file read performs no persistence or publication', async () => {
    const read = deferred<Uint8Array>();
    const app = arrange(project('dacpac'));
    vi.mocked(app.host.readFile).mockReturnValue(read.promise);
    const loading = app.handlers['load-project']({ type: 'load-project', id: 'p1' });
    await vi.waitFor(() => expect(app.host.readFile).toHaveBeenCalled());
    const before = app.frames();
    await app.cleanup(); read.resolve(new Uint8Array()); await loading;
    expect(app.save).not.toHaveBeenCalled();
    expect(app.frames()).toEqual(before);
  });

  it('cancel A then start B allows only B to install its model', async () => {
    const old = deferred<DatabaseModel>(); const next = deferred<DatabaseModel>();
    ports.extract.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const app = arrange();
    const a = app.handlers['load-demo']({ type: 'load-demo' });
    await vi.waitFor(() => expect(ports.extract).toHaveBeenCalledTimes(1));
    await cancelUi(app);
    const b = app.handlers['load-demo']({ type: 'load-demo' });
    await vi.waitFor(() => expect(ports.extract).toHaveBeenCalledTimes(2));
    const current = model(); next.resolve(current); await b;
    const frames = app.frames().length;
    old.resolve(model()); await a;
    expect(app.session.model).toBe(current);
    expect(app.frames()).toHaveLength(frames);
  });

  it('a closed demo extraction failure does not publish its old error', async () => {
    const extraction = deferred<DatabaseModel>(); ports.extract.mockReturnValue(extraction.promise);
    const app = arrange(); const loading = app.handlers['load-demo']({ type: 'load-demo' });
    await vi.waitFor(() => expect(ports.extract).toHaveBeenCalled());
    const before = app.frames();
    await app.cleanup(); extraction.reject(new Error('old archive failure')); await loading;
    expect(app.frames()).toEqual(before);
  });

});

describe('normal load controls', () => {
  it.each(['demo', 'open', 'saved-preview', 'saved-model', 'database'] as const)('%s still loads normally', async kind => {
    ports.connect.mockResolvedValue(dbSession());
    const app = arrange(kind === 'database' ? project('database') : kind.startsWith('saved') ? project('dacpac', kind === 'saved-preview' ? [] : ['dbo']) : undefined);
    if (kind === 'demo') await app.triggerDemoLoad();
    else if (kind === 'open') await app.handlers['open-dacpac']({ type: 'open-dacpac' });
    else await app.handlers['load-project']({ type: 'load-project', id: 'p1' });
    expect(app.frames().some(frame => ['dacpac-model', 'dacpac-schema-preview', 'db-model'].includes(frame.type))).toBe(true);
  });
  it('ready restores a cached project model', async () => {
    const app = arrange(project('dacpac')); const cached = model(); app.session.model = cached;
    await app.handlers.ready({ type: 'ready' });
    expect(app.frames()).toContainEqual(expect.objectContaining({ type: 'dacpac-model', model: cached, autoVisualize: true }));
  });
  it('noncancelled extraction failure still reports its reason', async () => {
    ports.extract.mockRejectedValue(new Error('synthetic archive failure'));
    const app = arrange(); await app.handlers['load-demo']({ type: 'load-demo' });
    expect(app.frames()).toContainEqual(expect.objectContaining({ type: 'db-error', message: expect.stringContaining('synthetic archive failure') }));
  });
  it('schema preview then selected-schema load uses its own valid connection', async () => {
    const previewSession = dbSession(); const selectedSession = dbSession();
    ports.connect.mockResolvedValueOnce(previewSession).mockResolvedValueOnce(selectedSession);
    const app = arrange();
    await app.handlers['db-connect']({ type: 'db-connect' });
    await app.handlers['db-visualize']({ type: 'db-visualize', schemas: ['dbo'] });
    expect(app.frames().filter(frame => frame.type === 'db-schema-preview')).toHaveLength(1);
    expect(app.frames().filter(frame => frame.type === 'db-model')).toHaveLength(1);
    expect(previewSession.dispose).toHaveBeenCalledTimes(1);
    expect(selectedSession.dispose).toHaveBeenCalledTimes(1);
  });
  it('noncancelled database failure still reports the reason and releases its session', async () => {
    const session = dbSession(); vi.mocked(session.executeSimpleQuery).mockRejectedValue(new Error('synthetic query failure'));
    ports.connect.mockResolvedValue(session); const app = arrange();
    await app.handlers['db-connect']({ type: 'db-connect' });
    expect(app.frames()).toContainEqual(expect.objectContaining({ type: 'db-error', message: 'synthetic query failure' }));
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('a fresh command load after Cancel announces its new owner and succeeds', async () => {
    const app = arrange(); await cancelUi(app);
    await app.triggerDemoLoad();
    const start = app.frames().findIndex(frame => frame.type === 'load-started');
    const result = app.frames().findIndex(frame => frame.type === 'dacpac-model');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(result).toBeGreaterThan(start);
  });
  it('a closed bundle never announces or starts a fresh load', async () => {
    const app = arrange(); await app.cleanup(); await app.triggerDemoLoad();
    expect(app.frames()).toEqual([]);
    expect(app.host.readFile).not.toHaveBeenCalled();
  });

  it('completed database work detaches its notification cancellation listener', async () => {
    const session = dbSession(); ports.connect.mockResolvedValue(session);
    const app = arrange(); await app.handlers['db-connect']({ type: 'db-connect' });
    const before = app.frames(); app.progressTokens[0].cancel();
    expect(app.frames()).toEqual(before);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
  it('initial demo ready runs one extraction and installs its normal result', async () => {
    const app = arrange(undefined, undefined, true);
    const expected = model(); ports.extract.mockResolvedValue(expected);
    await app.handlers.ready({ type: 'ready' });
    expect(ports.extract).toHaveBeenCalledTimes(1);
    expect(app.session.model).toBe(expected);
    expect(app.frames().filter(frame => frame.type === 'dacpac-model')).toHaveLength(1);
  });

  it('explicit UI cancellation acknowledgements remain distinct across a fast replacement load', async () => {
    const old = deferred<DatabaseModel>();
    ports.extract.mockReturnValueOnce(old.promise).mockResolvedValueOnce(model());
    const app = arrange(); const first = app.handlers['load-demo']({ type: 'load-demo' });
    await vi.waitFor(() => expect(ports.extract).toHaveBeenCalledTimes(1));
    await cancelUi(app);
    await app.handlers['load-demo']({ type: 'load-demo' });
    await cancelUi(app);
    old.resolve(model()); await first;
    expect(app.frames().map(frame => frame.type)).toEqual([
      'load-started', 'load-cancelled', 'load-started', 'dacpac-model', 'load-cancelled',
    ]);
  });

});
