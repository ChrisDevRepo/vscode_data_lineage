/** Covers the real-provider fixture's normalized message, request and response boundary. */
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const adapter = require('../../fixtures/lm-provider-extension/live-provider-adapter.js') as {
  createProviderFetch: (timeoutMs: number) => typeof fetch;
  buildProviderRequest: (request: RequestFixture, config: ConfigFixture) => WireRequest;
  parseProviderResponse: (payload: unknown) => ProviderOutput;
  sendProviderRequest: (
    request: RequestFixture,
    config: ConfigFixture,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
  ) => Promise<ProviderOutput>;
  toProviderMessages: (messages: RequestFixture['messages']) => unknown[];
};

interface RequestFixture {
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>;
  tools: Array<{ name: string; description: string; schema: Record<string, unknown> }>;
  toolMode: 'auto' | 'required';
}

interface ConfigFixture {
  provider: string;
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  temperature?: number;
}

interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface ProviderOutput {
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  text: string;
}

const config: ConfigFixture = {
  provider: 'openrouter',
  endpoint: 'https://provider.example/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

const emptyRequest = (): RequestFixture => ({ messages: [], tools: [], toolMode: 'auto' });

describe('live provider adapter', () => {
  it.each(['azure', 'openrouter'].flatMap(provider => ['plain', 'gzip', 'redirect'].map(response => ({ provider, response }))))(
    'uses explicit long HTTP budgets and preserves $provider authentication for $response', async ({ provider, response }) => {
    const server = createServer((req, res) => {
      expect(req.headers[provider === 'azure' ? 'api-key' : 'authorization'])
        .toBe(provider === 'azure' ? 'test-key' : 'Bearer test-key');
      expect(req.method).toBe('POST');
      if (response === 'redirect' && req.url !== '/redirected') {
        res.writeHead(307, { location: '/redirected' });
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      const body = JSON.stringify({ choices: [{ message: { content: 'done' } }] });
      if (response === 'gzip') res.setHeader('content-encoding', 'gzip');
      res.end(response === 'gzip' ? gzipSync(body) : body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const undici = require('undici');
    const requestSpy = vi.spyOn(undici, 'request');
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('hidden fetch deadline'));
    try {
      const timeoutMs = 7_200_000;
      const native = await adapter.sendProviderRequest(emptyRequest(), { ...config, provider, endpoint },
        adapter.createProviderFetch(timeoutMs), new AbortController().signal);
      expect(native.text).toBe('done');
      const port = new OpenAiCompatiblePort({ baseUrl: endpoint, apiKey: 'test-key', model: 'test-model',
        ...(provider === 'azure' ? { apiKeyHeader: 'api-key' } : {}) });
      await expect(port.completeText({ messages: [], system: 'Synthetic transport check.' })).resolves.toBe('done');
      expect(globalFetch).not.toHaveBeenCalled();
      expect(requestSpy).toHaveBeenCalledTimes(2);
      for (const [, options] of requestSpy.mock.calls) {
        expect(options).toMatchObject({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
      }
    } finally {
      requestSpy.mockRestore();
      globalFetch.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['headers', 'body'].flatMap(phase => ['abort', 'deadline'].map(end => ({ phase, end }))))(
    'ends a stalled $phase response on $end', async ({ phase, end }) => {
    const controller = new AbortController();
    const server = createServer((req, res) => {
      if (req.url !== '/stall') {
        res.writeHead(307, { location: '/stall' });
        res.end();
        return;
      }
      if (phase === 'body') { res.writeHead(200); res.write('{'); }
      if (end === 'abort') setTimeout(() => controller.abort(), 20);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await expect(adapter.createProviderFetch(end === 'abort' ? 7_200_000 : 50)(endpoint, { method: 'POST', body: '{}', signal: controller.signal }))
        .rejects.toMatchObject(end === 'abort' ? { name: 'AbortError' }
          : { code: phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('forwards the live acceptance reasoning and temperature settings on the wire',()=>{
    expect(adapter.buildProviderRequest(emptyRequest(),{...config,reasoningEffort:'low',temperature:0.1}).body)
      .toMatchObject({reasoning_effort:'low',temperature:0.1});
  });
  it('preserves text, assistant tool calls and ordered tool results without empty user shells', () => {
    const messages: RequestFixture['messages'] = [
      { role: 'user', content: [{ type: 'text', value: 'trace revenue' }] },
      { role: 'assistant', content: [
        { type: 'text', value: 'checking' },
        { type: 'tool-call', callId: 'call-1', name: 'lineage_search_objects', input: { query: 'revenue' } },
      ] },
      { role: 'user', content: [{
        type: 'tool-result',
        callId: 'call-1',
        content: [{ type: 'text', value: '{"results":[]}' }],
      }] },
      { role: 'user', content: [{ type: 'text', value: 'continue' }] },
    ];

    expect(adapter.toProviderMessages(messages)).toEqual([
      { role: 'user', content: 'trace revenue' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'lineage_search_objects', arguments: '{"query":"revenue"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"results":[]}' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('maps Required tool mode to the provider contract and rejects it without tools', () => {
    const request = emptyRequest();
    request.toolMode = 'required';
    request.tools = [{
      name: 'lineage_submit_findings',
      description: 'Submit the findings for the active lineage hop.',
      schema: { type: 'object' },
    }];
    expect(adapter.buildProviderRequest(request, config).body).toMatchObject({
      tool_choice: 'required',
      tools: [{ function: {
        name: 'lineage_submit_findings',
        description: 'Submit the findings for the active lineage hop.',
        parameters: { type: 'object' },
      } }],
    });

    request.tools = [];
    expect(() => adapter.buildProviderRequest(request, config)).toThrow(/require a tool when no tools/i);
  });

  it('validates provider tool calls before they reach VS Code', () => {
    expect(adapter.parseProviderResponse({
      choices: [{ message: {
        content: [{ type: 'text', text: 'done' }],
        tool_calls: [{ id: 'call-2', function: { name: 'lineage_present_result', arguments: '{"id":"result"}' } }],
      } }],
    })).toEqual({
      toolCalls: [{ id: 'call-2', name: 'lineage_present_result', input: { id: 'result' } }],
      text: 'done',
    });

    expect(() => adapter.parseProviderResponse({ choices: [{ message: { tool_calls: {} } }] }))
      .toThrow(/tool_calls must be an array/i);
    expect(() => adapter.parseProviderResponse({
      choices: [{ message: { tool_calls: [{ id: 'bad', function: { name: 'tool', arguments: '{' } }] } }],
    })).toThrow(/invalid JSON arguments/i);
    expect(() => adapter.parseProviderResponse({
      choices: [{ message: { tool_calls: [{ id: 'bad', function: { name: 'tool', arguments: '[]' } }] } }],
    })).toThrow(/arguments.*must be an object/i);
  });

  it('forwards cancellation and rejects malformed payloads without echoing them', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(adapter.sendProviderRequest(emptyRequest(), config, fetchSpy, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });

    const malformedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ secretPayload: 'must-not-appear' }),
    })) as unknown as typeof fetch;
    const malformed = adapter.sendProviderRequest(
      emptyRequest(), config, malformedFetch, new AbortController().signal,
    );
    await expect(malformed).rejects.toThrow('choices[0].message');
    await expect(adapter.sendProviderRequest(
      emptyRequest(), config, malformedFetch, new AbortController().signal,
    )).rejects.not.toThrow(/must-not-appear/);
  });

  describe('Azure test endpoint route normalization', () => {
    const { providerEndpoint } = adapter as unknown as {
      providerEndpoint: (endpoint: string, provider: string, model: string) => string;
    };

    it.each(['', '/', '///'])('normalizes trailing slash variant %j before classifying routes', suffix => {
      const base = 'https://synthetic.openai.azure.com';
      expect(providerEndpoint(`${base}/openai/v1${suffix}?custom=kept`, 'azure', 'deployment'))
        .toBe(`${base}/openai/v1/chat/completions?custom=kept`);
      expect(providerEndpoint(`${base}/openai/v1/chat/completions${suffix}?custom=kept`, 'azure', 'deployment'))
        .toBe(`${base}/openai/v1/chat/completions?custom=kept`);
      expect(providerEndpoint(`${base}${suffix}`, 'azure', 'deployment'))
        .toBe(`${base}/openai/deployments/deployment/chat/completions?api-version=2024-10-21`);
      expect(providerEndpoint(`${base}/openai/deployments/deployment${suffix}?api-version=custom`, 'azure', 'deployment'))
        .toBe(`${base}/openai/deployments/deployment/chat/completions?api-version=custom`);
      expect(providerEndpoint(`${base}/openai/deployments/deployment/chat/completions${suffix}?api-version=custom`, 'azure', 'deployment'))
        .toBe(`${base}/openai/deployments/deployment/chat/completions?api-version=custom`);
      expect(providerEndpoint(`https://synthetic.example/v1${suffix}`, 'openai-compatible', 'model'))
        .toBe('https://synthetic.example/v1/chat/completions');
    });

    it.each(['not a URL', 'file:///openai/v1/'])('rejects unsupported endpoint %s', endpoint => {
      expect(() => providerEndpoint(endpoint, 'azure', 'deployment')).toThrow();
    });
  });
});

