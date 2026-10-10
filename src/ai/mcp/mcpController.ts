/**
 * Session-owned localhost MCP lifecycle: settings, endpoint, private discovery and client commands.
 * Loaded only while the opt-in setting is on at activation. A queue serializes setting changes and
 * disposal. Each start gets a fresh bearer token; another window's endpoint is never adopted.
 * Client configurations are valid only for this session and must be copied after a restart.
 */
import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { buildMcpClientConfig, startMcpServer, type McpClientKind, type RunningMcpServer } from './mcpServer';
import type { McpDiscovery } from './mcpDiscovery';
import type { ExternalToolSource } from '../tools/toolProvider';
import { Logger } from '../../utils/log';
import { notifyInfo, notifyWarning } from '../../utils/notifications';
import { DEFAULT_MCP_ENABLED, DEFAULT_MCP_PORT, MCP_DISCOVERY_FILE, readDeclaredNumericSetting } from '../../configCore';

/** Context key that shows the MCP commands while this bundle is loaded. */
const MCP_LOADED_CONTEXT = 'dataLineageViz.mcpLoaded';
const PROXY_FILE = 'mcp-stdio-proxy.js';

const CLIENT_PICKS: ReadonlyArray<vscode.QuickPickItem & { client: McpClientKind }> = [
  { client: 'http', label: 'HTTP clients', description: 'mcpServers JSON with the URL and Authorization header' },
  { client: 'stdio', label: 'stdio clients', description: 'Clients that only launch local commands' },
];

/** The endpoint state the settings ask for. */
function readMcpSettings(): { enabled: boolean; port: number } {
  const config = vscode.workspace.getConfiguration('dataLineageViz');
  return {
    enabled: config.get<boolean>('mcp.enabled', DEFAULT_MCP_ENABLED),
    port: readDeclaredNumericSetting(config, 'mcp.port', DEFAULT_MCP_PORT),
  };
}

/**
 * Registers the MCP endpoint lifecycle and the Copy MCP Client Configuration command.
 *
 * @param context - Extension context (global storage, extension path and version).
 * @param outputChannel - Log channel.
 * @param source - The core tools served, dispatched through the shared registry.
 * @returns A disposable that stops the endpoint and unregisters the commands.
 */
export function registerMcpServer(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
  source: ExternalToolSource,
): vscode.Disposable {
  const logger = Logger.create(outputChannel, 'MCP');
  const storagePath = join(context.globalStorageUri.fsPath, `mcp-session-${randomUUID()}`);
  const discoveryPath = join(storagePath, MCP_DISCOVERY_FILE);
  const proxyPath = join(storagePath, PROXY_FILE);
  const bundledProxyPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcpStdioProxy.js').fsPath;
  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  let running: { server: RunningMcpServer; token: string } | undefined;
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  /** Runs one lifecycle step after every earlier one; a failed step is logged and the queue continues. */
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    queue = queue.then(step).catch(err => logger.error('MCP server lifecycle', err));
    return queue;
  };

  /**
   * Installs the stdio proxy, then publishes the endpoint atomically, so the proxy never reads a
   * half-written file and a published endpoint never pairs with a stale or missing proxy.
   */
  const publishDiscovery = async (discovery: McpDiscovery): Promise<void> => {
    await mkdir(storagePath, { recursive: true, mode: 0o700 });
    await copyFile(bundledProxyPath, proxyPath);
    const staged = `${discoveryPath}.${process.pid}.tmp`;
    await writeFile(staged, JSON.stringify(discovery), { mode: 0o600 });
    await chmod(staged, 0o600);
    await rename(staged, discoveryPath);
  };

  const stop = async (): Promise<void> => {
    if (!running) return;
    rmSync(storagePath, { recursive: true, force: true });
    const { server } = running;
    running = undefined;
    await server.close();
    logger.info('Server stopped');
  };

  /** Starts only this session's endpoint; a busy port is a startup failure. */
  const start = async (port: number): Promise<void> => {
    let token: string;
    let server: RunningMcpServer;
    try {
      token = randomBytes(32).toString('base64url');
      server = await startMcpServer({ source, token, version, logger }, port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        notifyWarning(logger, 'Start MCP server', `Data Lineage: MCP port ${port} is in use. Close the other server or choose another port, then reload or change the MCP setting to start this session.`, { port: String(port) });
        return;
      }
      notifyWarning(logger, 'Start MCP server', `Data Lineage: the MCP server could not start (${err instanceof Error ? err.message : String(err)}).`, { port: String(port) });
      return;
    }
    try {
      await publishDiscovery({ url: server.url, token });
    } catch (err) {
      // An endpoint stdio clients cannot find is not served; changing an MCP setting or reloading starts over.
      await server.close();
      rmSync(storagePath, { recursive: true, force: true });
      notifyWarning(logger, 'Start MCP server', `Data Lineage: the MCP server could not publish its endpoint (${err instanceof Error ? err.message : String(err)}).`, { port: String(port) });
      return;
    }
    if (disposed) {
      await server.close();
      rmSync(storagePath, { recursive: true, force: true });
      return;
    }
    running = { server, token };
    logger.info(`Server listening on ${server.url} with ${source.tools.length} tools`);
  };

  /** Brings the endpoint to the configured state; a no-op when it already matches. */
  const reconcile = (): Promise<void> => enqueue(async () => {
    if (disposed) return;
    const { enabled, port } = readMcpSettings();
    if (enabled && running?.server.port === port) return;
    await stop();
    if (enabled) {
      await start(port);
    }
  });

  const copyConfig = async (): Promise<void> => {
    const { enabled } = readMcpSettings();
    if (!enabled) {
      notifyWarning(logger, 'Copy MCP client configuration', 'Data Lineage: the MCP server is off. Run "Data Lineage: Toggle MCP Server" first.');
      return;
    }
    if (!running) {
      notifyWarning(logger, 'Copy MCP client configuration', 'Data Lineage: this session has no running MCP server. Check the startup warning and MCP port setting.');
      return;
    }
    // A remote window's runtime path changes with every VS Code update, and only remote clients reach it.
    const picks = vscode.env.remoteName ? CLIENT_PICKS.filter(pick => pick.client !== 'stdio') : CLIENT_PICKS;
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'MCP client to configure' });
    if (!pick || !running) return;
    await vscode.env.clipboard.writeText(buildMcpClientConfig(pick.client, {
      url: running.server.url,
      token: running.token,
      runtimePath: process.execPath,
      proxyPath,
      discoveryPath,
    }));
    const secret = ' Copy it again after restarting the MCP server or reloading this window.' + (pick.client === 'http' ? ' It contains the server token; keep it private.' : '');
    const remote = vscode.env.remoteName
      ? ` This window runs on the remote host (${vscode.env.remoteName}); only MCP clients on that host can connect.`
      : '';
    notifyInfo(logger, 'Copy MCP client configuration', `Data Lineage: ${pick.label} configuration copied.${secret}${remote}`);
  };

  void reconcile();
  void vscode.commands.executeCommand('setContext', MCP_LOADED_CONTEXT, true);
  const disposables = [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dataLineageViz.mcp')) void reconcile();
    }),
    vscode.commands.registerCommand('dataLineageViz.copyMcpConfig', copyConfig),
  ];
  return new vscode.Disposable(() => {
    disposed = true;
    for (const d of disposables) d.dispose();
    // Synchronous: the extension host may exit before a queued step runs.
    rmSync(storagePath, { recursive: true, force: true });
    void enqueue(stop);
  });
}
