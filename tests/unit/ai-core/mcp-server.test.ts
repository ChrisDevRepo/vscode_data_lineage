/**
 * The local MCP server accepts a client only with the bearer token and a local Host and Origin,
 * exists only while the setting is on, never writes the token to a log or an error body, and serves
 * the nine data tools of the shared catalog (each answer the registry's own text, each refusal `isError`
 * with the chat's first-level feedback text and its envelope in `structuredContent`), in the 2025-11-25
 * and the 2026-07-28 revision, whatever stage a chat turn is in.
 */
import { request } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// `lineage_detect_graph_patterns` reads its thresholds through `vscode.workspace`; the shared stub
// has none.
vi.mock('vscode', async importOriginal => {
  const actual = await importOriginal<typeof import('vscode')>();
  return { ...actual, workspace: { ...(actual as { workspace?: object }).workspace, getConfiguration: () => ({ get: () => undefined }) } };
});

import { McpService, MCP_TOKEN_KEY } from '../../../src/ai/mcp/mcpServer';
import type { ToolRejection } from '../../../src/ai/support/toolErrorEnvelope';
import { AiSession } from '../../../src/ai/session/session';
import { filterRegistry, ToolRegistry } from '../../../src/ai/tools/registry';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { TOOL_DEFS } from '../../../src/ai/tools/toolDefs';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { Logger } from '../../../src/utils/log';
import type { DatabaseModel } from '../../../src/engine/types';
import { createHarnessSession, repoPath } from '../../harness/sessionFactory';
import { TOOL_HOST } from '../helpers/toolHost';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } },
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** POSTs `body` (initialize by default); `headers` override the defaults, e.g. to forge a Host. */
function post(url: string, headers: Record<string, string>, body = INITIALIZE, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      signal,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The graph panel as the preview tool sees it: every message it is sent lands in `posted`. */
function panelStub() {
  const posted: unknown[] = [];
  return { posted, reveal: () => undefined, webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } };
}
type PanelStub = ReturnType<typeof panelStub>;

function harness(session = new AiSession(), panel?: PanelStub) {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = (message: string) => { lines.push(message); };
  const channel = { info: log, debug: log, warn: log, error: (message: string) => { lines.push(message); errors.push(message); }, trace: log };
  const store = new Map<string, string>();
  const secrets = {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => { store.set(key, value); },
  };
  const portInUse: number[] = [];
  const service = new McpService({
    secrets,
    logger: Logger.create(channel as never, 'AI'),
    version: '0.0.0-test',
    onPortInUse: (port) => portInUse.push(port),
    onChange: () => undefined,
    tools: { getSession: () => session, outputChannel: channel as never, getPanel: () => panel as never, host: TOOL_HOST },
  });
  return { lines, errors, store, portInUse, service, session, channel: channel as unknown as VSCode.LogOutputChannel };
}

const live: Array<{ service: McpService }> = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(live.splice(0).map(({ service }) => service.dispose()));
});

async function started(session?: AiSession, panel?: PanelStub) {
  const h = harness(session, panel);
  live.push(h);
  const port = await freePort();
  await h.service.apply(true, port);
  const endpoint = h.service.endpoint!;
  return { ...h, port, url: endpoint.url, token: endpoint.token };
}

describe('local MCP server', () => {
  it('initializes with the bearer token and holds a 256-bit token in SecretStorage', async () => {
    const { url, token, store } = await started();
    const res = await post(url, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"serverInfo"');
    expect(Buffer.from(store.get(MCP_TOKEN_KEY)!, 'base64url')).toHaveLength(32);
  });

  it('answers 401 without a token or with a wrong one', async () => {
    const { url } = await started();
    expect((await post(url, {})).status).toBe(401);
    expect((await post(url, { authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('answers 403 for a foreign Origin or Host even with the token', async () => {
    const { url, token } = await started();
    const auth = { authorization: `Bearer ${token}` };
    expect((await post(url, { ...auth, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(url, { ...auth, host: 'evil.example' })).status).toBe(403);
  });

  it('opens no listener while the setting is off and closes it when turned off', async () => {
    const { service, port, url, token } = await started();
    await service.apply(false, port);
    expect(service.endpoint).toBeUndefined();
    await expect(post(url, { authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    const off = harness();
    live.push(off);
    await off.service.apply(false, await freePort());
    expect(off.service.endpoint).toBeUndefined();
  });

  it('reports a port in use and rotation retires the old token', async () => {
    const first = await started();
    const second = harness();
    live.push(second);
    await second.service.apply(true, first.port);
    expect(second.portInUse).toEqual([first.port]);
    expect(second.service.endpoint).toBeUndefined();

    await first.service.rotateToken();
    expect((await post(first.url, { authorization: `Bearer ${first.token}` })).status).toBe(401);
    const rotated = first.service.endpoint!.token;
    expect(rotated).not.toBe(first.token);
    expect((await post(first.url, { authorization: `Bearer ${rotated}` })).status).toBe(200);
  });

  it('keeps the token out of logs and error bodies', async () => {
    const { service, url, token, lines } = await started();
    const bodies = [
      (await post(url, { authorization: `Bearer ${token}x` })).body,
      (await post(url, { authorization: `Bearer ${token}`, origin: 'http://evil.example' })).body,
      (await post(url, {})).body,
    ];
    await service.rotateToken();
    const rotated = service.endpoint!.token;
    const everything = [...lines, ...bodies].join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(rotated);
  });
});

const fixture = () => createHarnessSession({ dacpacPath: repoPath('tests/fixtures/AdventureWorks2025_AI.dacpac'), contextWindow: Number.POSITIVE_INFINITY });

/** The 6 discovery tools; the graph tools (trace, path, preview) are served from the same catalog. */
const TOOL_NAMES = ['get_context', 'get_screen_state', 'search_objects', 'get_object_detail', 'detect_graph_patterns', 'search_ddl'].map((name) => `lineage_${name}`);
const GRAPH_NAMES = ['lineage_get_trace', 'lineage_get_path', 'lineage_create_graph_preview'];

/** One call input per tool on the AdventureWorks fixture. */
const CALLS: Record<string, Record<string, unknown>> = {
  lineage_get_context: {}, lineage_get_screen_state: {}, lineage_search_objects: { query: 'SalesOrderHeader' },
  lineage_get_object_detail: { id: '[Sales].[SalesOrderHeader]' }, lineage_detect_graph_patterns: { type: 'hubs' }, lineage_search_ddl: { query: 'SalesOrderHeader' },
};

/** Starts the server on `session` and connects an SDK client; `call` gives the answer. */
async function connected(session: AiSession, panel?: PanelStub) {
  const s = await started(session, panel);
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
    // MCP 2026-07-28 server/tools: `structuredContent` is the result's JSON value, allowed without an
    // `outputSchema`; a refusal carries its envelope there and its first-level text in `content`.
    return { text, isError: result.isError, rejection: result.structuredContent as ToolRejection | undefined };
  };
  return { ...s, client, call, registry: () => buildAiToolRegistry(() => session, s.channel, () => undefined, undefined, { ...TOOL_HOST, budget: null }) };
}

describe('lineage tools over MCP', () => {
  it('initializes and lists the nine data tools with the catalog text, title and annotations (the graph preview is not read-only)', async () => {
    const { client } = await connected((await fixture()).session);
    expect(client.getServerCapabilities()).toMatchObject({ tools: expect.anything() });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES, ...GRAPH_NAMES].sort());
    for (const tool of tools) {
      const def = TOOL_DEFS.find((candidate) => candidate.name === tool.name)!;
      expect(tool.description, tool.name).toBe(def.modelDescription);
      expect(tool.inputSchema, tool.name).toEqual(toModelJsonSchema(def.inputSchema));
      expect(tool.inputSchema.type, tool.name).toBe('object');
      const undescribed = Object.entries((tool.inputSchema.properties ?? {}) as Record<string, object>).filter(([, schema]) => !('description' in schema));
      expect(undescribed, tool.name).toEqual([]);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toEqual({ readOnlyHint: tool.name !== 'lineage_create_graph_preview', destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.outputSchema, tool.name).toBeUndefined();
    }
    await expect(client.callTool({ name: 'lineage_start_exploration', arguments: {} }).then((result) => result.isError, () => true)).resolves.toBe(true);
  });

  it('answers each tool with the registry text and the expected result on the fixture', async () => {
    const { session } = await fixture();
    const { call, registry } = await connected(session);
    const answers: Record<string, Record<string, any>> = {};
    for (const name of TOOL_NAMES) {
      const answer = await call(name, CALLS[name]!);
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.text, name).toBe(await registry().invoke(name, CALLS[name]));
      answers[name] = JSON.parse(answer.text);
    }
    const nodes = session.model!.nodes.length;
    expect(answers['lineage_get_context']).toMatchObject({ source_type: 'dacpac', model_stats: { nodes, edges: session.model!.edges.length } });
    expect(answers['lineage_get_screen_state']).toMatchObject({ screen: { trace: null, analysis: null, view: { total_nodes: nodes } } });
    expect(answers['lineage_search_objects']).toMatchObject({ name_match: { status: 'unique', ids: ['[sales].[salesorderheader]'] }, by_type: { table: 2 } });
    expect(answers['lineage_get_object_detail']).toMatchObject({ id: '[sales].[salesorderheader]', type: 'table', columns: expect.arrayContaining([expect.objectContaining({ n: 'SalesOrderID', pk: 1 })]) });
    expect(answers['lineage_detect_graph_patterns']!['groups'].length).toBeGreaterThan(0);
    expect(answers['lineage_search_ddl']!['by_object'][0]).toMatchObject({ id: '[sales].[vsalespersonsalesbyfiscalyears]', type: 'view' });
  });

  it('answers every refusal as isError with the registry envelope, not a protocol error (ack or reject: nothing committed, no retry state, a corrected call succeeds)', async () => {
    const { session } = await fixture();
    const panel = panelStub();
    const loaded = await connected(session, panel);
    expect(await loaded.call('lineage_search_objects', { query: 'x', bogus: 1 })).toMatchObject({ isError: true, rejection: { code: 'invalid_input', issuePaths: ['bogus'] } });
    expect(await (await connected(new AiSession())).call('lineage_get_context', {})).toMatchObject({ isError: true, rejection: { code: 'no_project_loaded' } });

    const empty = await connected(new AiSession());
    const noPanel = await connected((await fixture()).session);
    const [order, missing, trace] = ['[Sales].[SalesOrderHeader]', '[dbo].[NoSuchObject]', { upstream_levels: 1, downstream_levels: 1, include_dml: false }] as const;
    const preview = { name: 'Orders', ids: [order] };
    const rows = [
      [loaded, 'lineage_get_object_detail', { id: missing }, 'not_found'],
      [loaded, 'lineage_get_trace', { ...trace, origin: missing }, 'not_found'],
      [loaded, 'lineage_get_path', { start: order, end: missing, include_dml: false }, 'not_found'],
      [loaded, 'lineage_create_graph_preview', { ...preview, ids: [order, missing] }, 'not_found'],
      [loaded, 'lineage_get_path', { start: order, include_dml: false }, 'invalid_input', ['end']],
      [loaded, 'lineage_get_object_detail', { id: 5 }, 'invalid_input', ['id']],
      [empty, 'lineage_get_trace', { ...trace, origin: order }, 'no_project_loaded'],
      [empty, 'lineage_get_path', { start: order, end: order, include_dml: false }, 'no_project_loaded'],
      [empty, 'lineage_create_graph_preview', preview, 'no_project_loaded'],
      [noPanel, 'lineage_create_graph_preview', preview, 'no_project_loaded'],
    ] as const;
    for (const [{ call }, tool, args, code, paths] of rows) {
      const first = await call(tool, args);
      expect(first, tool).toMatchObject({ isError: true, rejection: { code, ...(paths && { issuePaths: paths }) } });
      expect(first.rejection!.issuePaths?.length || first.rejection!.hint || code === 'no_project_loaded', first.text).toBeTruthy();
      // The text is the chat's first-level feedback: it opens with the reason, which states the fault, not the code.
      expect(first.text.startsWith(first.rejection!.reason), first.text).toBe(true);
      expect(first.rejection!.reason, first.text).not.toBe(code);
      if (code === 'not_found') expect(first.rejection!.reason, tool).toContain(missing);
      // No retry counter or limit: the same call again answers the same text, and nothing is posted.
      expect((await call(tool, args)).text, tool).toBe(first.text);
      expect((await call(tool, args)).text, tool).toBe(first.text);
      expect(panel.posted, tool).toEqual([]);
    }

    // A client retries: the wrong id is refused and nothing is posted, the searched id succeeds as in a fresh session.
    expect(await loaded.call('lineage_create_graph_preview', { ...preview, ids: ['SalesOrderHeader'] })).toMatchObject({ rejection: { code: 'not_found' } });
    const [id] = JSON.parse((await loaded.call('lineage_search_objects', { query: 'SalesOrderHeader' })).text).name_match.ids as string[];
    const freshPanel = panelStub();
    const fresh = await (await connected((await fixture()).session, freshPanel)).call('lineage_create_graph_preview', { ...preview, ids: [id] });
    const retried = await loaded.call('lineage_create_graph_preview', { ...preview, ids: [id] });
    expect(retried).toMatchObject({ isError: false, text: fresh.text });
    const untimed = (posted: unknown[]) => posted.map((message: any) => ({ ...message, aiMetadata: { ...message.aiMetadata, createdAt: undefined } }));
    expect(panel.posted).toHaveLength(1);
    expect(untimed(panel.posted)).toEqual(untimed(freshPanel.posted));
  });

  it('credits the graph preview to the caller: the MCP server by its caller label, the chat registry by the model name', async () => {
    const panel = panelStub();
    const { call, session, channel } = await connected((await fixture()).session, panel);
    const preview = { name: 'Orders', ids: ['[Sales].[SalesOrderHeader]'] };
    expect(await call('lineage_create_graph_preview', preview)).toMatchObject({ isError: false });
    expect(panel.posted).toMatchObject([{ aiMetadata: { modelName: 'MCP client' } }]);

    // The chat stage does not offer the preview yet; `served` replaces the stage policy as it does for the MCP server.
    const chatPanel = panelStub();
    const chat = buildAiToolRegistry(() => session, channel, () => chatPanel as never, undefined, { ...TOOL_HOST, served: new Set(['lineage_create_graph_preview']), authorName: 'Chat Model' });
    expect(JSON.parse(await chat.invoke('lineage_create_graph_preview', preview))).toMatchObject({ name: 'Orders' });
    expect(chatPanel.posted).toMatchObject([{ aiMetadata: { modelName: 'Chat Model' } }]);
  });

  it('serves statelessly: a running chat turn gates no tool, its stage changes no answer, and the calls leave session.hopLog unchanged', async () => {
    const { session } = await fixture();
    const idle = await connected((await fixture()).session);
    const [order, trace] = ['[Sales].[SalesOrderHeader]', { origin: '[Sales].[SalesOrderHeader]', upstream_levels: 1, downstream_levels: 1, include_dml: false }] as const;
    const calls: Record<string, Record<string, unknown>> = { ...CALLS, lineage_get_trace: trace, lineage_get_path: { start: order, end: order, include_dml: false } };
    session.activeLmStage = { kind: 'active', mode: 'sm_bb' };
    const running = await connected(session);
    for (const name of [...TOOL_NAMES, 'lineage_get_trace', 'lineage_get_path']) {
      const answer = await running.call(name, calls[name]!);
      expect(answer, name).toMatchObject({ isError: false });
      expect(answer.text, name).toBe((await idle.call(name, calls[name]!)).text);
    }
    expect(session.hopLog, 'the hop log is the chat turn\'s record').toEqual([]);
  });

  it('runs under no discovery budget: what the chat refuses or cuts to fit its turn budget is answered whole', async () => {
    const { session } = await fixture();
    const { call, channel } = await connected(session);
    const chat = buildAiToolRegistry(() => session, channel, () => undefined, undefined, { ...TOOL_HOST, budget: createTurnTokenBudget({ discoveryTokenBudget: 1000 }) });
    const ask = async (name: string, input: Record<string, unknown>) => ({ chat: JSON.parse(await chat.invoke(name, input)), mcp: await call(name, input) });

    const ddl = await ask('lineage_search_ddl', { query: 'a' });
    expect(ddl.chat).toMatchObject({ code: 'over_discovery_budget' });
    expect(ddl.mcp.isError).toBe(false);
    expect(JSON.parse(ddl.mcp.text).by_object.length).toBeGreaterThan(40);

    const hubs = await ask('lineage_detect_graph_patterns', { type: 'hubs', min_degree: 1 });
    expect(hubs.chat).toMatchObject({ groups_omitted: true, total_groups: 104 });
    expect(hubs.mcp.isError).toBe(false);
    expect(JSON.parse(hubs.mcp.text)).toMatchObject({ total_groups: 104, groups: expect.any(Array) });
    expect(hubs.mcp.text).not.toContain('groups_omitted');
  });

  it('serves the 2026-07-28 revision: server/discover lists it and a call carries its per-request envelope, a refusal as isError', async () => {
    const { session } = await fixture();
    const { url, token } = await started(session);
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const rpc = async (method: string, params: Record<string, unknown>, name?: string) => {
      const answer = await post(url, {
        authorization: `Bearer ${token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name && { 'mcp-name': name }),
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } }));
      return { status: answer.status, body: JSON.parse(answer.body) };
    };
    const discovered = await rpc('server/discover', {});
    expect(discovered.status).toBe(200);
    expect(discovered.body.result.supportedVersions).toContain('2026-07-28');
    const listed = await rpc('tools/list', {});
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...TOOL_NAMES, ...GRAPH_NAMES].sort());
    const called = await rpc('tools/call', { name: 'lineage_get_object_detail', arguments: { id: '[Sales].[SalesOrderHeader]' } }, 'lineage_get_object_detail');
    expect(called.body.result).toMatchObject({ isError: false });
    expect(JSON.parse(called.body.result.content[0].text)).toMatchObject({ id: '[sales].[salesorderheader]', type: 'table' });
    const refused = await rpc('tools/call', { name: 'lineage_get_object_detail', arguments: { id: '[dbo].[NoSuchObject]' } }, 'lineage_get_object_detail');
    expect(refused.body.result).toMatchObject({ isError: true, structuredContent: { code: 'not_found' } });
  });

  it('aborts the handler when the connection closes, logging no result and no error', async () => {
    const { session } = await fixture();
    session.model = { ...session.model!, nodes: [...session.model!.nodes, { id: '[dbo].[slow]', name: 'slow', schema: 'dbo', type: 'view', bodyScript: 'a'.repeat(50_000) }] } as DatabaseModel;
    const { url, token, errors, lines } = await started(session);
    const resultLogged = () => lines.some((line) => line.includes('Invoking lineage_search_ddl'));
    const headers = { authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-11-25' };
    const slow = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lineage_search_ddl', arguments: { query: '(a+)+x' } } });
    // A client cancels a stateless call (here 2025-11-25; the 2026-07-28 revision cancels the same way) by aborting its HTTP stream; the server sees a closed socket
    const closing = new AbortController();
    const closed = post(url, headers, slow, closing.signal).catch(() => 'closed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    closing.abort();
    await expect(closed).resolves.toBe('closed');
    // Past the 1s search deadline: a handler that ignored the close would have logged its result.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(resultLogged()).toBe(false);
    expect(errors).toEqual([]);
    // Positive control: the same call left open logs its deadline result.
    expect((await post(url, headers, slow)).status).toBe(200);
    expect(resultLogged()).toBe(true);
  });

  it('guards the registry names it serves and dispatches the raw input unchanged', async () => {
    const registry = new ToolRegistry();
    const tool = { ...TOOL_DEFS[0], execute: (input: unknown) => input };
    registry.register(tool);
    expect(() => { registry.register(tool); }).toThrow(/duplicate/);
    expect(() => registry.invoke('lineage_not_registered', {})).toThrow(/no tool registered/i);
    expect(() => filterRegistry(registry, new Set()).invoke(tool.name, {})).toThrow(/no tool registered/i);
    const original = { nested: { value: 'original' } };
    expect(await registry.invoke(tool.name, original)).toBe(original);
  });
});
