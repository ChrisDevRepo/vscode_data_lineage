/**
 * Pins the wizard's switch to the built-in connection: the host handler writes the provider setting
 * globally and answers with the refreshed connection status.
 */
import { describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    sections: [] as string[],
  };
});

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      getConfiguration: (section: string) => {
        cfg.sections.push(section);
        return { get: (k: string, d: unknown) => cfg.values[k] ?? d, update: cfg.update, inspect: () => ({}) };
      },
    },
    extensions: { getExtension: () => undefined },
  };
});

const connectDatabase = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));

const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');
const { createBridgeHost } = await import('../../../../src/bridge/host');

function handlers() {
  const posted: Array<Record<string, unknown>> = [];
  const host = {
    postMessage: vi.fn((m: Record<string, unknown>) => { posted.push(m); return Promise.resolve(true); }),
    log: vi.fn(),
    withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => Promise<void>) =>
      task({ report: vi.fn() }, { isCancellationRequested: false }),
    getConfiguration: vi.fn().mockReturnValue({ get: () => undefined }),
  };
  const bundle = createMessageHandlers(
    host as never,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => ({ model: null, uiState: {}, renderState: null }) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() } as never,
    () => ({ schemaVersion: 1, projects: [] }) as never,
    vi.fn().mockResolvedValue(undefined),
    vi.fn(),
    false,
    vi.fn(),
  );
  return { handlers: bundle.handlers, posted, host };
}

describe('use-builtin-connection', () => {
  it('sets dataLineageViz.database.connectionProvider to builtIn at global scope and re-posts the status', async () => {
    const { handlers: h, posted } = handlers();

    await h['use-builtin-connection']({ type: 'use-builtin-connection' } as never);

    expect(cfg.sections).toContain('dataLineageViz.database');
    expect(cfg.update).toHaveBeenCalledTimes(1);
    expect(cfg.update).toHaveBeenCalledWith('connectionProvider', 'builtIn', 1);
    expect(posted.find((m) => m.type === 'mssql-status')).toMatchObject({ type: 'mssql-status', available: true });
  });
});

describe('db-connect failures outside the connection error path', () => {
  it('redacts secrets in the log and in the message posted to the webview', async () => {
    connectDatabase.mockRejectedValue(new Error('Bad connection string Password=abc123;Server=x'));
    const { handlers: h, posted, host } = handlers();

    await h['db-connect']({ type: 'db-connect' } as never);

    const error = posted.find((m) => m.type === 'db-error');
    expect(String(error?.message)).not.toContain('abc123');
    expect(String(error?.message)).toContain('Password=[removed]');
    expect(JSON.stringify((host.log as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('abc123');
  });

  it('writes one FAILED line naming the operation and the redacted message through the real host logger', async () => {
    connectDatabase.mockRejectedValue(new Error('Missing schema-preview query Password=abc123;'));
    const lines: string[] = [];
    const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), trace: vi.fn(), appendLine: vi.fn(), error: (m: string) => { lines.push(m); } };
    const host = createBridgeHost({ webview: { postMessage: () => Promise.resolve(true) } } as never, {} as never, channel as never);
    const bundle = createMessageHandlers(
      { ...host, withProgress: (_o: unknown, task: (p: unknown, t: unknown) => Promise<void>) => task({ report: vi.fn() }, { isCancellationRequested: false }) } as never,
      { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
      () => ({ model: null, uiState: {}, renderState: null }) as never,
      channel as never,
      () => ({ schemaVersion: 1, projects: [] }) as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn(),
      false,
      vi.fn(),
    );

    await bundle.handlers['db-connect']({ type: 'db-connect' } as never);

    const failed = lines.filter((l) => l.includes('FAILED:'));
    expect(failed).toEqual(['[DB] FAILED: Connecting — Missing schema-preview query Password=[removed];']);
    expect(lines.join('\n')).not.toContain('abc123');
    expect(lines.join('\n')).not.toContain('undefined');
    expect(lines, 'no stack of the logging site: the redacted text is the whole record').toHaveLength(1);
  });
});

describe('error-level bridge log lines', () => {
  function realHost() {
    const lines: string[] = [];
    const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), trace: vi.fn(), appendLine: vi.fn(), error: (m: string) => { lines.push(m); } };
    const host = createBridgeHost({ webview: { postMessage: () => Promise.resolve(true) } } as never, {} as never, channel as never);
    return { lines, host, channel };
  }

  it('redacts a connection string in the message and in the stack of a caught Error', () => {
    const { lines, host } = realHost();
    const err = new Error('Login failed Server=x;Password=abc123;Database=d');
    err.stack = 'Error: Login failed Server=x;Password=abc123;\n    at connect (driver.js:1:1)\n    at auth Bearer abcdefgh12345678';

    host.log('error', 'Bridge', 'Load project', err);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[Bridge] FAILED: Load project — Login failed Server=x;Password=[removed];Database=d');
    expect(lines[1]).toMatch(/^\[Bridge\] Stack: Error: Login failed Server=x;Password=\[removed\];/);
    expect(lines[1]).toContain('Bearer [token removed]');
    expect(lines.join('\n')).not.toMatch(/abc123|abcdefgh12345678/);
  });

  it('redacts a thrown string, which carries no stack', () => {
    const { lines, host } = realHost();

    host.log('error', 'Dacpac', 'Dacpac visualize', 'rejected pwd=abc123 Bearer abcdefgh12345678');

    expect(lines).toEqual(['[Dacpac] FAILED: Dacpac visualize — rejected pwd=[removed] Bearer [token removed]']);
  });

  it('redacts the operation text', () => {
    const { lines, host } = realHost();

    host.log('error', 'Bridge', 'Load project Password=abc123', 'boom');

    expect(lines).toEqual(['[Bridge] FAILED: Load project Password=[removed] — boom']);
  });

  it.each(['warn', 'info', 'debug'] as const)('redacts a caught driver message carried in %s-level text', (level) => {
    const { host, channel } = realHost();

    host.log(level, 'DB', 'Disconnect failed: Login failed Server=x;Password=abc123; Bearer abcdefgh12345678');

    expect(channel[level]).toHaveBeenCalledTimes(1);
    expect(channel[level]).toHaveBeenCalledWith('[DB] Disconnect failed: Login failed Server=x;Password=[removed]; Bearer [token removed]');
  });

  it.each([
    ['load-project', { type: 'load-project', id: 'missing' }, 'FAILED: Load project — Project not found: missing'],
    ['dacpac-visualize', { type: 'dacpac-visualize', schemas: ['dbo'] }, 'FAILED: Dacpac visualize — Session expired (cachedElements is null)'],
    ['db-visualize', { type: 'db-visualize', schemas: ['dbo'] }, 'FAILED: Database visualize — No stored connection info'],
  ])('%s logs its synthetic failure as message text with no stack of the logging site', async (key, msg, expected) => {
    const { lines, host, channel } = realHost();
    const bundle = createMessageHandlers(
      { ...host, withProgress: (_o: unknown, task: (p: unknown, t: unknown) => Promise<void>) => task({ report: vi.fn() }, { isCancellationRequested: false }) } as never,
      { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
      () => ({ model: null, uiState: {}, renderState: null }) as never,
      channel as never,
      () => ({ schemaVersion: 1, projects: [] }) as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn(),
      false,
      vi.fn(),
    );

    await (bundle.handlers as Record<string, (m: unknown) => Promise<void>>)[key](msg);

    expect(lines).toEqual([expect.stringContaining(expected)]);
    expect(lines.join('\n')).not.toContain('Stack:');
  });
});
