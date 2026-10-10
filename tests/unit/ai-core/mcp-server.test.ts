/**
 * The MCP adapter is a pure transport over the external core tools: `tools/list` mirrors the
 * catalog, `tools/call` dispatches unchanged, and only authenticated localhost requests pass.
 * The stdio proxy relays a stdio client to the same endpoint through the SDK transports.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { TOOL_DEFS } from '../../../src/ai/tools/toolDefs';
import { EXTERNAL_TOOL_NAMES } from '../../../src/ai/tools/toolPolicy';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { makeRejection } from '../../../src/ai/support/toolErrorEnvelope';
import {
  MCP_INSTRUCTIONS,
  buildMcpClientConfig,
  createMcpFetchHandler,
  startMcpServer,
  type McpServerConfig,
} from '../../../src/ai/mcp/mcpServer';
import { parseMcpDiscovery } from '../../../src/ai/mcp/mcpDiscovery';
import { rootPath } from '../helpers/testUtils';

const TOKEN = 'test-token';
const tools = TOOL_DEFS.filter(def => EXTERNAL_TOOL_NAMES.has(def.name));
const logger = { debug: vi.fn(), warn: vi.fn() };

function config(invoke: McpServerConfig['source']['invoke']): McpServerConfig {
  return { source: { tools, invoke }, token: TOKEN, version: '1.2.6', logger };
}

const LEGACY = '2025-06-18';
function rpc(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:39217/mcp', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:39217',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': LEGACY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Reads the single JSON-RPC message of a JSON or SSE response. */
async function message(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5)
    : text;
  return JSON.parse(payload);
}

describe('MCP tools/list', () => {
  it('lists exactly the external catalog with its shared descriptions, schemas and hints', async () => {
    const handle = createMcpFetchHandler(config(async () => '{}'));
    const listed = (await message(await handle(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })))).result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual(tools.map(def => def.name));
    for (const [index, def] of tools.entries()) {
      expect(listed[index]).toEqual({
        name: def.name,
        title: def.title,
        description: def.modelDescription,
        inputSchema: toModelJsonSchema(def.inputSchema),
        annotations: expect.objectContaining({ destructiveHint: false, openWorldHint: false }),
      });
    }
    const present = listed.find((tool: { name: string }) => tool.name === 'lineage_present_result');
    expect(present.annotations.readOnlyHint).toBe(false);
    const search = listed.find((tool: { name: string }) => tool.name === 'lineage_search_objects');
    expect(search.annotations.readOnlyHint).toBe(true);
  });

  it('announces the server instructions at initialization', async () => {
    const handle = createMcpFetchHandler(config(async () => '{}'));
    const init = await message(await handle(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }, { 'mcp-protocol-version': '' })));
    expect(init.result.instructions).toBe(MCP_INSTRUCTIONS);
    expect(init.result.serverInfo).toEqual({ name: 'data-lineage', version: '1.2.6' });
  });
});

describe('MCP tools/call', () => {
  it('dispatches the raw arguments and returns the tool text', async () => {
    const invoke = vi.fn(async () => JSON.stringify({ results: [] }));
    const handle = createMcpFetchHandler(config(invoke));
    const result = (await message(await handle(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lineage_search_objects', arguments: { query: 'Orders' } } })))).result;
    expect(invoke).toHaveBeenCalledWith('lineage_search_objects', { query: 'Orders' }, expect.any(AbortSignal));
    expect(result).toEqual({ content: [{ type: 'text', text: '{"results":[]}' }], isError: false });
  });

  it('marks a rejection envelope as a tool execution error whose text is the fault and the recovery', async () => {
    const envelope = makeRejection({ code: 'not_found', reason: 'No object has id `x`.', hint: 'Call lineage_search_objects first.', issuePaths: ['id'] });
    const handle = createMcpFetchHandler(config(async () => JSON.stringify(envelope)));
    const result = (await message(await handle(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lineage_get_object_detail', arguments: { id: 'x' } } })))).result;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'No object has id `x`.\nCall lineage_search_objects first.' }]);
    expect(result.structuredContent).toEqual(envelope);
  });

  it('never shows a bare machine code as the error text', async () => {
    const handle = createMcpFetchHandler(config(async () => JSON.stringify(makeRejection({ code: 'off_policy', hint: 'Retry after the chat turn ends.' }))));
    const result = (await message(await handle(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lineage_present_result', arguments: {} } })))).result;
    expect(result.content[0].text).toBe('Retry after the chat turn ends.');
    expect(result.structuredContent.code).toBe('off_policy');
  });

  it('answers a failing dispatch with a JSON-RPC error instead of hanging', async () => {
    const handle = createMcpFetchHandler(config(async () => { throw new Error('dispatch failed'); }));
    const reply = await message(await handle(rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lineage_get_context', arguments: {} } })));
    expect(reply.error).toMatchObject({ message: expect.stringContaining('dispatch failed') });
  });

  it('aborts the dispatch when the client cancels the request', async () => {
    let seen: AbortSignal | undefined;
    const handle = createMcpFetchHandler(config((_name, _input, signal) => new Promise((resolve) => {
      seen = signal;
      signal.addEventListener('abort', () => resolve('{}'), { once: true });
    })));
    const controller = new AbortController();
    const request = new Request(rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'lineage_search_ddl', arguments: { query: 'x' } } }), { signal: controller.signal });
    const pending = handle(request).catch(() => undefined);
    for (let i = 0; i < 100 && !seen; i++) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await pending;
    expect(seen?.aborted).toBe(true);
  });

  it('answers an unknown tool with a protocol error', async () => {
    const invoke = vi.fn(async () => '{}');
    const handle = createMcpFetchHandler(config(invoke));
    const reply = await message(await handle(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lineage_submit_findings', arguments: {} } })));
    expect(reply.error).toMatchObject({ code: -32602, message: expect.stringContaining('Unknown tool') });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('MCP request guard', () => {
  const handle = createMcpFetchHandler(config(async () => '{}'));
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  it('rejects a missing or wrong bearer token with a Bearer challenge', async () => {
    // `Bearer test-tokeX` has the right length, so it reaches the constant-time comparison.
    for (const authorization of ['', 'Bearer wrong', 'Bearer test-tokeX', `Basic ${TOKEN}`]) {
      const response = await handle(rpc(list, { authorization }));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('rejects a non-localhost Host or Origin (DNS rebinding)', async () => {
    expect((await handle(rpc(list, { host: 'attacker.example' }))).status).toBe(403);
    expect((await handle(rpc(list, { origin: 'https://attacker.example' }))).status).toBe(403);
  });

  it('logs each refusal once with its reason and never the credential or the request body', async () => {
    logger.debug.mockClear();
    await handle(rpc(list, { authorization: 'Bearer secret-wrong-token' }));
    await handle(rpc(list, { host: 'attacker.example' }));
    await handle(new Request('http://127.0.0.1:39217/other', { method: 'POST', headers: { host: '127.0.0.1:39217', authorization: `Bearer ${TOKEN}` }, body: '{"private":"body"}' }));
    const lines = logger.debug.mock.calls.map(call => String(call[0]));
    expect(lines).toEqual([
      'Refused request (401): missing or invalid bearer token',
      'Refused request (403): Host or Origin is not local',
      'Refused request (404): unknown path',
    ]);
    expect(lines.join(' ')).not.toMatch(/secret-wrong-token|private|test-token/);
  });

  it('does not log an accepted request as a refusal', async () => {
    logger.debug.mockClear();
    expect((await handle(rpc(list))).status).toBe(200);
    expect(logger.debug.mock.calls.some(call => /Refused/.test(String(call[0])))).toBe(false);
  });

  it('serves only the MCP path', async () => {
    const request = new Request('http://127.0.0.1:39217/other', { method: 'POST', headers: { host: '127.0.0.1:39217', authorization: `Bearer ${TOKEN}` }, body: '{}' });
    expect((await handle(request)).status).toBe(404);
  });
});

describe('MCP client configuration', () => {
  const endpoint = { url: 'http://127.0.0.1:39217/mcp', token: TOKEN, runtimePath: '/vscode/code', proxyPath: '/store/proxy.js', discoveryPath: '/store/mcp-server.json' };

  it('renders the HTTP JSON with the header', () => {
    expect(JSON.parse(buildMcpClientConfig('http', endpoint))).toEqual({
      mcpServers: { 'data-lineage': { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
  });

  it('renders the stdio proxy command without the token', () => {
    const text = buildMcpClientConfig('stdio', endpoint);
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({
      mcpServers: { 'data-lineage': { command: '/vscode/code', args: ['/store/proxy.js', '/store/mcp-server.json'], env: { ELECTRON_RUN_AS_NODE: '1' } } },
    });
  });
});

describe('MCP discovery file', () => {
  it('accepts only a 127.0.0.1 http endpoint with a token', () => {
    expect(parseMcpDiscovery(JSON.stringify({ url: 'http://127.0.0.1:39217/mcp', token: TOKEN }))).toEqual({ url: 'http://127.0.0.1:39217/mcp', token: TOKEN });
    expect(parseMcpDiscovery(JSON.stringify({ url: 'http://attacker.example/mcp', token: TOKEN }))).toBeNull();
    expect(parseMcpDiscovery(JSON.stringify({ url: 'https://127.0.0.1/mcp', token: TOKEN }))).toBeNull();
    expect(parseMcpDiscovery(JSON.stringify({ url: 'http://127.0.0.1:39217/mcp', token: '' }))).toBeNull();
    expect(parseMcpDiscovery(JSON.stringify({ url: 'http://127.0.0.1:39217/mcp', token: TOKEN, extra: true }))).toBeNull();
    expect(parseMcpDiscovery('{not json')).toBeNull();
    expect(parseMcpDiscovery('null')).toBeNull();
  });
});

describe('MCP over a socket and the stdio proxy', () => {
  let dir: string;
  let proxy: string;
  let syntheticProxy: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lineage-mcp-'));
    proxy = join(dir, 'proxy.js');
    await esbuild.build({ entryPoints: [rootPath('src/ai/mcp/stdioProxy.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: proxy, logLevel: 'silent' });
    syntheticProxy = join(dir, 'synthetic-proxy.js');
    const syntheticFetch = String.raw`
      let finishSlowResponse;
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.id === 31) return new Response(new ReadableStream({ start(controller) {
          finishSlowResponse = () => {
            controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ jsonrpc: '2.0', id: 31, result: { completed: true } }) + '\n\n'));
            controller.close();
          };
        } }), { headers: { 'content-type': 'text/event-stream' } });
        if (request.id === 32) {
          setTimeout(() => finishSlowResponse(), 50);
          return new Response('synthetic request too large', { status: 413 });
        }
        if (request.id === 33) return new Response('', { headers: { 'content-type': 'text/event-stream' } });
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { completed: true } });
      };
    `;
    await esbuild.build({ entryPoints: [rootPath('src/ai/mcp/stdioProxy.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: syntheticProxy, banner: { js: syntheticFetch }, logLevel: 'silent' });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Spawns the proxy and collects its newline-delimited replies. */
  function startProxy(discoveryPath: string, script = proxy) {
    const child = spawn(process.execPath, [script, discoveryPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies: Record<string, any>[] = [];
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const line of lines) if (line.trim()) replies.push(JSON.parse(line));
    });
    return {
      send: (body: object) => child.stdin.write(`${JSON.stringify(body)}\n`),
      waitFor: async (id: number) => {
        for (let i = 0; i < 200 && !replies.some(reply => reply.id === id); i++) await new Promise(resolve => setTimeout(resolve, 25));
        const reply = replies.find(entry => entry.id === id);
        expect(reply, `no reply to request ${id}`).toBeDefined();
        return reply!;
      },
      count: (id: number) => replies.filter(entry => entry.id === id).length,
      stop: () => { child.stdin.end(); child.kill(); },
    };
  }

  it('listens on 127.0.0.1, refuses an oversized body, and relays a stdio session end to end', async () => {
    const server = await startMcpServer(config(async (name, input) => JSON.stringify({ name, input })), 0);
    const discovery = join(dir, 'mcp-server.json');
    writeFileSync(discovery, JSON.stringify({ url: server.url, token: TOKEN }));
    const client = startProxy(discovery);
    try {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
      const oversized = await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024) });
      expect(oversized.status).toBe(413);

      client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } });
      expect((await client.waitFor(1)).result.protocolVersion).toBe(LEGACY);
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      expect((await client.waitFor(2)).result.tools).toHaveLength(tools.length);
      client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lineage_get_context', arguments: {} } });
      expect((await client.waitFor(3)).result.content[0].text).toBe(JSON.stringify({ name: 'lineage_get_context', input: {} }));
      // A 2026-07-28 request needs the standard headers mirrored from its body (Mcp-Method, Mcp-Name).
      const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'stdio-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
      client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lineage_search_ddl', arguments: { query: 'x' }, _meta: meta } });
      expect((await client.waitFor(4)).result.content[0].text).toBe(JSON.stringify({ name: 'lineage_search_ddl', input: { query: 'x' } }));
    } finally {
      client.stop();
      await server.close();
    }
  }, 20_000);

  it('does not replay a mutation when its response is lost and discovery changes', async () => {
    const discovery = join(dir, 'no-replay.json');
    let originalCalls = 0;
    let replacementCalls = 0;
    const replacementToken = 'new-session-token';
    const replacement = await startMcpServer({ ...config(async () => {
      replacementCalls++;
      return '{}';
    }), token: replacementToken }, 0);
    const original = await startMcpServer(config(async () => {
      originalCalls++;
      // Simulate a completed mutation followed by a lost HTTP response during shutdown.
      writeFileSync(discovery, JSON.stringify({ url: replacement.url, token: replacementToken }));
      await original.close();
      return '{}';
    }), 0);
    writeFileSync(discovery, JSON.stringify({ url: original.url, token: TOKEN }));
    const client = startProxy(discovery);
    try {
      client.send({ jsonrpc: '2.0', id: 41, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'no-replay-test', version: '1' } } });
      await client.waitFor(41);
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      client.send({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'lineage_present_result', arguments: {} } });
      expect(await client.waitFor(42)).toMatchObject({ error: { code: -32000 } });
      expect(originalCalls).toBe(1);
      expect(replacementCalls).toBe(0);
      expect(client.count(42)).toBe(1);
      // A new request may reconnect; the failed mutation remains the caller's decision.
      client.send({ jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'lineage_get_context', arguments: {} } });
      expect(await client.waitFor(43)).toMatchObject({ result: { isError: false } });
      expect(replacementCalls).toBe(1);
    } finally {
      client.stop();
      await original.close();
      await replacement.close();
    }
  }, 20_000);

  it('a failed parallel request leaves another request free to return its one successful reply', async () => {
    const discovery = join(dir, 'parallel.json');
    writeFileSync(discovery, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: TOKEN }));
    const client = startProxy(discovery, syntheticProxy);
    try {
      client.send({ jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} });
      client.send({ jsonrpc: '2.0', id: 32, method: 'tools/list', params: {} });
      expect(await client.waitFor(32)).toMatchObject({ error: { code: -32000 } });
      expect(await client.waitFor(31)).toMatchObject({ result: { completed: true } });
      expect(client.count(31)).toBe(1);
      expect(client.count(32)).toBe(1);
    } finally {
      client.stop();
    }
  });

  it('answers an empty SSE stream once and preserves the next normal response', async () => {
    const discovery = join(dir, 'empty-stream.json');
    writeFileSync(discovery, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: TOKEN }));
    const client = startProxy(discovery, syntheticProxy);
    try {
      client.send({ jsonrpc: '2.0', id: 33, method: 'tools/list', params: {} });
      expect(await client.waitFor(33)).toMatchObject({ error: { code: -32000, message: expect.stringContaining('without a reply') } });
      client.send({ jsonrpc: '2.0', id: 34, method: 'tools/list', params: {} });
      expect(await client.waitFor(34)).toMatchObject({ result: { completed: true } });
      expect(client.count(33)).toBe(1);
      expect(client.count(34)).toBe(1);
    } finally {
      client.stop();
    }
  });

  it('reports a moved endpoint once, reconnects on the next request, and reports shutdown once', async () => {
    const discovery = join(dir, 'moved.json');
    const first = await startMcpServer(config(async () => '{}'), 0);
    writeFileSync(discovery, JSON.stringify({ url: first.url, token: TOKEN }));
    const client = startProxy(discovery);
    const settled = () => new Promise(resolve => setTimeout(resolve, 300));
    let second: Awaited<ReturnType<typeof startMcpServer>> | undefined;
    try {
      client.send({ jsonrpc: '2.0', id: 20, method: 'tools/list', params: {} });
      expect((await client.waitFor(20)).result.tools).toHaveLength(tools.length);
      await first.close();
      second = await startMcpServer(config(async () => '{}'), 0);
      writeFileSync(discovery, JSON.stringify({ url: second.url, token: TOKEN }));

      client.send({ jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} });
      expect(await client.waitFor(21)).toMatchObject({ error: { code: -32000 } });
      client.send({ jsonrpc: '2.0', id: 23, method: 'tools/list', params: {} });
      expect((await client.waitFor(23)).result.tools).toHaveLength(tools.length);
      await second.close();

      client.send({ jsonrpc: '2.0', id: 22, method: 'tools/list', params: {} });
      expect(await client.waitFor(22)).toMatchObject({ error: { code: -32000 } });
      await settled();
      expect(client.count(21)).toBe(1);
      expect(client.count(22)).toBe(1);
      expect(client.count(23)).toBe(1);
    } finally {
      client.stop();
      await first.close();
      await second?.close();
    }
  }, 20_000);

  it('answers with an error while no server runs, then reaches one started later', async () => {
    const discovery = join(dir, 'late.json');
    const client = startProxy(discovery);
    try {
      client.send({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
      expect(await client.waitFor(9)).toMatchObject({ error: { code: -32000, message: expect.stringContaining('dataLineageViz.mcp.enabled') } });
      const server = await startMcpServer(config(async () => '{}'), 0);
      try {
        writeFileSync(discovery, JSON.stringify({ url: server.url, token: TOKEN }));
        client.send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
        expect((await client.waitFor(10)).result.tools).toHaveLength(tools.length);
      } finally {
        await server.close();
      }
    } finally {
      client.stop();
    }
  }, 20_000);
});
