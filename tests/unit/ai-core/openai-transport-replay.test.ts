import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { transcriptTurn } from '../../../src/ai/model/modelPort';
import { ProviderModelPort, type ModelTransport } from '../../../src/ai/model/providerModelPort';
import type { WireRecord } from '../../../src/ai/observability/wireLog';
import { parseModelEntries } from '../../../src/ai/providers/modelEntries';
import { createProviderModelPort } from '../../../src/ai/providers/openAiTransport';

/**
 * Pins the wire shape of a replayed assistant turn: a call whose streamed arguments are no JSON
 * object goes out as the text the model sent (`function.arguments` / `function_call.arguments`),
 * not as LangChain's completed object and not JSON-quoted, on both API types.
 */
const CUT = '{"sections":{"technical":"cu';
const schema = z.object({ sections: z.object({ technical: z.string() }) });
const tools = [{ name: 'lineage_present_result', description: 'd', inputSchema: schema }];

async function history() {
  const source: ModelTransport = {
    id: 'src',
    identity: { id: 'm', name: 'm', vendor: 'v', family: 'f', version: '1' },
    countTokens: async () => 1,
    async *stream() {
      yield new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { type: 'tool_call_chunk', index: 0, id: 'call_ok', name: 'lineage_present_result', args: '{"sections":{"technical":"x"}}' },
          { type: 'tool_call_chunk', index: 1, id: 'call_cut', name: 'lineage_present_result', args: CUT },
        ],
      });
      yield new AIMessageChunk({ content: '', response_metadata: { streamEnd: true } });
    },
  };
  const result = await new ProviderModelPort(source).generateToolTurn({ messages: [], tools, phase: 'test' });
  if (result.status !== 'completed') throw new Error('turn failed');
  return [
    new HumanMessage('go'),
    transcriptTurn(result.message, result.toolCalls),
    new ToolMessage({ tool_call_id: 'call_ok', content: 'ok' }),
    new ToolMessage({ tool_call_id: 'call_cut', content: 'not valid JSON', status: 'error' }),
  ];
}

async function sentBody(apiType: 'chat-completions' | 'responses'): Promise<Record<string, unknown>> {
  const [entry] = parseModelEntries([{ id: 'e', name: 'e', url: 'http://localhost/v1', model: 'gpt-x', apiType, maxInputTokens: 1000, maxOutputTokens: 100 }]).entries;
  let body: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as Record<string, unknown>;
    return new Response('{"error":{"message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }));
  await createProviderModelPort(entry, 'key').generateToolTurn({ messages: await history(), tools, phase: 'test' });
  return body;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI transport replay of a malformed tool call', () => {
  it('chat completions sends the streamed text bare, beside the valid call', async () => {
    const body = await sentBody('chat-completions');
    const assistant = (body.messages as Array<{ role: string; tool_calls?: unknown }>).find((message) => message.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([
      { id: 'call_ok', type: 'function', function: { name: 'lineage_present_result', arguments: '{"sections":{"technical":"x"}}' } },
      { id: 'call_cut', type: 'function', function: { name: 'lineage_present_result', arguments: CUT } },
    ]);
  });

  it('responses sends the streamed text bare, beside the valid call', async () => {
    const body = await sentBody('responses');
    const calls = (body.input as Array<{ type: string; call_id?: string; arguments?: string }>).filter((item) => item.type === 'function_call');
    expect(calls.map((call) => [call.call_id, call.arguments])).toEqual([
      ['call_ok', '{"sections":{"technical":"x"}}'],
      ['call_cut', CUT],
    ]);
  });

  it('an own chat completions turn with no malformed call is sent and traced from its tool_calls, as objects', async () => {
    const [entry] = parseModelEntries([{ id: 'e', name: 'e', url: 'http://localhost/v1', model: 'gpt-x', apiType: 'chat-completions', maxInputTokens: 1000, maxOutputTokens: 100 }]).entries;
    // As streaming leaves it: the delta copy in additional_kwargs beside the parsed tool_calls.
    const own = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_ok', name: 'lineage_present_result', args: { sections: { technical: 'x' } }, type: 'tool_call' }],
      additional_kwargs: { tool_calls: [{ id: 'call_ok', type: 'function', function: { name: 'lineage_present_result', arguments: '{"sections":{"technical":"x"}}' } }] },
      response_metadata: { entryId: 'e' },
    });
    let body: { messages: Array<{ role: string; tool_calls?: unknown }> } = { messages: [] };
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      body = JSON.parse(init.body) as typeof body;
      return new Response('{"error":{"message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
    }));
    const records: WireRecord[] = [];
    await createProviderModelPort(entry, 'key', { wireLog: (record) => records.push(record) }).generateToolTurn({
      messages: [new HumanMessage('go'), own, new ToolMessage({ tool_call_id: 'call_ok', content: 'ok' })],
      tools,
      phase: 'test',
    });
    expect(body.messages.find((message) => message.role === 'assistant')?.tool_calls).toEqual([
      { id: 'call_ok', type: 'function', function: { name: 'lineage_present_result', arguments: '{"sections":{"technical":"x"}}' } },
    ]);
    const request = records.find((record) => record.type === 'wire-request');
    const traced = (request as unknown as { messages: Array<{ role: string; parts: Array<{ type: string; input?: unknown }> }> }).messages
      .find((message) => message.role === 'assistant')?.parts.find((part) => part.type === 'tool-call');
    expect(traced?.input).toEqual({ sections: { technical: 'x' } });
  });
});
