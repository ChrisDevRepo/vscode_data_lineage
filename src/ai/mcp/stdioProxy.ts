/**
 * stdio ↔ Streamable HTTP proxy for MCP clients that only launch local commands.
 *
 * @remarks
 * Standalone script bundled to `out/mcpStdioProxy.js` and run by the client with VS Code's own
 * runtime (`ELECTRON_RUN_AS_NODE=1`), so no Node.js installation is needed. Built from the SDK
 * client package alone: its stdio framing (`ReadBuffer`, `serializeMessage`) faces the client and a
 * `StreamableHTTPClientTransport` the extension's endpoint; messages pass through unchanged and the
 * SDK sets the protocol headers.
 *
 * The endpoint URL and token come from the discovery file (path in argv[2]) when the first message
 * arrives, and again for the next message after an endpoint failure. A failed request is never
 * replayed: the endpoint may already have executed it. The client configuration holds no token.
 * A request the endpoint can no longer answer gets a JSON-RPC error.
 */
import {
  ReadBuffer,
  StreamableHTTPClientTransport,
  serializeMessage,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/client';
import { readMcpDiscoveryFile } from './mcpDiscovery';

/** An endpoint transport. */
interface Endpoint {
  readonly transport: StreamableHTTPClientTransport;
}

const discoveryPath = process.argv[2];
/** The started endpoint; shared by concurrent messages, dropped when it fails. */
let endpoint: Promise<Endpoint> | null = null;
/** Version a 2025-era client negotiated; a reopened endpoint keeps stating it. */
let negotiatedVersion: string | undefined;
/** Requests sent to the endpoint and not yet answered. */
const pending = new Set<RequestId>();

/** Writes one message to the client. */
function reply(message: JSONRPCMessage): void {
  process.stdout.write(serializeMessage(message));
}

/** Answers a request the endpoint could not serve, so the client sees an error instead of a hang. */
function answerUnavailable(id: RequestId, reason: string): void {
  if (!pending.delete(id)) return;
  reply({ jsonrpc: '2.0', id, error: { code: -32000, message: `Data Lineage MCP server unavailable: ${reason}` } });
}

/** Opens the endpoint the discovery file describes, once; `null` while no endpoint runs. */
function connect(): Promise<Endpoint> | null {
  if (endpoint) return endpoint;
  const discovery = readMcpDiscoveryFile(discoveryPath);
  if (!discovery) return null;
  const transport = new StreamableHTTPClientTransport(new URL(discovery.url), {
    requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } },
  });
  const opened = transport.start().then(() => ({ transport }));
  transport.onmessage = (message) => {
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined && !pending.delete(message.id)) return;
    // A 2025-era session states its negotiated version on later requests; 2026-era requests carry it.
    if (isJSONRPCResultResponse(message) && typeof message.result.protocolVersion === 'string') {
      negotiatedVersion = message.result.protocolVersion;
      transport.setProtocolVersion(negotiatedVersion);
    }
    reply(message);
  };
  transport.onerror = () => { if (endpoint === opened) endpoint = null; };
  if (negotiatedVersion) transport.setProtocolVersion(negotiatedVersion);
  endpoint = opened;
  return opened;
}

/** Sends each message once; a later message can reconnect after a transport failure. */
async function forward(message: JSONRPCMessage): Promise<void> {
  const id = isJSONRPCRequest(message) ? message.id : undefined;
  if (id !== undefined) pending.add(id);
  const opening = connect();
  if (!opening) {
    if (id !== undefined) answerUnavailable(id, 'open VS Code with a Data Lineage project and enable dataLineageViz.mcp.enabled.');
    return;
  }
  try {
    const { transport } = await opening;
    await transport.send(message, id === undefined ? undefined : {
      onRequestStreamEnd: () => answerUnavailable(id, 'response stream ended without a reply.'),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (endpoint === opening) endpoint = null;
    if (id !== undefined) answerUnavailable(id, reason);
  }
}

if (!discoveryPath) {
  process.stderr.write('Usage: mcpStdioProxy <discovery-file>\n');
  process.exit(2);
}
const input = new ReadBuffer();
process.stdin.on('data', (chunk: Buffer) => {
  input.append(chunk);
  for (;;) {
    let message: JSONRPCMessage | null;
    try {
      message = input.readMessage();
    } catch (error) {
      // The malformed line is consumed; report it as the SDK stdio transport does and read on.
      process.stderr.write(`Data Lineage MCP proxy: ignored an invalid message (${error instanceof Error ? error.message : String(error)})\n`);
      continue;
    }
    if (!message) break;
    void forward(message);
  }
});
process.stdin.on('end', () => { void endpoint?.then(({ transport }) => transport.close()); });
