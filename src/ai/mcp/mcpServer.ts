/**
 * Local MCP server: Streamable HTTP on 127.0.0.1 inside the extension host, for AI clients on the
 * same machine. It is live only while `ai.enabled` and `mcp.enabled` are on; every request passes
 * the SDK's Host and Origin checks (DNS rebinding) and a bearer token held in SecretStorage.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as vscode from 'vscode';
import {
  OAuthError,
  OAuthErrorCode,
  McpServer,
  type JsonSchemaValidatorResult,
  type jsonSchemaValidator,
  createMcpHandler,
  fromJsonSchema,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Logger } from '../../utils/log';
import { notifyWarning } from '../../utils/notifications';
import { readToolError } from '../support/toolErrorEnvelope';
import { toModelJsonSchema } from '../tools/jsonSchema';
import { filterRegistry } from '../tools/registry';
import { TOOL_DEFS } from '../tools/toolDefs';
import { MCP_TOOL_NAMES, buildAiToolRegistry } from '../tools/toolProvider';
import type { StoredRunReader } from '../session/runStore';
import type { AiSession } from '../session/session';

export const DEFAULT_MCP_ENABLED = false;
export const DEFAULT_MCP_PORT = 47633;
/** SecretStorage key of the bearer token. */
export const MCP_TOKEN_KEY = 'dataLineageViz.mcp.token';
const MCP_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const PROVIDER_ID = 'dataLineageViz.mcp';
/** Server name in the protocol and the client config key; the label is its human title. */
const SERVER_SLUG = 'data-lineage-mcp-server';
const SERVER_LABEL = 'Data Lineage';

type SecretsLike = Pick<vscode.SecretStorage, 'get' | 'store'>;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Returns the stored token, or stores a fresh 256-bit one (always fresh when `rotate`). */
async function loadToken(secrets: SecretsLike, rotate: boolean): Promise<string> {
  const stored = rotate ? undefined : await secrets.get(MCP_TOKEN_KEY);
  if (stored) return stored;
  const token = randomBytes(32).toString('base64url');
  await secrets.store(MCP_TOKEN_KEY, token);
  return token;
}

/** What the lineage tools read: the live session, log channel, graph panel and run store. */
export interface McpToolSource {
  getSession: () => AiSession;
  outputChannel: vscode.LogOutputChannel;
  getPanel: () => vscode.WebviewPanel | undefined;
  host?: { getStoredRun?: StoredRunReader };
}

/** Every served tool reads the loaded project: it changes nothing and touches nothing outside. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;

/**
 * The SDK's validator seam, accepting every argument object as is. No SDK parse: the tool's own
 * Zod check is the only one, so raw `arguments` reach it unchanged and its rejection is the answer.
 */
const acceptAll: jsonSchemaValidator = {
  getValidator<T>() {
    return (input: unknown): JsonSchemaValidatorResult<T> => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/**
 * One stateless MCP server per request; the read-only lineage tools are registered on it. Each call
 * builds its own registry bound to the request's abort signal, so a cancel or a closed connection
 * stops that call's handler.
 */
function createLineageMcpServer(version: string, tools: McpToolSource): McpServer {
  const server = new McpServer({ name: SERVER_SLUG, title: SERVER_LABEL, version });
  for (const def of TOOL_DEFS.filter(candidate => MCP_TOOL_NAMES.has(candidate.name))) {
    server.registerTool(def.name, {
      title: 'title' in def ? def.title : undefined,
      description: def.modelDescription,
      inputSchema: fromJsonSchema(toModelJsonSchema(def.inputSchema), acceptAll),
      annotations: READ_ONLY_ANNOTATIONS,
    }, async (args, ctx) => {
      const registry = filterRegistry(
        buildAiToolRegistry(tools.getSession, tools.outputChannel, tools.getPanel, undefined, { ...tools.host, signal: ctx.mcpReq.signal }),
        MCP_TOOL_NAMES,
      );
      const text = await registry.invoke(def.name, args);
      return { content: [{ type: 'text', text }], isError: readToolError(JSON.parse(text)) !== null };
    });
  }
  return server;
}

/** Starts the listener; rejects with the Node error (`EADDRINUSE` when the port is taken). */
function listen(port: number, getToken: () => string, version: string, tools: McpToolSource): Promise<Server> {
  const mcp = createMcpHandler(() => createLineageMcpServer(version, tools));
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(presented) {
        if (!timingSafeEqual(digest(presented), digest(getToken()))) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid bearer token');
        }
        return { token: presented, clientId: 'local-mcp-client', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 60 };
      },
    },
  });
  const handle = toNodeHandler({
    fetch: async (request) => {
      const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames())
        ?? originValidationResponse(request, localhostAllowedOrigins());
      if (rejected) return rejected;
      const auth = await gate(request);
      return auth instanceof Response ? auth : mcp.fetch(request, { authInfo: auth });
    },
  });
  const server = createServer((req, res) => { void handle(req, res); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, MCP_HOST, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** Lifecycle of the listener and its token; no `vscode` runtime dependency besides the types. */
export class McpService {
  private server: Server | undefined;
  private port = 0;
  private token = '';
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      secrets: SecretsLike;
      logger: Logger;
      version: string;
      onPortInUse: (port: number) => void;
      onChange: () => void;
      tools: McpToolSource;
    },
  ) {}

  /** The running endpoint, or undefined while the server is off. */
  get endpoint(): { url: string; token: string } | undefined {
    return this.server ? { url: `http://${MCP_HOST}:${this.port}${MCP_PATH}`, token: this.token } : undefined;
  }

  /** Brings the listener in line with the settings: off closes it, a new port restarts it. */
  apply(enabled: boolean, port: number): Promise<void> {
    return this.serialize(async () => {
      if (this.server && (!enabled || port !== this.port)) await this.stop();
      if (enabled && !this.server) await this.start(port);
    });
  }

  /** Replaces the stored token; clients holding the old one get 401 until reconfigured. */
  rotateToken(): Promise<void> {
    return this.serialize(async () => {
      this.token = await loadToken(this.deps.secrets, true);
      this.deps.logger.info('MCP token rotated');
      this.deps.onChange();
    });
  }

  dispose(): Promise<void> {
    return this.serialize(() => this.stop());
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async start(port: number): Promise<void> {
    this.token = await loadToken(this.deps.secrets, false);
    try {
      this.server = await listen(port, () => this.token, this.deps.version, this.deps.tools);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        this.deps.logger.warn(`MCP server not started — port ${port} is in use`);
        this.deps.onPortInUse(port);
        return;
      }
      throw err;
    }
    this.port = port;
    this.deps.logger.info(`MCP server listening on ${MCP_HOST}:${port}`);
    this.deps.onChange();
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.deps.logger.info('MCP server stopped');
    this.deps.onChange();
  }
}

/** The client config JSON that carries the bearer token. */
function clientConfig(endpoint: { url: string; token: string }): string {
  return JSON.stringify({
    mcpServers: {
      [SERVER_SLUG]: {
        type: 'http',
        url: endpoint.url,
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    },
  }, null, 2);
}

/**
 * Wires the service to the editor: the `mcp.*` settings, the VS Code server definition provider and
 * the two commands. Call only when AI is enabled.
 */
export function registerMcp(context: vscode.ExtensionContext, tools: McpToolSource): void {
  const logger = Logger.create(tools.outputChannel, 'AI');
  const changed = new vscode.EventEmitter<void>();
  const service = new McpService({
    secrets: context.secrets,
    logger,
    version: String(context.extension.packageJSON.version),
    onPortInUse: (port) => notifyWarning(
      logger,
      'Start MCP server',
      `Data Lineage: MCP port ${port} is in use, probably by another VS Code window. `
      + 'Close that window or change dataLineageViz.mcp.port.',
    ),
    onChange: () => changed.fire(),
    tools,
  });
  const refresh = (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('dataLineageViz.mcp');
    return service.apply(cfg.get('enabled', DEFAULT_MCP_ENABLED), cfg.get('port', DEFAULT_MCP_PORT))
      .catch((err: unknown) => logger.error('start MCP server', err));
  };

  context.subscriptions.push(
    changed,
    { dispose: () => { void service.dispose(); } },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dataLineageViz.mcp')) void refresh();
    }),
    vscode.commands.registerCommand('dataLineageViz.mcp.rotateToken', async () => {
      if (!service.endpoint) {
        void vscode.window.showInformationMessage('Data Lineage: turn on dataLineageViz.mcp.enabled first.');
        return;
      }
      await service.rotateToken();
      void vscode.window.showInformationMessage('Data Lineage: MCP token rotated. Copy the MCP config again for clients outside VS Code.');
    }),
    vscode.commands.registerCommand('dataLineageViz.mcp.copyConfig', async () => {
      const endpoint = service.endpoint;
      if (!endpoint) {
        void vscode.window.showInformationMessage('Data Lineage: turn on dataLineageViz.mcp.enabled first.');
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        'The MCP config contains the access token. The client writes it into its own config file, '
        + 'so anyone who can read that file can query your lineage. Copy it?',
        { modal: true },
        'Copy',
      );
      if (pick === 'Copy') await vscode.env.clipboard.writeText(clientConfig(endpoint));
    }),
  );

  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const endpoint = service.endpoint;
      return endpoint ? [new vscode.McpHttpServerDefinition(SERVER_LABEL, vscode.Uri.parse(endpoint.url))] : [];
    },
    resolveMcpServerDefinition: (server) => {
      const endpoint = service.endpoint;
      if (!endpoint || !(server instanceof vscode.McpHttpServerDefinition)) return undefined;
      server.headers = { Authorization: `Bearer ${endpoint.token}` };
      return server;
    },
  }));

  void refresh();
}
