/** D-106 Responses wire of the headless port (request shape, decode, replay) and D-103/D-086 one normalization on both wires; fake fetch, no provider call. */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { modelToolCallMessage, modelToolResultMessage, modelUserMessage, modelAssistantMessage, type ToolGenerationInput, type ToolGenerationResult } from '../../../src/ai/model/modelPort';
import type { WireRecord } from '../../../src/ai/observability/wireLog';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';

type Json = Record<string, unknown>;
const URL_RESPONSES = 'https://res.example/openai/v1/responses';
const URL_CHAT = 'https://res.example/openai/v1/chat/completions';
const SECRET = 'synthetic-secret';
const tools = [{ name: 'lineage_search_objects', description: 'Search.', inputSchema: z.object({ query: z.string() }) }];

/** Scripted transport: replies in order, records every request, fails loudly when the script runs out. */
function setup(wire: 'responses' | 'chat_completions', ...replies: unknown[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Json }> = [];
  const script = [...replies];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body) as Json });
    if (script.length === 0) throw new Error('script exhausted');
    return new Response(JSON.stringify(script.shift()), { headers: { 'content-type': 'application/json' } });
  };
  const records: WireRecord[] = [];
  const port = new OpenAiCompatiblePort({
    baseUrl: 'https://res.example/openai/v1', chatCompletionsUrl: wire === 'responses' ? URL_RESPONSES : URL_CHAT, wire,
    apiKey: SECRET, apiKeyHeader: 'api-key', model: 'gpt-6-luna', requestTuning: { reasoning: { effort: 'low' } },
  }, { fetchImpl, traceVerbose: true, wireLog: record => records.push(record) });
  return { port, calls, records };
}
const responses = (...replies: unknown[]) => setup('responses', ...replies);
const turn = (messages: ToolGenerationInput['messages'], extra: Partial<Pick<ToolGenerationInput, 'system' | 'toolChoice'>> = {}): ToolGenerationInput =>
  ({ messages, tools, phase: 'p', ...extra });
const call = (args: string, id = 'call_1') => ({ type: 'function_call', call_id: id, name: 'lineage_search_objects', arguments: args });
const text = (value: string) => ({ type: 'message', content: [{ type: 'output_text', text: value }] });
const reasoning = (id: string) => ({ type: 'reasoning', id, summary: [], encrypted_content: `ENC-${id}` });
const completed = (r: ToolGenerationResult) => {
  if (r.status !== 'completed') throw new Error(`expected completed, got ${r.status}`);
  return r;
};
const search = (id: string, query: string) => ({ callId: id, toolName: 'lineage_search_objects', input: { query } });

describe('responses wire request (D-106)', () => {
  it('sends input items, flat non-strict tools, reasoning effort, store false and the api-key header', async () => {
    const { port, calls: sent, records } = responses({ status: 'completed', output: [text('ok')] });
    completed(await port.generateToolTurn(turn([modelUserMessage('Find Sales.')], { system: 'Be brief.' })));
    const [{ url, headers, body }] = sent;
    expect(url).toBe(URL_RESPONSES);
    expect(headers['api-key']).toBe(SECRET);
    expect(headers.authorization).toBeUndefined();
    expect(body).toMatchObject({ model: 'gpt-6-luna', store: false, reasoning: { effort: 'low' }, tool_choice: 'auto' });
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.tools).toEqual([{ type: 'function', name: 'lineage_search_objects', description: 'Search.', strict: false, parameters: expect.any(Object) }]);
    expect(body.input).toEqual([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Find Sales.' }]);
    expect(records.find(r => r.type === 'provider-raw' && r.direction === 'request')).not.toHaveProperty('url');
    expect(JSON.stringify(records)).not.toContain(new URL(URL_RESPONSES).hostname);
  });

  it.each<[ToolGenerationInput['toolChoice'], unknown]>([
    ['required', 'required'],
    [{ type: 'tool', toolName: 'lineage_search_objects' }, { type: 'function', name: 'lineage_search_objects' }],
  ])('maps tool choice %j', async (toolChoice, expected) => {
    const { port, calls: sent } = responses({ status: 'completed', output: [text('ok')] });
    completed(await port.generateToolTurn(turn([modelUserMessage('q')], { toolChoice })));
    expect(sent[0].body.tool_choice).toEqual(expected);
  });

  it('keeps assistant text and its calls in request order within one turn', async () => {
    const { port, calls: sent } = responses({ status: 'completed', output: [text('ok')] });
    completed(await port.generateToolTurn(turn([
      modelUserMessage('q'),
      modelToolCallMessage([search('call_1', 'A'), search('call_2', 'B')], 'Looking.'),
      modelToolResultMessage('call_1', 'lineage_search_objects', 'a', 'success'),
      modelToolResultMessage('call_2', 'lineage_search_objects', 'b', 'success'),
      modelAssistantMessage('done'),
    ])));
    expect(sent[0].body.input).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'Looking.' },
      { type: 'function_call', call_id: 'call_1', name: 'lineage_search_objects', arguments: '{"query":"A"}' },
      { type: 'function_call', call_id: 'call_2', name: 'lineage_search_objects', arguments: '{"query":"B"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a' },
      { type: 'function_call_output', call_id: 'call_2', output: 'b' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

describe('responses wire decode (D-106)', () => {
  it.each([
    ['tool call', [call('{"query":"Sales"}')], '', [{ id: 'call_1', input: { query: 'Sales' } }]],
    ['text', [text('Hello')], 'Hello', []],
    ['text and call', [reasoning('r'), text('x'), call('{"query":"A"}', 'c2')], 'x', [{ id: 'c2', input: { query: 'A' } }]],
  ])('decodes %s', async (_name, output, expectedText, expectedCalls) => {
    const { port } = responses({ status: 'completed', output });
    const result = completed(await port.generateToolTurn(turn([modelUserMessage('q')])));
    expect(result.text).toBe(expectedText);
    expect(result.toolCalls.map(c => ({ valid: c.valid, id: c.callId, input: c.input }))).toEqual(
      expectedCalls.map(c => ({ valid: true, ...c })));
  });

  it.each([
    ['responses', { status: 'completed', output: [call('{"query":"S"}')], usage: {
      input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } }],
    ['chat_completions', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lineage_search_objects', arguments: '{"query":"S"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } } }],
  ] as const)('maps usage with cached tokens on the %s wire', async (wire, reply) => {
    const { port, records } = setup(wire, reply);
    completed(await port.generateToolTurn(turn([modelUserMessage('q')])));
    expect(records.find(r => r.type === 'generation')).toMatchObject({ usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17, reasoningTokens: 3, cachedTokens: 4 } });
  });

  it('records an incomplete response with its reason as the finish reason', async () => {
    const { port, records } = responses({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [text('cut')] });
    expect(completed(await port.generateToolTurn(turn([modelUserMessage('q')]))).text).toBe('cut');
    expect(records.find(r => r.type === 'generation')).toMatchObject({ finishReason: 'max_output_tokens' });
  });

  it.each([
    ['an error envelope', { error: { code: 'server_error', message: 'boom' }, output: [] }],
    ['no output', { status: 'completed' }],
    ['a call without call_id', { status: 'completed', output: [{ type: 'function_call', name: 'lineage_search_objects', arguments: '{}' }] }],
  ])('reports %s as a provider failure, not an answer', async (_name, reply) => {
    const { port } = responses(reply);
    expect((await port.generateToolTurn(turn([modelUserMessage('q')]))).status).toBe('error');
  });

  it.each(['{"query":', '', '[1]'])('keeps malformed arguments %j as evidence', async args => {
    const { port, records } = responses({ status: 'completed', output: [call(args)] });
    const result = completed(await port.generateToolTurn(turn([modelUserMessage('q')])));
    expect(result.toolCalls[0]).toMatchObject({ valid: false, code: 'type', input: args });
    expect(records.find(r => r.type === 'wire-response')).toMatchObject({ toolCalls: [{ input: args }] });
  });
});

describe('one normalization on both wires (D-103, D-086)', () => {
  const nested = [{ name: 'lineage_filter', description: 'Filter.', inputSchema: z.object({ filter: z.object({ kind: z.string() }) }) }];
  it.each([
    ['responses', { status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'lineage_filter', arguments: '{"filter":"{\\"kind\\":\\"table\\"}"}' }] }],
    ['chat_completions', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'lineage_filter', arguments: '{"filter":"{\\"kind\\":\\"table\\"}"}' } }] } }] }],
  ] as const)('opens a JSON-encoded object once on the %s wire', async (wire, reply) => {
    const { port } = setup(wire, reply);
    const result = completed(await port.generateToolTurn({ messages: [modelUserMessage('q')], tools: nested, phase: 'p' }));
    expect(result.toolCalls[0]).toMatchObject({ valid: true, input: { filter: { kind: 'table' } } });
  });
});

describe('responses wire reasoning round trip (D-106)', () => {
  it('returns each reasoning item directly ahead of its call, with text, and keeps the payload out of the trace', async () => {
    const { port, calls: sent, records } = responses(
      { status: 'completed', output: [reasoning('r1'), text('Looking.'), reasoning('r2'), call('{"query":"A"}', 'call_1'), reasoning('r3'), call('{"query":"B"}', 'call_2')] },
      { status: 'completed', output: [text('done')] },
    );
    const first = completed(await port.generateToolTurn(turn([modelUserMessage('q')])));
    completed(await port.generateToolTurn(turn([
      modelUserMessage('q'),
      first.message,
      modelToolResultMessage('call_1', 'lineage_search_objects', 'a', 'success'),
      modelToolResultMessage('call_2', 'lineage_search_objects', 'b', 'success'),
    ])));
    expect(sent[1].body.input).toEqual([
      { role: 'user', content: 'q' },
      reasoning('r1'),
      { role: 'assistant', content: 'Looking.' },
      reasoning('r2'),
      { type: 'function_call', call_id: 'call_1', name: 'lineage_search_objects', arguments: '{"query":"A"}' },
      reasoning('r3'),
      { type: 'function_call', call_id: 'call_2', name: 'lineage_search_objects', arguments: '{"query":"B"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a' },
      { type: 'function_call_output', call_id: 'call_2', output: 'b' },
    ]);
    expect(JSON.stringify(records)).not.toContain('ENC-r');
    expect(JSON.stringify(records)).toContain('[omitted');
  });
});
