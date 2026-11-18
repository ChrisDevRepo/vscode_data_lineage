/**
 * Pins the host side of load cancellation. The webview names each load with the `loadId` it sends; the
 * host stamps that load's results with it, `cancel-load{loadId}` stops that load so it posts no model
 * and leaves no model in the session, and a load started after a cancel is unaffected. A retry that
 * the connection-error toast starts after its load ended is still the same load and still cancellable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';
import type { ProjectStore } from '../../../src/engine/projectStore';
import type { DbCellValue, SimpleExecuteResult } from '../../../src/types/database';
import { ColumnStore } from '../../../src/engine/columnStore';
import { buildSyntheticDacpac } from '../helpers/syntheticDacpac';
import { ExtensionToWebviewMsgSchema, MainPanelToExtensionMsgSchema } from '../../../src/engine/shared/bridgeContract';

const db = vi.hoisted(() => ({
  connect: vi.fn(),
  present: vi.fn(),
  /** The `retry` hook of every connection-error toast the host built, in order. */
  retries: [] as Array<(patch?: unknown) => Promise<void> | void>,
}));

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: unknown[]) => parts.join('/') },
  FileSystemError: class FileSystemError extends Error {},
  window: {
    showErrorMessage: (...args: unknown[]) => db.present(...args),
    withProgress: (_o: unknown, task: (p: unknown, t: unknown) => unknown) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
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
  const actual = await importOriginal<typeof import('../../../src/engine/connectionManager')>();
  return {
    ...actual,
    connectDatabase: (...args: unknown[]) => db.connect(...args),
    connectionErrorHooks: (...args: Parameters<typeof actual.connectionErrorHooks>) => {
      db.retries.push(args[2] as never);
      return actual.connectionErrorHooks(...args);
    },
    loadDmvQueries: async () => [],
    executeDmvQueries: async () => new Map(),
    executeDmvQueriesFiltered: async () => new Map([
      ['nodes', result(['schema_name', 'object_name', 'type_code', 'body_script'], [[cell('dbo'), cell('T0'), cell('U '), { displayValue: 'NULL', isNull: true }]])],
      ['columns', result(['schema_name', 'table_name', 'column_name'], [])],
      ['dependencies', result(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], [])],
    ]),
  };
});

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');
const { DbConnectionError } = await import('../../../src/engine/db/dbSession');

type Posted = { type: string; loadId?: string };

/** A promise whose resolution the test controls. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function build(store: ProjectStore, readFile: () => Promise<Uint8Array>) {
  const host = {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getConfiguration: vi.fn().mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback }),
    getExtensionUri: vi.fn().mockReturnValue('ext'),
    getGlobalState: vi.fn().mockReturnValue({ get: () => undefined }),
    readFile: vi.fn(readFile),
    withProgress: vi.fn((_o: unknown, task: (p: unknown, t: unknown) => unknown) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })),
  } as unknown as BridgeHost;
  const session = { model: null, uiState: {}, renderState: null, isDbSession: false, columnStore: new ColumnStore(), clearDiscoveryTranscript: vi.fn() };
  const save = vi.fn().mockResolvedValue(undefined);
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => session as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never,
    () => store,
    save,
    vi.fn(),
    false,
    vi.fn(),
  );
  const posted = () => vi.mocked(host.postMessage).mock.calls.map(([m]) => m as Posted);
  const send = (type: string, msg: Record<string, unknown> = {}) =>
    (handlers as unknown as Record<string, (m: unknown) => unknown>)[type]({ type, ...msg }) as Promise<void>;
  return { session, posted, send, save };
}

const projectOf = (connection: Record<string, unknown>) => ({
  schemaVersion: 1,
  projects: [{ id: 'p1', name: 'Sales', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', connection }],
}) as unknown as ProjectStore;

async function setupDacpac() {
  const gt = await buildSyntheticDacpac({ objectCount: 6, schemaCount: 1 });
  const schemas = Object.keys(gt.perSchemaObjectCount);
  /** The gate the next file read waits on; a later read is not held. */
  let hold: Promise<void> | null = null;
  const file = build(
    projectOf({ type: 'dacpac', path: '/tmp/sales.dacpac', displayName: 'Sales', schemas }),
    async () => {
      const gate = hold;
      hold = null;
      if (gate) await gate;
      return gt.buffer;
    },
  );
  /** Holds the next file read until the returned function runs. */
  const holdFile = () => {
    const gate = deferred();
    hold = gate.promise;
    return gate.resolve;
  };
  return { ...file, holdFile };
}

describe('host load cancellation', () => {
  it('stamps the result with the id the webview sent', async () => {
    const { send, posted } = await setupDacpac();
    await send('load-project', { id: 'p1', loadId: 'A' });

    expect(posted().find((m) => m.type === 'dacpac-model')?.loadId).toBe('A');
    expect(posted().some((m) => m.type === 'load-started')).toBe(false);
  });

  it('leaves the result unstamped when the request names no load', async () => {
    const { send, posted } = await setupDacpac();
    await send('load-project', { id: 'p1' });

    const model = posted().find((m) => m.type === 'dacpac-model');
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty('loadId');
  });

  it('cancel-load before the file read finishes posts no model', async () => {
    const { send, posted, holdFile } = await setupDacpac();
    const release = holdFile();
    const running = send('load-project', { id: 'p1', loadId: 'A' });

    await send('cancel-load', { loadId: 'A' });
    release();
    await running;

    expect(posted().some((m) => m.type === 'dacpac-model' || m.type === 'db-error')).toBe(false);
  });

  it('a cancel for another id leaves the running load alone', async () => {
    const { send, posted, holdFile } = await setupDacpac();
    const release = holdFile();
    const running = send('load-project', { id: 'p1', loadId: 'A' });
    await send('cancel-load', { loadId: 'B' });
    release();
    await running;

    expect(posted().some((m) => m.type === 'dacpac-model')).toBe(true);
  });

  it('a load started after a cancel posts its own stamped model', async () => {
    const { send, posted, holdFile } = await setupDacpac();
    const release = holdFile();
    const first = send('load-project', { id: 'p1', loadId: 'A' });
    await send('cancel-load', { loadId: 'A' });
    release();
    await first;

    await send('load-project', { id: 'p1', loadId: 'B' });

    const models = posted().filter((m) => m.type === 'dacpac-model');
    expect(models).toHaveLength(1);
    expect(models[0].loadId).toBe('B');
  });
});

describe('a newer load supersedes a running one', () => {
  it('the superseded load sets no session model and writes no project store', async () => {
    const { send, posted, session, save, holdFile } = await setupDacpac();
    const release = holdFile();
    const first = send('load-project', { id: 'p1', loadId: 'A' });

    await send('load-project', { id: 'p1', loadId: 'B' });
    const modelOfB = posted().find((m) => m.type === 'dacpac-model') as unknown as { model: unknown; loadId: string };
    expect(modelOfB.loadId).toBe('B');
    release();
    await first;

    expect(posted().filter((m) => m.type === 'dacpac-model')).toHaveLength(1);
    expect(session.model).toBe(modelOfB.model);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a load that names no id supersedes a named one too', async () => {
    const { send, posted, save, holdFile } = await setupDacpac();
    const release = holdFile();
    const first = send('load-project', { id: 'p1', loadId: 'A' });

    await send('load-project', { id: 'p1' });
    release();
    await first;

    expect(posted().filter((m) => m.type === 'dacpac-model')).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('retry after the load ended', () => {
  const dbProject = projectOf({
    type: 'database', sourceName: 'Sales', schemas: ['dbo'],
    connectionInfo: { server: 'localhost', database: 'Sales', provider: 'builtIn' },
  });
  const unavailable = () => new DbConnectionError(
    { provider: 'builtIn', name: 'localhost / Sales', server: 'localhost' } as never,
    Object.assign(new Error('Database is not currently available'), { number: 40613 }),
  );
  const session = () => ({
    provider: 'builtIn',
    connectionInfo: { server: 'localhost', database: 'Sales', provider: 'builtIn' },
    getServerInfo: async () => ({ engineEditionId: 3 }),
    executeSimpleQuery: async () => { throw new Error('not scripted'); },
    dispose: async () => undefined,
  });

  beforeEach(() => {
    db.connect.mockReset();
    db.present.mockReset();
    db.retries.length = 0;
  });

  /** Runs a database project load whose first connect fails, and returns the toast answer the test controls. */
  async function failFirstConnect() {
    const file = build(dbProject, async () => new Uint8Array());
    db.connect.mockRejectedValueOnce(unavailable());
    const toast = deferred<string | undefined>();
    db.present.mockReturnValue(toast.promise);
    await file.send('load-project', { id: 'p1', loadId: 'A' });
    return { ...file, toast };
  }

  it('Retry runs the same load: its model is stamped with the id and applied', async () => {
    const { posted, session: held, toast } = await failFirstConnect();
    expect(db.present).toHaveBeenCalledWith(expect.any(String), 'Retry');

    db.connect.mockResolvedValueOnce(session());
    toast.resolve('Retry');
    await vi.waitFor(() => expect(posted().some((m) => m.type === 'db-model')).toBe(true));

    expect(posted().find((m) => m.type === 'db-model')?.loadId).toBe('A');
    expect(held.model).not.toBeNull();
  });

  it('cancel-load while the retry runs posts no model and leaves none in the session', async () => {
    const { send, posted, session: held, toast } = await failFirstConnect();

    const connecting = deferred<ReturnType<typeof session>>();
    db.connect.mockReturnValueOnce(connecting.promise);
    toast.resolve('Retry');
    await vi.waitFor(() => expect(db.connect).toHaveBeenCalledTimes(2));

    await send('cancel-load', { loadId: 'A' });
    connecting.resolve(session());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted().some((m) => m.type === 'db-model')).toBe(false);
    expect(held.model).toBeNull();
  });

  it('Retry of a load that a newer load replaced is refused and runs nothing', async () => {
    const { send, posted, session: held, toast } = await failFirstConnect();

    await send('load-project', { id: 'p1', loadId: 'B' });
    db.connect.mockClear();
    db.connect.mockResolvedValue(session());
    toast.resolve('Retry');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(db.connect).not.toHaveBeenCalled();
    expect(posted().filter((m) => m.type === 'db-model')).toEqual([]);
    expect(held.model).toBeNull();
  });

  /** Starts a Retry of load A that waits on its connection, then asks for a second one. */
  async function retryWhileRetrying() {
    const file = await failFirstConnect();
    const running = deferred<ReturnType<typeof session>>();
    db.connect.mockReturnValueOnce(running.promise);
    db.present.mockReturnValue(new Promise(() => {}));
    const retry = db.retries[0];
    const first = retry();
    await vi.waitFor(() => expect(db.connect).toHaveBeenCalledTimes(2));
    const postedBefore = file.posted().length;
    await retry();
    return { ...file, running, first, postedBefore };
  }

  it('a second Retry while one runs is refused, runs nothing and posts nothing', async () => {
    const { posted, session: held, running, first, postedBefore } = await retryWhileRetrying();

    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(posted()).toHaveLength(postedBefore);

    running.resolve(session());
    await first;
    expect(posted().filter((m) => m.type === 'db-model')).toEqual([expect.objectContaining({ loadId: 'A' })]);
    expect(held.model).not.toBeNull();
  });

  it('cancel-load reaches the running Retry after a second Retry was refused', async () => {
    const { send, posted, session: held, running, first } = await retryWhileRetrying();

    await send('cancel-load', { loadId: 'A' });
    running.resolve(session());
    await first;

    expect(posted().some((m) => m.type === 'db-model')).toBe(false);
    expect(held.model).toBeNull();
  });

  it('offers no Retry when the user cancelled before the connection error arrived', async () => {
    const file = build(dbProject, async () => new Uint8Array());
    const connecting = deferred<never>();
    db.connect.mockReturnValueOnce(connecting.promise);
    db.present.mockResolvedValue(undefined);
    const running = file.send('load-project', { id: 'p1', loadId: 'A' });

    await file.send('cancel-load', { loadId: 'A' });
    connecting.resolve(Promise.reject(unavailable()) as never);
    await running;

    expect(db.present).toHaveBeenCalledTimes(1);
    expect(db.present.mock.calls[0].slice(1)).not.toContain('Retry');
    expect(file.posted().some((m) => m.type === 'db-error')).toBe(false);
  });
});

describe('load messages in the bridge contract', () => {
  it('carries the load id on the requests, the results and the cancel', () => {
    for (const type of ['open-dacpac', 'load-demo', 'db-connect']) {
      expect(MainPanelToExtensionMsgSchema.safeParse({ type, loadId: 'A' }).success).toBe(true);
      expect(MainPanelToExtensionMsgSchema.safeParse({ type }).success).toBe(true);
    }
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'load-project', id: 'p1', loadId: 'A' }).success).toBe(true);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'dacpac-visualize', schemas: [], loadId: 'A' }).success).toBe(true);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'db-visualize', schemas: [], loadId: 'A' }).success).toBe(true);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'cancel-load', loadId: 'A' }).success).toBe(true);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'cancel-load' }).success).toBe(false);
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'db-error', message: 'x', phase: 'connect', loadId: 'A' }).success).toBe(true);
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'db-error', message: 'x', phase: 'connect' }).success).toBe(true);
  });

  it('has no host-assigned load announcement', () => {
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'load-started', loadId: 'A' }).success).toBe(false);
  });
});

describe('ready re-syncs the session model', () => {
  const store = projectOf({ type: 'dacpac', path: '/tmp/x.dacpac' });
  const loaded = (session: { model: unknown; projectName?: string }, projectName: string) => {
    session.model = { nodes: [], edges: [], schemas: [] };
    session.projectName = projectName;
  };
  const models = (posted: Array<Posted & { sourceName?: string }>) => posted.filter((m) => m.type === 'dacpac-model').map((m) => m.sourceName);

  it('delivers a model a command installed before the webview was ready', async () => {
    const { session, send, posted } = build(store, async () => new Uint8Array());
    loaded(session, 'External');

    await send('ready');

    expect(models(posted())).toEqual(['External']);
  });

  it('delivers it once when a project was also last opened', async () => {
    const { session, send, posted } = build({ ...store, lastOpenedId: 'p1' } as ProjectStore, async () => new Uint8Array());
    loaded(session, 'External');

    await send('ready');

    expect(posted().filter((m) => m.type === 'dacpac-model')).toHaveLength(1);
  });

  it('delivers the current model again after a webview reload sends ready a second time', async () => {
    const { session, send, posted } = build(store, async () => new Uint8Array());
    await send('ready');
    expect(models(posted())).toEqual([]);

    loaded(session, 'AfterReload');
    await send('ready');

    expect(models(posted())).toEqual(['AfterReload']);
  });
});
