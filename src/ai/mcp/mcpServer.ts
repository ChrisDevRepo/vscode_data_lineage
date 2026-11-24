/**
 * Local MCP server: Streamable HTTP on 127.0.0.1 inside the extension host, for AI clients on the
 * same machine. It is live only while `mcp.enabled` is on; every request passes
 * the SDK's Host and Origin checks (DNS rebinding) and a bearer token held in SecretStorage.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as vscode from 'vscode';
import {
  OAuthError,
  OAuthErrorCode,
  McpServer,
  type CallToolResult,
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
import { renderRejection, type RejectedCall } from '../agent/toolAttempt';
import { Logger } from '../../utils/log';
import { notifyWarning } from '../../utils/notifications';
import { readToolError } from '../support/toolErrorEnvelope';
import { toModelJsonSchema } from '../tools/jsonSchema';
import { MCP_TOOL_DEFS } from '../tools/toolDefs';
import { buildAiToolRegistry, type AnalysisSettings } from '../tools/toolProvider';
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
  host: { getStoredRun?: StoredRunReader; analysisSettings: () => AnalysisSettings };
}

/** Every served tool reads the loaded project: it changes nothing and touches nothing outside. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;

/**
 * The graph preview changes only what the graph view shows; the same call shows the same view.
 */
const VIEW_ANNOTATIONS = { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false } as const;

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
 * One tool answer as the MCP result. A refusal is `isError` with the text the chat serves at its
 * first feedback level ({@link renderRejection}), so a client model reads the same reason and hint;
 * the envelope (`code`, `issuePaths`, `detail`) rides in `structuredContent`, which the spec allows
 * without an `outputSchema`. The rendered rejection text replaces the serialized JSON TextContent
 * that the spec's tools page (server/tools, structured content) recommends alongside it, because
 * that text is what the client model reads. `structuredContent` is supplementary: Claude Code
 * passes it neither to the model nor into its transcript.
 */
function toMcpResult(text: string, call: RejectedCall): CallToolResult {
  const rejection = readToolError(JSON.parse(text));
  return rejection
    ? { content: [{ type: 'text', text: renderRejection(rejection, call) }], structuredContent: { ...rejection }, isError: true }
    : { content: [{ type: 'text', text }], isError: false };
}

/** The graph preview's author for an MCP call: the stateless server has no client handshake. */
const MCP_CALLER_LABEL = 'MCP client';

/** The names the MCP server serves, which the registry's stage policy and hints are told. */
const SERVED_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_DEFS.map(def => def.name));

/**
 * One stateless MCP server per request, serving the titled entries of the shared catalog. Each
 * call builds its own registry bound to the request's abort signal, so a cancel or a closed
 * connection stops that call's handler; the chat's stage never gates it and no turn token budget
 * limits it (`budget: null`).
 */
function createLineageMcpServer(version: string, tools: McpToolSource): McpServer {
  const server = new McpServer({ name: SERVER_SLUG, title: SERVER_LABEL, version });
  for (const def of MCP_TOOL_DEFS) {
    server.registerTool(def.name, {
      title: def.title,
      description: def.modelDescription,
      inputSchema: fromJsonSchema(toModelJsonSchema(def.inputSchema), acceptAll),
      annotations: def.effect === 'read' ? READ_ONLY_ANNOTATIONS : VIEW_ANNOTATIONS,
    }, async (args, ctx) => {
      const registry = buildAiToolRegistry(tools.getSession, tools.outputChannel, tools.getPanel, undefined, { ...tools.host, signal: ctx.mcpReq.signal, budget: null, served: SERVED_TOOLS, authorName: MCP_CALLER_LABEL });
      return toMcpResult(await registry.invoke(def.name, args), { toolName: def.name, schema: () => def.inputSchema });
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
 * the three commands. The server follows `mcp.enabled` alone.
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
    vscode.commands.registerCommand('dataLineageViz.mcp.enable', async () => {
      await vscode.workspace.getConfiguration('dataLineageViz.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
      const pick = await vscode.window.showInformationMessage('Data Lineage: MCP server enabled.', 'Show servers');
      if (pick === 'Show servers') await vscode.commands.executeCommand('workbench.mcp.listServer');
    }),
    vscode.commands.registerCommand('dataLineageViz.mcp.rotateToken', async () => {
      if (!service.endpoint) {
        void vscode.window.showInformationMessage('Data Lineage: run "Data Lineage: Enable MCP Server" first.');
        return;
      }
      await service.rotateToken();
      void vscode.window.showInformationMessage('Data Lineage: MCP token rotated. Copy the MCP config again for clients outside VS Code.');
    }),
    vscode.commands.registerCommand('dataLineageViz.mcp.copyConfig', async () => {
      const endpoint = service.endpoint;
      if (!endpoint) {
        void vscode.window.showInformationMessage('Data Lineage: run "Data Lineage: Enable MCP Server" first.');
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
    // Complete here: forwarding a definition to Copilot may skip `resolveMcpServerDefinition`.
    provideMcpServerDefinitions: () => {
      const endpoint = service.endpoint;
      return endpoint
        ? [new vscode.McpHttpServerDefinition(SERVER_LABEL, vscode.Uri.parse(endpoint.url), { Authorization: `Bearer ${endpoint.token}` })]
        : [];
    },
  }));

  void refresh();
}
