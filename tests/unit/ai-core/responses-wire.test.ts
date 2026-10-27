/** Responses API wire of the headless port: request shape and decode, with a fake fetch. */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { modelToolCallMessage, modelToolResultMessage, modelUserMessage } from '../../../src/ai/model/modelPort';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';

const URL_RESPONSES = 'https://res.example/openai/v1/responses';
const tools = [{ name: 'lineage_search_objects', description: 'Search.', inputSchema: z.object({ query: z.string() }) }];

function setup(reply: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  };
  const wire: any[] = [];
  const port = new OpenAiCompatiblePort({
    baseUrl: 'https://res.example/openai/v1', chatCompletionsUrl: URL_RESPONSES, wire: 'responses', apiKey: 'synthetic-secret', apiKeyHeader: 'api-key',
    model: 'gpt-6-luna', requestTuning: { reasoning: { effort: 'low' } },
  }, { fetchImpl, traceVerbose: true, wireLog: record => wire.push(record) });
  return { port, calls, wire };
}
const turn = (messages: any[], system?: string) => ({ messages, system, tools, phase: 'p' });

const toolCall = (args: string, id = 'call_1') => ({ type: 'function_call', call_id: id, name: 'lineage_search_objects', arguments: args });

describe('responses wire request', () => {
  it('sends input items, flat tools, reasoning effort, store false and the api-key header', async () => {
    const { port, calls, wire } = setup({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    await port.generateToolTurn(turn([modelUserMessage('Find Sales.')], 'Be brief.'));
    const [{ url, headers, body }] = calls;
    expect(url).toBe(URL_RESPONSES);
    expect(headers['api-key']).toBe('synthetic-secret');
    expect(headers.authorization).toBeUndefined();
    expect(body).toMatchObject({ model: 'gpt-6-luna', store: false, reasoning: { effort: 'low' }, tool_choice: 'auto' });
    expect(body.messages).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'lineage_search_objects', description: 'Search.', parameters: expect.any(Object) })]);
    expect(body.tools[0].function).toBeUndefined();
    expect(body.input).toEqual([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Find Sales.' }]);
    expect(wire.find(r => r.type === 'provider-raw' && r.direction === 'request').url).toBe(URL_RESPONSES);
  });
});

describe('responses wire decode', () => {
  it.each([
    ['tool call', [toolCall('{"query":"Sales"}')], { toolCalls: [{ id: 'call_1', input: { query: 'Sales' } }] as Array<{ id: string; input: unknown }>, text: '' }],
    ['text', [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], { text: 'Hello', toolCalls: [] as Array<{ id: string; input: unknown }> }],
    ['text and call', [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'x' }] }, toolCall('{"query":"A"}', 'c2')],
      { text: 'x', toolCalls: [{ id: 'c2', input: { query: 'A' } }] }],
  ])('decodes %s', async (_name, output, expected) => {
    const { port } = setup({ status: 'completed', output });
    const result = await port.generateToolTurn(turn([modelUserMessage('q')]));
    expect(result.status).toBe('completed');
    expect(result.text).toBe(expected.text ?? '');
    expect(result.toolCalls.map(call => ({ valid: call.valid, id: call.callId, input: call.input }))).toEqual(
      expected.toolCalls.map(call => ({ valid: true, id: call.id, input: call.input })));
  });

  it('maps usage and records it on the generation', async () => {
    const { port, wire } = setup({ status: 'completed', output: [toolCall('{"query":"S"}')], usage: {
      input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 },
    } });
    await port.generateToolTurn(turn([modelUserMessage('q')]));
    expect(wire.find(r => r.type === 'generation').usage).toEqual({ inputTokens: 10, outputTokens: 7, totalTokens: 17, reasoningTokens: 3 });
  });

  it.each(['{"query":', '', '[1]'])('keeps malformed arguments %j as evidence', async args => {
    const { port, wire } = setup({ status: 'completed', output: [toolCall(args)] });
    const result = await port.generateToolTurn(turn([modelUserMessage('q')]));
    expect(result.status).toBe('completed');
    expect(result.toolCalls[0]).toMatchObject({ valid: false, code: 'invalid_tool_input', input: args });
    expect(wire.find(r => r.type === 'wire-response').toolCalls[0].input).toBe(args);
  });

  it('round-trips a tool result with the matching call_id', async () => {
    const { port, calls } = setup({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] });
    await port.generateToolTurn(turn([
      modelUserMessage('q'),
      modelToolCallMessage([{ callId: 'call_9', toolName: 'lineage_search_objects', input: { query: 'Sales' } }]),
      modelToolResultMessage('call_9', 'lineage_search_objects', 'found', 'success'),
    ]));
    expect(calls[0].body.input).toEqual([
      { role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'call_9', name: 'lineage_search_objects', arguments: '{"query":"Sales"}' },
      { type: 'function_call_output', call_id: 'call_9', output: 'found' },
    ]);
  });
});

describe('responses wire reasoning round trip', () => {
  it('returns encrypted reasoning items ahead of the call and its output, and keeps the payload out of the trace', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC-PAYLOAD' };
    const first = setup({ status: 'completed', output: [reasoning, toolCall('{"query":"Sales"}', 'call_7')] });
    const turn1 = await first.port.generateToolTurn(turn([modelUserMessage('q')]));
    expect(turn1.status).toBe('completed');
    // Same port, next round: the history carries the call it returned.
    const second = first;
    (second.calls as unknown[]).length = 0;
    await second.port.generateToolTurn(turn([
      modelUserMessage('q'),
      modelToolCallMessage([{ callId: 'call_7', toolName: 'lineage_search_objects', input: { query: 'Sales' } }]),
      modelToolResultMessage('call_7', 'lineage_search_objects', 'found', 'success'),
    ])).catch(() => undefined);
    expect(second.calls[0].body.input).toEqual([
      { role: 'user', content: 'q' },
      reasoning,
      { type: 'function_call', call_id: 'call_7', name: 'lineage_search_objects', arguments: '{"query":"Sales"}' },
      { type: 'function_call_output', call_id: 'call_7', output: 'found' },
    ]);
    expect(JSON.stringify(second.wire)).not.toContain('ENC-PAYLOAD');
    expect(JSON.stringify(second.wire)).toContain('[omitted');
  });
});
