/**
 * Client-side helpers for talking to the MCP server of a live host: discovery, an SDK client, a tool
 * call that returns a uniform result, and a raw HTTP request for guard tests that need full control
 * of the headers. No test assertions live here.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Every token this process has read, so a log check can prove none of them was written out. */
export const seenTokens = new Set();

/** Reads the discovery file the extension publishes (`{ url, token }`). */
export function readDiscovery(ready) {
  const discovery = JSON.parse(readFileSync(ready.discoveryPath, 'utf8'));
  seenTokens.add(discovery.token);
  return discovery;
}

/** Connects the official SDK client over Streamable HTTP with a bearer token. */
export async function connect(discovery, token = discovery.token) {
  const client = new Client({ name: 'mcp-live', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

/** Calls a tool and returns `{ isError, code, text, json }` (`json` only when the text parses). */
export async function call(client, name, toolArgs, options) {
  const result = await client.callTool({ name, arguments: toolArgs }, options);
  const text = (result.content ?? []).map((c) => c.text ?? '').join('');
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { isError: !!result.isError, code: result.structuredContent?.code, text, json };
}

/** Raw HTTP request with full control of the Host header, which `fetch` does not allow. */
export function raw(port, { method = 'POST', path = '/mcp', headers = {}, body = '' } = {}) {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (response) => {
      const parts = [];
      response.on('data', (d) => parts.push(d));
      response.on('end', () => res({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', rej);
    req.end(body);
  });
}

export const JSON_RPC_HEADERS = (token) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
