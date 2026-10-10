/**
 * Localhost Model Context Protocol transport over the shared lineage tool registry.
 *
 * @remarks
 * A pure transport adapter. `tools/list` projects the catalog entries the core tool policy allows
 * for callers without a chat turn, and `tools/call` dispatches through the same registry, Zod
 * boundary validation, phase policy and rejection envelopes the `@lineage` runtime uses. No tool
 * logic lives here: a catalog or policy change reaches MCP clients without touching this module.
 *
 * Security: listens on `127.0.0.1` only, rejects non-localhost `Host`/`Origin` headers
 * (DNS-rebinding protection required by the MCP Streamable HTTP transport), and requires the bearer
 * token through the SDK's `requireBearerAuth` gate (constant-time comparison).
 *
 * VS Code-free so {@link createMcpFetchHandler} is unit-testable without a socket.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import {
  Server,
  ProtocolError,
  OAuthError,
  OAuthErrorCode,
  INVALID_PARAMS,
  createMcpHandler,
  requireBearerAuth,
  hostHeaderValidationResponse,
  originValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type AuthInfo,
  type OAuthTokenVerifier,
  type Tool,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ToolContract } from '../tools/toolDefs';
import type { ExternalToolSource } from '../tools/toolProvider';
import { toModelJsonSchema } from '../tools/jsonSchema';
import { readToolErrorText, rejectionProse } from '../support/toolErrorEnvelope';
import type { Logger } from '../../utils/log';

/** HTTP path of the Streamable HTTP endpoint. */
export const MCP_PATH = '/mcp';

/** Server name announced to MCP clients. */
export const MCP_SERVER_NAME = 'data-lineage';

/** Largest accepted request body; tool inputs are small JSON documents. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Server-level usage guidance returned at initialization.
 *
 * @remarks
 * Cross-tool workflow only; each tool's selection and output guidance is its catalog
 * `modelDescription`, shared with every other surface. Provider-neutral by design.
 */
export const MCP_INSTRUCTIONS = [
  'Data Lineage Viz answers questions about the SQL dependency graph (tables, views, procedures, functions) loaded in the Data Lineage panel of VS Code.',
  'A project must be open in that panel; without one every tool answers no_project_loaded.',
  'Resolve names with lineage_search_objects and use only object ids that tools return.',
  'Use lineage_get_object_detail for one object and lineage_get_scope_bundle for multi-object lineage.',
  'To show a result in the panel, call lineage_get_scope_bundle for the origin, then lineage_present_result with the scope_id it returned. That call returns a view_id; a later lineage_present_result with view_id edits the view, for example with prune_node_ids or add_node_ids.',
  'The tools read the loaded metadata only and never execute SQL.',
  'A result with isError states what was wrong and what to send instead; its structuredContent carries the same as {code, reason, hint, issuePaths}. Correct the call as the text says.',
].join(' ');


/** Configuration of one MCP endpoint. */
export interface McpServerConfig {
  /** The core tools served. */
  readonly source: ExternalToolSource;
  /** Bearer token every request must present. */
  readonly token: string;
  /** Extension version announced as the server version. */
  readonly version: string;
  /** Category-scoped logger; messages carry no tool input or output. */
  readonly logger: Pick<Logger, 'debug' | 'warn'>;
}

/** A listening MCP endpoint. */
export interface RunningMcpServer {
  /** Endpoint URL clients connect to. */
  readonly url: string;
  /** Bound TCP port. */
  readonly port: number;
  /** Stops listening and drops open connections. */
  close(): Promise<void>;
}

/** Client families with distinct connection configuration. */
export type McpClientKind = 'http' | 'stdio';

/** Endpoint facts a client configuration needs. */
export interface McpClientEndpoint {
  /** Endpoint URL. */
  readonly url: string;
  /** Bearer token. */
  readonly token: string;
  /** Executable that runs the stdio proxy (VS Code's runtime with `ELECTRON_RUN_AS_NODE=1`). */
  readonly runtimePath: string;
  /** Stable path of the stdio proxy script. */
  readonly proxyPath: string;
  /** Discovery file the proxy reads the URL and token from. */
  readonly discoveryPath: string;
}

/**
 * Renders the connection configuration for one client family.
 *
 * @param kind - `http` (Streamable HTTP JSON with header) or `stdio`
 *   (proxy command JSON for clients that only launch local processes).
 * @param endpoint - Endpoint facts.
 * @returns Text to paste into the client's configuration. HTTP forms contain the token.
 */
export function buildMcpClientConfig(kind: McpClientKind, endpoint: McpClientEndpoint): string {
  const authorization = `Bearer ${endpoint.token}`;
  switch (kind) {
    case 'http':
      return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: endpoint.url, headers: { Authorization: authorization } } } }, null, 2);
    case 'stdio':
      return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: {
        command: endpoint.runtimePath,
        args: [endpoint.proxyPath, endpoint.discoveryPath],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      } } }, null, 2);
  }
}

/** Maps a catalog effect class to MCP behavior hints; the tools never reach outside the loaded model. */
function annotationsFor(effect: ToolContract['effect']): NonNullable<Tool['annotations']> {
  const readOnly = effect === 'read' || effect === 'scope_store';
  return { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false };
}

/** Projects one catalog entry onto the MCP `Tool` shape. */
function toMcpTool(def: ToolContract): Tool {
  return {
    name: def.name,
    title: def.title,
    description: def.modelDescription,
    inputSchema: toModelJsonSchema(def.inputSchema) as Tool['inputSchema'],
    annotations: annotationsFor(def.effect),
  };
}

/**
 * The MCP result of one tool's JSON text: a rejection envelope becomes a tool execution error whose
 * text is the fault and the recovery (what the model reads) and whose `structuredContent` is the
 * envelope itself; any other text is the result as is.
 */
function toCallToolResult(text: string): { content: [{ type: 'text'; text: string }]; isError: boolean; structuredContent?: Record<string, unknown> } {
  const rejection = readToolErrorText(text);
  if (!rejection) return { content: [{ type: 'text', text }], isError: false };
  return { content: [{ type: 'text', text: rejectionProse(rejection) }], isError: true, structuredContent: { ...rejection } };
}

/**
 * Lifetime stamped on each verified request. The token itself does not expire: the SDK's bearer gate
 * (`verifyBearerToken`) rejects an `AuthInfo` without a numeric `expiresAt` as "Token has no
 * expiration time", so every verification states one that outlives the request.
 */
const VERIFIED_TOKEN_TTL_SECONDS = 60;

/**
 * Verifies the endpoint's static bearer token in constant time.
 *
 * @throws {@link OAuthError} `invalid_token` for any other token, which the SDK gate answers with
 *   `401` and a `WWW-Authenticate: Bearer` challenge.
 */
function staticTokenVerifier(token: string): OAuthTokenVerifier {
  const expected = Buffer.from(token);
  return {
    verifyAccessToken: async (presented): Promise<AuthInfo> => {
      const actual = Buffer.from(presented);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown bearer token.');
      }
      return { token: presented, clientId: MCP_SERVER_NAME, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + VERIFIED_TOKEN_TTL_SECONDS };
    },
  };
}

/**
 * Builds the web-standard request handler: localhost `Host`/`Origin` checks, path routing, bearer
 * authentication, then the stateless MCP handler. Routing precedes authentication so an OAuth
 * metadata probe (`/.well-known/...`) gets `404` and the client reports a token problem instead of
 * starting an OAuth flow.
 *
 * @param config - Tools, token, version and logger of the endpoint.
 * @returns A `fetch`-style handler serving one HTTP request.
 */
export function createMcpFetchHandler(config: McpServerConfig): (request: Request) => Promise<Response> {
  const tools = config.source.tools.map(toMcpTool);
  const names = new Set(tools.map(tool => tool.name));
  const mcp = createMcpHandler(() => {
    const server = new Server(
      { name: MCP_SERVER_NAME, version: config.version },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );
    server.setRequestHandler('tools/list', () => ({ tools }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const { name, arguments: args } = request.params;
      if (!names.has(name)) throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
      return toCallToolResult(await config.source.invoke(name, args ?? {}, ctx.mcpReq.signal));
    });
    return server;
  }, { onerror: error => config.logger.debug(`Request rejected: ${error.message}`) });

  const authenticate = requireBearerAuth({ verifier: staticTokenVerifier(config.token) });
  /** Logs a transport-level refusal once, in one place, without request content or credentials. */
  const refuse = (response: Response, why: string): Response => {
    config.logger.debug(`Refused request (${response.status}): ${why}`);
    return response;
  };
  return async (request) => {
    const denied = hostHeaderValidationResponse(request, localhostAllowedHostnames())
      ?? originValidationResponse(request, localhostAllowedOrigins());
    if (denied) return refuse(denied, 'Host or Origin is not local');
    if (new URL(request.url).pathname !== MCP_PATH) return refuse(new Response(null, { status: 404 }), 'unknown path');
    const auth = await authenticate(request);
    if (auth instanceof Response) return refuse(auth, 'missing or invalid bearer token');
    return mcp.fetch(request, { authInfo: auth });
  };
}

/**
 * Starts the endpoint on `127.0.0.1`.
 *
 * @param config - Endpoint configuration.
 * @param port - TCP port; `0` picks a free port.
 * @returns The running endpoint.
 * @throws The listen error (for example `EADDRINUSE`) when the port cannot be bound.
 */
export function startMcpServer(config: McpServerConfig, port: number): Promise<RunningMcpServer> {
  const handle = createMcpFetchHandler(config);
  const serve = toNodeHandler(
    { fetch: handle },
    { maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror: error => config.logger.warn(`Request failed: ${error.message}`) },
  );
  const http = createServer((req, res) => { void serve(req, res); });
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject);
      http.on('error', error => config.logger.warn(`Server error: ${error.message}`));
      const bound = (http.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${bound}${MCP_PATH}`,
        port: bound,
        close: () => new Promise<void>((done) => {
          http.close(() => done());
          http.closeAllConnections();
        }),
      });
    });
  });
}
