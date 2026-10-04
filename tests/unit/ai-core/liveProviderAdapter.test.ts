/** Covers the real-provider fixture's normalized message, request and response boundary. */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const adapter = require('../../fixtures/lm-provider-extension/live-provider-adapter.js') as {
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
});
