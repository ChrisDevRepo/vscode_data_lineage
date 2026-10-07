/**
 * Pins the DMV queries cache: the YAML is read once per setting value for server-info lookups, a change
 * of `dataLineageViz.dmvQueriesFile` reloads it, and an invalid custom file warns once rather than on
 * every table-statistics request.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../../src/bridge/host';
import { rootPath } from '../../helpers/testUtils';

const CUSTOM_PATH = resolve('/workspace', 'dmvQueries.yaml');

const env = vi.hoisted(() => ({
  setting: '',
  customReads: 0,
  configListeners: new Set<(e: { affectsConfiguration: (key: string) => boolean }) => void>(),
  showWarningMessage: vi.fn(),
  detailListener: undefined as ((message: unknown) => Promise<void>) | undefined,
  panelDisposed: undefined as (() => void) | undefined,
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { resolve: resolvePath } = await import('node:path');
  return {
    ...actual,
    Uri: {
      file: (fsPath: string) => ({ fsPath, path: fsPath }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
    },
    ViewColumn: { Beside: -2 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: resolvePath('/workspace') } }],
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => {
          if (key === 'dmvQueriesFile') return env.setting;
          if (key === 'connectionProvider') return 'builtIn';
          return fallback;
        },
        inspect: () => ({ globalValue: env.setting }),
        update: async (_key: string, value: string) => { env.setting = value; },
      }),
      fs: {
        readFile: async (uri: { fsPath: string }) => {
          if (uri.fsPath === CUSTOM_PATH) {
            env.customReads++;
            return new TextEncoder().encode('version: 1\nqueries: not-a-list\n');
          }
          return readFileSync(uri.fsPath);
        },
      },
      onDidChangeConfiguration: (listener: (e: { affectsConfiguration: (key: string) => boolean }) => void) => {
        env.configListeners.add(listener);
        return { dispose: () => env.configListeners.delete(listener) };
      },
    },
    window: {
      showWarningMessage: (...args: unknown[]) => env.showWarningMessage(...args),
      createWebviewPanel: () => ({
        title: '',
        reveal: vi.fn(),
        onDidDispose: (listener: () => void) => { env.panelDisposed = listener; return { dispose: () => {} }; },
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (uri: unknown) => uri,
          onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
            env.detailListener = listener;
            return { dispose: () => {} };
          },
          postMessage: async () => true,
        },
      }),
    },
  };
});

const connectDatabase = vi.fn();
vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));

const { createDmvQueryCache, loadDmvQueries } = await import('../../../../src/engine/connectionManager');
const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');

const outputChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never;
const extensionUri = { fsPath: rootPath() } as never;

function changeSetting(value: string, key = 'dataLineageViz.dmvQueriesFile'): void {
  if (key === 'dataLineageViz.dmvQueriesFile') env.setting = value;
  for (const listener of [...env.configListeners]) listener({ affectsConfiguration: (k) => key === k || key.startsWith(`${k}.`) });
}

beforeEach(() => {
  env.setting = '';
  env.customReads = 0;
  env.configListeners.clear();
  env.showWarningMessage.mockReset();
  env.detailListener = undefined;
  env.panelDisposed = undefined;
  connectDatabase.mockReset();
});

describe('createDmvQueryCache', () => {
  const queries = [{ name: 'platform-info', sql: 'SELECT 1' }];

  it('loads once for two reads', async () => {
    const load = vi.fn(async () => queries);
    const cache = createDmvQueryCache(load);
    expect(await cache.get()).toBe(queries);
    expect(await cache.get()).toBe(queries);
    expect(load).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('reloads after dataLineageViz.dmvQueriesFile changes, and ignores other settings', async () => {
    const load = vi.fn(async () => queries);
    const cache = createDmvQueryCache(load);
    await cache.get();
    changeSetting('', 'dataLineageViz.dmvQueryTimeout');
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    changeSetting('/elsewhere/dmv.yaml');
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('keeps the cache when a relative path is rewritten to the same absolute file', async () => {
    env.setting = 'dmvQueries.yaml';
    const load = vi.fn(async () => queries);
    const cache = createDmvQueryCache(load);
    await cache.get();
    changeSetting(CUSTOM_PATH);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('does not keep a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('unreadable')).mockResolvedValue(queries);
    const cache = createDmvQueryCache(load);
    await expect(cache.get()).rejects.toThrow('unreadable');
    expect(await cache.get()).toBe(queries);
    expect(load).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('reload always reads again and later reads reuse it', async () => {
    const load = vi.fn(async () => queries);
    const cache = createDmvQueryCache(load);
    await cache.get();
    await cache.reload();
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('listens for setting changes from the first load until disposed', async () => {
    const cache = createDmvQueryCache(async () => queries);
    expect(env.configListeners.size).toBe(0);
    await cache.get();
    await cache.reload();
    expect(env.configListeners.size).toBe(1);
    cache.dispose();
    expect(env.configListeners.size).toBe(0);
  });

  it('an invalid custom file warns once across two cached reads', async () => {
    env.setting = CUSTOM_PATH;
    const cache = createDmvQueryCache(() => loadDmvQueries(outputChannel, extensionUri));
    const first = await cache.get();
    await cache.get();
    expect(first.some((q) => q.name === 'platform-info')).toBe(true);
    expect(env.customReads).toBe(1);
    expect(env.showWarningMessage).toHaveBeenCalledTimes(1);
    cache.dispose();
  });
});

describe('table statistics read the DMV queries once', () => {
  function builtInSession(loadQueries: () => Promise<unknown>) {
    return {
      provider: 'builtIn',
      connectionInfo: { server: 'localhost', database: 'AdventureWorks' },
      getServerInfo: vi.fn(async () => { await loadQueries(); return { engineEditionId: 3 }; }),
      executeSimpleQuery: vi.fn().mockRejectedValue(new Error('query failed')),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function openDetail() {
    const host = {
      postMessage: vi.fn().mockResolvedValue(true),
      log: vi.fn(),
      getExtensionUri: () => extensionUri,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    } as unknown as BridgeHost;
    const bundle = createMessageHandlers(
      host,
      { globalState: { get: vi.fn(), update: vi.fn() }, secrets: {}, extensionUri } as never,
      () => ({ isDbSession: true }) as never,
      outputChannel,
      () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
      vi.fn(),
      vi.fn(),
      false,
      vi.fn(),
    );
    await bundle.handlers['show-detail']({ type: 'show-detail' });
    return bundle;
  }

  const requestStats = () => env.detailListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [] });

  it('two requests read an invalid custom file once and warn once; a setting change reads it again', async () => {
    env.setting = CUSTOM_PATH;
    connectDatabase.mockImplementation(async (dbEnv: { loadQueries: () => Promise<unknown> }) => builtInSession(dbEnv.loadQueries));
    const { cleanup } = await openDetail();

    await requestStats();
    await requestStats();
    expect(connectDatabase).toHaveBeenCalledTimes(2);
    expect(env.customReads).toBe(1);
    expect(env.showWarningMessage).toHaveBeenCalledTimes(1);

    changeSetting('/workspace/other.yaml');
    changeSetting(CUSTOM_PATH);
    await requestStats();
    expect(env.customReads).toBe(2);
    expect(env.showWarningMessage).toHaveBeenCalledTimes(2);

    await cleanup();
    expect(env.configListeners.size).toBe(0);
  });
});
