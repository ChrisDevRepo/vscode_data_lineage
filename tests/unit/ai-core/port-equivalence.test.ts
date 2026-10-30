/** The headless harness port measures the product path (D-086): the same recorded tool calls give the same classification, replay and finished structured payload on both ports. Fake transports, no provider call. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as vscode from 'vscode';
import { modelUserMessage, type ModelPort } from '../../../src/ai/model/modelPort';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { STRUCTURED_OUTPUT_TOOL, StructuredOutputError } from '../../../src/ai/providers/structuredOutput';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';

/** One recorded provider tool call: the arguments text exactly as the wire carried it. */
type Recorded = { readonly id: string; readonly name: string; readonly arguments: string };

/** The product port over a VS Code model that streams the recorded calls; the host hands over decoded JSON. */
function productPort(calls: readonly Recorded[]): ModelPort {
  return new VscodeModelPort({ id: 'equivalence', countTokens: async () => 1, sendRequest: async () => ({ stream: {
    async *[Symbol.asyncIterator]() {
      for (const call of calls) yield new vscode.LanguageModelToolCallPart(call.id, call.name, JSON.parse(call.arguments));
    },
  } }) } as never);
}

/** The harness port over a chat-completions reply that carries the recorded calls verbatim. */
function harnessPort(calls: readonly Recorded[]): ModelPort {
  const reply = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: calls.map(call =>
    ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } }] };
  const fetchImpl: FetchLike = async () => new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  return new OpenAiCompatiblePort({ baseUrl: 'https://eq.example/v1', apiKey: 'synthetic', model: 'eq' }, { fetchImpl });
}

const ports = [['product', productPort], ['harness', harnessPort]] as const;
const levels = z.object({ query: z.string(), levels: z.number().int() }).strict();
const tools = [{ name: 'lineage_levels', description: 'Levels.', inputSchema: levels }];

async function toolTurn(port: ModelPort) {
  const result = await port.generateToolTurn({ messages: [modelUserMessage('q')], tools, phase: 'eq' });
  if (result.status !== 'completed') return { status: result.status };
  return {
    status: result.status,
    toolCalls: result.toolCalls,
    replayed: (result.message.tool_calls ?? []).map(({ id, name, args }) => ({ id, name, args })),
  };
}

async function structured(port: ModelPort) {
  try {
    return { value: await port.generateStructured({ messages: [modelUserMessage('q')], schema: levels, phase: 'eq' }) };
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;
    const notation = error.errors.filter(fault => fault.code === 'tool_call_notation');
    return { code: error.code, reason: error.reason, ...(notation.length ? { notation } : {}) };
  }
}

const toolCases: ReadonlyArray<readonly [string, readonly Recorded[], unknown]> = [
  ['a valid call, normalized once', [{ id: 'c1', name: 'lineage_levels', arguments: '{"query":"x","levels":"2"}' }], {
    status: 'completed',
    toolCalls: [{ valid: true, callId: 'c1', toolName: 'lineage_levels', input: { query: 'x', levels: 2 } }],
    replayed: [{ id: 'c1', name: 'lineage_levels', args: { query: 'x', levels: '2' } }],
  }],
  ['an unknown tool', [{ id: 'c1', name: 'lineage_missing', arguments: '{"query":"x"}' }], {
    status: 'completed',
    toolCalls: [{ valid: false, callId: 'c1', toolName: 'lineage_missing', input: { query: 'x' }, code: 'off_policy', reason: 'Tool is not available in this phase.' }],
    replayed: [{ id: 'c1', name: 'lineage_missing', args: { query: 'x' } }],
  }],
  ['arguments that are no object', [{ id: 'c1', name: 'lineage_levels', arguments: '"x"' }], {
    status: 'completed',
    toolCalls: [{ valid: false, callId: 'c1', toolName: 'lineage_levels', input: '"x"', code: 'type',
      reason: 'Tool arguments were not a JSON object; send the required fields as one JSON object.' }],
    replayed: [{ id: 'c1', name: 'lineage_levels', args: {} }],
  }],
  ['an unknown tool whose arguments are no object', [{ id: 'c1', name: 'lineage_missing', arguments: '"x"' }], {
    status: 'completed',
    toolCalls: [{ valid: false, callId: 'c1', toolName: 'lineage_missing', input: '"x"', code: 'off_policy', reason: 'Tool is not available in this phase.' }],
    replayed: [{ id: 'c1', name: 'lineage_missing', args: {} }],
  }],
];

describe('tool-call classification is the same on both ports', () => {
  for (const [label, calls, expected] of toolCases) {
    it.each(ports)(`${label} (%s)`, async (_name, make) => {
      expect(await toolTurn(make(calls))).toEqual(expected);
    });
  }
});

const structuredCall = (args: string, id = 's1'): Recorded => ({ id, name: STRUCTURED_OUTPUT_TOOL, arguments: args });
const structuredCases: ReadonlyArray<readonly [string, readonly Recorded[], unknown]> = [
  ['a payload that parses as sent', [structuredCall('{"query":"x","levels":2}')], { value: { query: 'x', levels: 2 } }],
  ['a payload that parses after normalization', [structuredCall('{"query":"x","levels":"2"}')], { value: { query: 'x', levels: 2 } }],
  ['an empty payload', [structuredCall('{}')], { code: 'invalid_input', reason: `${STRUCTURED_OUTPUT_TOOL} arguments were empty` }],
  ['arguments that are no object', [structuredCall('"x"')], { code: 'invalid_input', reason: `${STRUCTURED_OUTPUT_TOOL} arguments were not a JSON object` }],
  ['two payloads', [structuredCall('{"query":"x"}', 's1'), structuredCall('{"query":"y"}', 's2')],
    { code: 'invalid_input', reason: `multiple ${STRUCTURED_OUTPUT_TOOL} tool calls` }],
  ['a foreign tool call beside the payload', [{ id: 'f1', name: 'lineage_levels', arguments: '{"query":"x"}' }, structuredCall('{"query":"x","levels":2}')],
    { code: 'invalid_input', reason: `unexpected tool call alongside ${STRUCTURED_OUTPUT_TOOL}` }],
  ['a payload beside one whose arguments are no object', [structuredCall('{"query":"x","levels":2}', 's1'), structuredCall('"x"', 's2')],
    { code: 'invalid_input', reason: `unexpected tool call alongside ${STRUCTURED_OUTPUT_TOOL}` }],
  ['two payloads whose arguments are no object', [structuredCall('"x"', 's1'), structuredCall('"y"', 's2')],
    { code: 'invalid_input', reason: `${STRUCTURED_OUTPUT_TOOL} arguments were not a JSON object` }],
  ['a payload carrying tool-call notation', [structuredCall('{"query":"x</parameter>","levels":2}')], { code: 'invalid_input',
    reason: 'query: contains tool-call notation (`<parameter name=…>`, `</parameter>`, `<invoke name=…>`, `</invoke>`); a field holds its own value only.',
    notation: [{ path: 'query', code: 'tool_call_notation' }] }],
];

describe('the finished structured payload is the same on both ports', () => {
  for (const [label, calls, expected] of structuredCases) {
    it.each(ports)(`${label} (%s)`, async (_name, make) => {
      expect(await structured(make(calls))).toEqual(expected);
    });
  }
});

describe('the served JSON Schema alone admits a structured payload (D-126)', () => {
  const generate = (port: ModelPort, schema: z.ZodType) => port.generateStructured({ messages: [modelUserMessage('q')], schema, phase: 'eq' });
  it.each(ports)('rejects a value Zod would coerce and keeps every sent property (%s)', async (_name, make) => {
    await expect(generate(make([structuredCall('{"query":5}')]), z.object({ query: z.coerce.string() }).strict()))
      .rejects.toMatchObject({ code: 'invalid_input', errors: [{ path: 'query', code: 'type', values: ['string'] }] });
    await expect(generate(make([structuredCall('{"query":"x","extra":1}')]), z.object({ query: z.string() }))).resolves.toEqual({ query: 'x', extra: 1 });
  });
});

describe('blank arguments, which only the HTTP wire can carry', () => {
  it('charges a blank tool call to the call and a blank structured payload as empty', async () => {
    expect(await toolTurn(harnessPort([{ id: 'c1', name: 'lineage_levels', arguments: ' ' }]))).toMatchObject({
      toolCalls: [{ valid: false, input: ' ', code: 'type', reason: 'Tool arguments were empty; send the required fields as a JSON object.' }],
      replayed: [{ id: 'c1', args: {} }],
    });
    expect(await structured(harnessPort([structuredCall('')]))).toEqual({ code: 'invalid_input', reason: `${STRUCTURED_OUTPUT_TOOL} arguments were empty` });
  });
});
