import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { transcriptTurn } from '../../../src/ai/model/modelPort';
import { ProviderModelPort, type ModelTransport } from '../../../src/ai/model/providerModelPort';
import type { WireRecord } from '../../../src/ai/observability/wireLog';
import { parseModelEntries } from '../../../src/ai/providers/modelEntries';
import { createProviderModelPort } from '../../../src/ai/providers/openAiTransport';
import { describeTurnStop } from '../../../src/ai/support/text';

/**
 * Pins the wire shape of a replayed assistant turn: a call whose streamed arguments are no JSON
 * object goes out with empty JSON-object arguments (`function.arguments` / `function_call.arguments`),
 * never the model's cut text (providers reject a history call whose arguments are no JSON) and never
 * LangChain's completed object; the rejection result carries the fault to the model. Both API types,
 * an own turn and another endpoint's turn. A streamed reply's text, whatever its chunk shape (a
 * Responses `response.output_text.delta` event), reaches `onTextDelta` and the `wire-response`
 * record the same as a Chat Completions text delta.
 */
const CUT = '{"sections":{"technical":"cu';
const schema = z.object({ sections: z.object({ technical: z.string() }) });
const tools = [{ name: 'lineage_present_result', description: 'd', inputSchema: schema }];

async function history(own = false) {
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
  if (own) result.message.response_metadata = { ...result.message.response_metadata, entryId: 'e' };
  return [
    new HumanMessage('go'),
    transcriptTurn(result.message, result.toolCalls),
    new ToolMessage({ tool_call_id: 'call_ok', content: 'ok' }),
    new ToolMessage({ tool_call_id: 'call_cut', content: 'not valid JSON', status: 'error' }),
  ];
}

async function sentBody(apiType: 'chat-completions' | 'responses', own = false): Promise<Record<string, unknown>> {
  const [entry] = parseModelEntries([{ id: 'e', name: 'e', url: 'http://localhost/v1', model: 'gpt-x', apiType, maxInputTokens: 1000, maxOutputTokens: 100 }]).entries;
  let body: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as Record<string, unknown>;
    return new Response('{"error":{"message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }));
  await createProviderModelPort(entry, 'key').generateToolTurn({ messages: await history(own), tools, phase: 'test' });
  return body;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI transport replay of a malformed tool call', () => {
  it.each([false, true])('chat completions replays a cut call with empty object arguments, beside the valid call (own turn: %s)', async (own) => {
    const body = await sentBody('chat-completions', own);
    const assistant = (body.messages as Array<{ role: string; tool_calls?: unknown }>).find((message) => message.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([
      { id: 'call_ok', type: 'function', function: { name: 'lineage_present_result', arguments: '{"sections":{"technical":"x"}}' } },
      { id: 'call_cut', type: 'function', function: { name: 'lineage_present_result', arguments: '{}' } },
    ]);
  });

  it.each([false, true])('responses replays a cut call with empty object arguments, beside the valid call (own turn: %s)', async (own) => {
    const body = await sentBody('responses', own);
    const calls = (body.input as Array<{ type: string; call_id?: string; arguments?: string }>).filter((item) => item.type === 'function_call');
    expect(calls.map((call) => [call.call_id, call.arguments])).toEqual([
      ['call_ok', '{"sections":{"technical":"x"}}'],
      ['call_cut', '{}'],
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

  it('the wire-response record carries the streamed text of a cut call, not the completed object', async () => {
    const [entry] = parseModelEntries([{ id: 'e', name: 'e', url: 'http://localhost/v1', model: 'gpt-x', apiType: 'chat-completions', maxInputTokens: 1000, maxOutputTokens: 100 }]).entries;
    const delta = (index: number, id: string, args: string) => ({
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index, id, type: 'function', function: { name: 'lineage_present_result', arguments: args } }] }, finish_reason: null }],
    });
    const frames = [
      delta(0, 'call_ok', '{"sections":{"technical":"x"}}'),
      delta(1, 'call_cut', CUT),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `${frames.map((frame) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gpt-x', ...frame })}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const records: WireRecord[] = [];
    await createProviderModelPort(entry, 'key', { wireLog: (record) => records.push(record) })
      .generateToolTurn({ messages: [new HumanMessage('go')], tools, phase: 'test' });
    const response = records.find((record) => record.type === 'wire-response');
    expect(response?.type === 'wire-response' ? response.toolCalls : []).toEqual([
      { callId: 'call_ok', name: 'lineage_present_result', input: { sections: { technical: 'x' } } },
      { callId: 'call_cut', name: 'lineage_present_result', input: CUT },
    ]);
  });

  it('a Responses output_text.delta streams to onTextDelta and is recorded in wire-response', async () => {
    const [entry] = parseModelEntries([{ id: 'e', name: 'e', url: 'http://localhost/v1', model: 'gpt-x', apiType: 'responses', maxInputTokens: 1000, maxOutputTokens: 100 }]).entries;
    const reply = (status: string, output: unknown[] = []) => ({ id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-x', status, output });
    const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello world', annotations: [] }] };
    const delta = (sequence: number, text: string) => ({ type: 'response.output_text.delta', sequence_number: sequence, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text });
    const events = [
      { type: 'response.created', sequence_number: 0, response: reply('in_progress') },
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      delta(2, 'hello '),
      delta(3, 'world'),
      { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: message },
      { type: 'response.completed', sequence_number: 5, response: reply('completed', [message]) },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const deltas: string[] = [];
    const records: WireRecord[] = [];
    await createProviderModelPort(entry, 'key', { wireLog: (record) => records.push(record) })
      .generateToolTurn({ messages: [new HumanMessage('go')], tools: [], phase: 'test', onTextDelta: (text) => deltas.push(text) });
    expect(deltas.join('')).toBe('hello world');
    const wire = records.find((record) => record.type === 'wire-response');
    expect(wire?.type === 'wire-response' ? wire.text : undefined).toBe('hello world');
  });

  it.each(['chat-completions', 'responses'] as const)('%s: a content_filter finish ends the generation as one blocked port error, recorded in wire-error and never as a stop', async (apiType) => {
    const [entry] = parseModelEntries([{ id: 'e', name: 'e', url: 'http://localhost/v1', model: 'gpt-x', apiType, maxInputTokens: 1000, maxOutputTokens: 100 }]).entries;
    const chatFrames = [{ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }] }]
      .map((frame) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gpt-x', ...frame })}\n\n`).join('');
    const response = { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-x', output: [] };
    const responseEvents = [
      { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' } },
      { type: 'response.incomplete', sequence_number: 1, response: { ...response, status: 'incomplete', incomplete_details: { reason: 'content_filter' } } },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const fetchMock = vi.fn(async () => new Response(apiType === 'responses' ? responseEvents : `${chatFrames}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const records: WireRecord[] = [];
    const result = await createProviderModelPort(entry, 'key', { wireLog: (record) => records.push(record) })
      .generateToolTurn({ messages: [new HumanMessage('go')], tools, phase: 'test' });
    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.turnStop : undefined).toMatchObject({ source: 'provider', code: 'blocked' });
    expect(result.status === 'error' ? describeTurnStop(result.turnStop, 'm') : '').toContain('Model declined to respond.');
    expect(records.some((record) => record.type === 'wire-error')).toBe(true);
    expect(records.some((record) => record.type === 'generation')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
