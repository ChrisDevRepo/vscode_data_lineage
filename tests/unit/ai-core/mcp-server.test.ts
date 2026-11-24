/**
 * The local MCP server accepts a client only with the bearer token and a local Host and Origin,
 * exists only while the setting is on, and never writes the token to a log or an error body.
 */
import { request } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { McpService, MCP_TOKEN_KEY } from '../../../src/ai/mcp/mcpServer';
import { Logger } from '../../../src/utils/log';

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

/** POSTs the initialize request; `headers` override the defaults to forge a Host or Origin. */
function post(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(INITIALIZE);
  });
}

function harness() {
  const lines: string[] = [];
  const log = (message: string) => { lines.push(message); };
  const channel = { info: log, debug: log, warn: log, error: log, trace: log };
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
  });
  return { lines, store, portInUse, service };
}

const live: Array<{ service: McpService }> = [];
afterEach(async () => { await Promise.all(live.splice(0).map(({ service }) => service.dispose())); });

async function started() {
  const h = harness();
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
