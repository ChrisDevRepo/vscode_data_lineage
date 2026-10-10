/** Session-owned controller lifecycle against mocked VS Code APIs and real SDK localhost sockets. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = vi.hoisted(() => ({
  copyGate: undefined as Promise<void> | undefined,
  copyEntered: false,
  settings: new Map<string, unknown>(),
  controllers: [] as Array<() => void>,
  listeners: [] as Array<(e: { affectsConfiguration: (section: string) => boolean }) => void>,
  commands: new Map<string, () => Promise<void>>(),
  warnings: [] as string[],
  infos: [] as string[],
  clipboard: '',
  pickLabel: 'HTTP clients',
  offeredPicks: [] as string[],
  remoteName: undefined as string | undefined,
  focused: false,
  executed: [] as unknown[][],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
    host.copyEntered = true;
    await host.copyGate;
    return fs.copyFile(...args);
  } };
});

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => (host.settings.has(key) ? host.settings.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        host.settings.set(key, value);
        for (const listener of host.listeners) listener({ affectsConfiguration: section => section === 'dataLineageViz.mcp' });
      },
    }),
    onDidChangeConfiguration: (listener: (typeof host.listeners)[number]) => {
      host.listeners.push(listener);
      return { dispose: () => { host.listeners = host.listeners.filter(item => item !== listener); } };
    },
  },
  window: {
    state: { get focused() { return host.focused; } },
    showWarningMessage: (message: string) => { host.warnings.push(message); },
    showInformationMessage: (message: string) => { host.infos.push(message); },
    showErrorMessage: () => undefined,
    showQuickPick: async (items: Array<{ label: string }>) => {
      host.offeredPicks = items.map(item => item.label);
      return items.find(item => item.label === host.pickLabel);
    },
  },
  commands: {
    executeCommand: async (...args: unknown[]) => { host.executed.push(args); },
    registerCommand: (id: string, run: () => Promise<void>) => {
      host.commands.set(id, run);
      return { dispose: () => undefined };
    },
  },
  env: {
    clipboard: { writeText: async (text: string) => { host.clipboard = text; } },
    get remoteName() { return host.remoteName; },
  },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }) },
  ConfigurationTarget: { Global: 1 },
  Disposable: class { constructor(private readonly release: () => void) {} dispose(): void { this.release(); } },
}));

import { registerMcpServer } from '../../../src/ai/mcp/mcpController';
import { parseMcpDiscovery } from '../../../src/ai/mcp/mcpDiscovery';

const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A free localhost port in the setting's range. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Changes a setting the way the Settings UI does, firing the configuration listeners. */
const setSetting = async (key: string, value: unknown) => (await import('vscode')).workspace.getConfiguration().update(key, value);

/** Waits until every queued lifecycle step has run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

/** Polls until `check` holds; the controller reconciles asynchronously, so a fixed wait races a loaded machine. */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const discoveryFiles = () => existsSync(storage) ? readdirSync(storage, { recursive: true }).map(String).filter(file => file.endsWith('mcp-server.json')).map(file => join(storage, file)) : [];
const discoveryFile = () => discoveryFiles()[0] ?? join(storage, 'mcp-server.json');
const published = () => existsSync(discoveryFile());

let dir: string;
let storage: string;
let secrets: Map<string, string>;
let disposeController: (() => void) | undefined;

function startController(): void {
  const extensionPath = join(dir, 'extension');
  mkdirSync(join(extensionPath, 'out'), { recursive: true });
  writeFileSync(join(extensionPath, 'out', 'mcpStdioProxy.js'), '// proxy');
  const context = {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { secrets.set(key, value); },
      delete: async (key: string) => { secrets.delete(key); },
    },
    globalStorageUri: { fsPath: storage },
    extensionUri: { fsPath: extensionPath },
    extension: { packageJSON: { version: '1.2.6' } },
  };
  const source = { tools: [], invoke: async () => '{}' };
  const disposable = registerMcpServer(context as never, channel as never, source);
  disposeController = () => disposable.dispose();
  host.controllers.push(disposeController);
}

const status = async (port: number): Promise<number | 'refused'> => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).status;
  } catch {
    return 'refused';
  }
};

/** Runs a real SDK initialize request with the published session credentials. */
const authenticatedStatus = async (port: number, token: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'controller-test', version: '1' },
  } }),
})).status;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lineage-mcp-controller-'));
  storage = join(dir, 'storage');
  secrets = new Map();
  host.copyGate = undefined;
  host.copyEntered = false;
  host.controllers.length = 0;
  host.settings.clear();
  host.listeners.length = 0;
  host.commands.clear();
  host.warnings.length = 0;
  host.infos.length = 0;
  host.clipboard = '';
  host.remoteName = undefined;
  host.focused = false;
  host.executed.length = 0;
  channel.info.mockClear();
});

afterEach(async () => {
  for (const dispose of host.controllers) dispose();
  disposeController = undefined;
  await settle();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP controller', () => {
  it('shows its commands once loaded, and refuses to copy a configuration while off', async () => {
    startController();
    await settle();
    expect(host.executed).toContainEqual(['setContext', 'dataLineageViz.mcpLoaded', true]);
    expect(host.commands.has('dataLineageViz.toggleMcpServer')).toBe(false);
    expect(existsSync(discoveryFile())).toBe(false);
    await host.commands.get('dataLineageViz.copyMcpConfig')!();
    expect(host.warnings.at(-1)).toMatch(/MCP server is off/);
    expect(host.clipboard).toBe('');
  });

  it('starts with a user-only discovery file, and turning off stops it and revokes the token', async () => {
    const port = await freePort();
    host.settings.set('mcp.port', port);
    startController();
    await setSetting('mcp.enabled', true);
    await until(published, 'the endpoint to be published');

    expect(await status(port)).toBe(401);
    const discoveryPath = discoveryFile();
    const discovery = parseMcpDiscovery(readFileSync(discoveryPath, 'utf8'));
    expect(discovery).toEqual({ url: `http://127.0.0.1:${port}/mcp`, token: expect.any(String) });
    expect(await authenticatedStatus(port, discovery!.token)).toBe(200);
    if (process.platform !== 'win32') expect(statSync(discoveryPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(discoveryFile(), '..', 'mcp-stdio-proxy.js'))).toBe(true);

    await host.commands.get('dataLineageViz.copyMcpConfig')!();
    expect(host.clipboard).toContain(`Bearer ${discovery!.token}`);

    await setSetting('mcp.enabled', false);
    await until(() => !published(), 'the endpoint to be withdrawn');
    expect(await status(port)).toBe('refused');
    expect(existsSync(discoveryPath)).toBe(false);
    expect(secrets.has('dataLineageViz.mcp.token')).toBe(false);
  });

  it('does not access persistent token storage, even when it is unavailable', async () => {
    const port = await freePort();
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', port);
    vi.spyOn(secrets, 'get').mockImplementation(() => { throw new Error('storage unavailable'); });
    startController();
    await until(published, 'the session endpoint to be published');
    expect(await status(port)).toBe(401);
    expect(secrets.size).toBe(0);
  });

  it('publishes no endpoint when the stdio proxy cannot be copied', async () => {
    const port = await freePort();
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', port);
    startController();
    rmSync(join(dir, 'extension', 'out', 'mcpStdioProxy.js'));
    await until(() => host.warnings.length > 0, 'the publish warning');
    expect(existsSync(join(discoveryFile(), '..', 'mcp-stdio-proxy.js'))).toBe(false);
    expect(existsSync(discoveryFile())).toBe(false);
    expect(await status(port)).toBe('refused');
    expect(host.warnings.at(-1)).toMatch(/could not publish its endpoint/);
  });

  it('uses a new session token after the owning controller restarts', async () => {
    const port = await freePort();
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', port);
    startController();
    await until(published, 'the endpoint to be published');
    const token = parseMcpDiscovery(readFileSync(discoveryFile(), 'utf8'))!.token;
    expect(token).toBeDefined();
    disposeController!();
    await until(() => !published(), 'the endpoint to be withdrawn');
    startController();
    await until(published, 'the endpoint to be published again');
    const restartedToken = parseMcpDiscovery(readFileSync(discoveryFile(), 'utf8'))!.token;
    expect(restartedToken).not.toBe(token);
    expect(await authenticatedStatus(port, token)).toBe(401);
    expect(await authenticatedStatus(port, restartedToken)).toBe(200);
    expect(secrets.size).toBe(0);
  });

  it('reports a busy port at startup without scheduling takeover', async () => {
    const port = await freePort();
    const blocker: Server = await new Promise(resolve => { const s = createServer().listen(port, '127.0.0.1', () => resolve(s)); });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      host.settings.set('mcp.enabled', true);
      host.settings.set('mcp.port', port);
      startController();
      await until(() => host.warnings.length > 0, 'the busy-port warning');
      expect(host.warnings.at(-1)).toMatch(/port .* is in use/);
      expect(published()).toBe(false);
      expect(secrets.size).toBe(0);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
      await new Promise(resolve => blocker.close(resolve));
    }
  });

  it('keeps separate session discovery and tokens when two controllers use different ports', async () => {
    const firstPort = await freePort();
    const secondPort = await freePort();
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', firstPort);
    startController();
    await until(published, 'the first session endpoint');
    const firstPath = discoveryFile();
    const first = parseMcpDiscovery(readFileSync(firstPath, 'utf8'))!;
    const stopFirst = disposeController!;
    host.settings.set('mcp.port', secondPort);
    startController();
    await until(() => discoveryFiles().length === 2, 'separate session endpoints');
    const secondPath = discoveryFiles().find(path => path !== firstPath)!;
    const second = parseMcpDiscovery(readFileSync(secondPath, 'utf8'))!;
    expect(first.token).not.toBe(second.token);
    expect(second.url).toBe(`http://127.0.0.1:${secondPort}/mcp`);
    stopFirst();
    await until(() => !existsSync(firstPath), 'the first session withdrawal');
    expect(readFileSync(secondPath, 'utf8')).toBe(JSON.stringify(second));
    expect(await status(firstPort)).toBe('refused');
    expect(await status(secondPort)).toBe(401);
    expect(secrets.size).toBe(0);
  });

  it('a simultaneous busy-port controller cannot change the owner credentials or copy them', async () => {
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', await freePort());
    startController();
    startController();
    await until(() => published() && host.warnings.length > 0, 'one owner and one failed start');
    const before = readFileSync(discoveryFile(), 'utf8');
    expect(discoveryFiles()).toHaveLength(1);
    expect(secrets.size).toBe(0);
    // The most recently registered copy command belongs to the second controller.
    await host.commands.get('dataLineageViz.copyMcpConfig')!();
    expect(host.clipboard).toBe('');
    expect(host.warnings.at(-1)).toMatch(/this session has no running MCP server/);
    expect(readFileSync(discoveryFile(), 'utf8')).toBe(before);
  });

  it('disposal during startup leaves no endpoint or private discovery directory', async () => {
    const port = await freePort();
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', port);
    let release!: () => void;
    host.copyGate = new Promise(resolve => { release = resolve; });
    startController();
    await until(() => host.copyEntered, 'publication to enter the filesystem');
    disposeController!();
    release();
    await until(async () => await status(port) === 'refused' && !published()
      && (!existsSync(storage) || readdirSync(storage).length === 0), 'startup and queued shutdown to settle');
    expect(await status(port)).toBe('refused');
    expect(published()).toBe(false);
    expect(existsSync(storage) ? readdirSync(storage) : []).toEqual([]);
  });

  it('offers no stdio configuration in a remote window', async () => {
    host.settings.set('mcp.enabled', true);
    host.settings.set('mcp.port', await freePort());
    host.remoteName = 'ssh-remote';
    startController();
    await until(published, 'the endpoint to be published');
    await host.commands.get('dataLineageViz.copyMcpConfig')!();
    expect(host.offeredPicks).not.toContain('stdio clients');
    expect(host.infos.at(-1)).toMatch(/remote host \(ssh-remote\)/);
  });
});
