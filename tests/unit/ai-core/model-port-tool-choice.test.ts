import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { VscodeModelPort, emittedToolCalls } from '../../../src/ai/model/vscodeModelPort';
import type { ModelToolChoice } from '../../../src/ai/model/modelPort';

function nativePort() {
  const sendRequest = vi.fn(async (_messages: unknown, _options: unknown) => ({
    stream: { async *[Symbol.asyncIterator]() { yield new vscode.LanguageModelTextPart('answer'); } },
  }));
  const port = new VscodeModelPort({
    id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1',
    maxInputTokens: 128000, countTokens: async () => 1, sendRequest,
  } as never);
  return { port, sendRequest };
}

const searchTool = {
  name: 'lineage_search_objects',
  description: 'Search objects.',
  inputSchema: z.object({ query: z.string() }),
};

describe('VscodeModelPort tool-choice projection', () => {
  const unsatisfiable: Array<[string, ModelToolChoice, readonly (typeof searchTool)[]]> = [
    ['required with no tools', 'required', []],
    ['a named tool that is not offered', { type: 'tool', toolName: 'lineage_present_result' }, [searchTool]],
  ];
  for (const [label, toolChoice, tools] of unsatisfiable) {
    it(`fails before sending when the choice cannot be met: ${label}`, async () => {
      const { port, sendRequest } = nativePort();
      const result = await port.generateToolTurn({
        messages: [new HumanMessage('question')], tools, toolChoice, phase: 'test',
      });
      expect(result.status).toBe('error');
      expect(sendRequest).not.toHaveBeenCalled();
    });
  }

  it('sends a tool-free request for auto choice without tools', async () => {
    const { port, sendRequest } = nativePort();
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('question')], tools: [], toolChoice: 'auto', phase: 'test',
    });
    expect(result.status).toBe('completed');
    expect(result.text).toBe('answer');
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest.mock.calls[0]?.[1]).toEqual({});
  });

  it.each([
    ['without a call ID', [new vscode.LanguageModelToolCallPart('', 'lineage_search_objects', { query: 'x' })], 'error'],
    ['with call IDs', [new vscode.LanguageModelToolCallPart('call-1', 'lineage_search_objects', { query: 'x' })], 'completed'],
  ] as const)('validates every emitted tool call %s', async (_label, parts, status) => {
    const sendRequest = vi.fn(async () => ({
      stream: { async *[Symbol.asyncIterator]() { yield* parts; } },
    }));
    const port = new VscodeModelPort({
      id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1',
      maxInputTokens: 128000, countTokens: async () => 1, sendRequest,
    } as never);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('question')], tools: [searchTool], toolChoice: 'auto', phase: 'test',
    });
    expect(result.status).toBe(status);
    if (result.status === 'completed') {
      expect(result.toolCalls).toEqual([{ valid: true, callId: 'call-1', toolName: 'lineage_search_objects', input: { query: 'x' } }]);
    }
  });
});

describe('model payload identity', () => {
  it.each(['["A","B"]', 'null', '{"name":"A"}', '{"name":"cut', '{"name":"raw\nline"}', '{"name":"A"', '["A","B"', '{"name":"A"} trailing', 'nul'])('passes %s unchanged to the tool validator and rejects it as structured data', async raw => {
    const schema = z.object({ values: z.union([z.array(z.string()), z.object({ name: z.string() })]).nullable(), name: z.string().nullable() }).strict();
    const payload = { values: raw, name: 'null' };
    const sendRequest = vi.fn(async (_messages: unknown, options: { tools?: Array<{ name: string }> }) => ({
      stream: { async *[Symbol.asyncIterator]() {
        yield new vscode.LanguageModelToolCallPart('call-1', options.tools![0].name, payload);
      } },
    }));
    const port = new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1',
      maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never);
    const result = await port.generateToolTurn({ messages: [new HumanMessage('question')],
      tools: [{ name: 'lineage_example', description: 'Example.', inputSchema: schema }], toolChoice: 'auto', phase: 'test' });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.toolCalls[0].input).toEqual(payload);
      expect(schema.safeParse(result.toolCalls[0].input).success).toBe(false);
    }
    await expect(port.generateStructured({ messages: [new HumanMessage('question')], schema })).rejects.toMatchObject({ code: 'invalid_structured_output' });
  });
});

describe('emittedToolCalls', () => {
  it('keeps every call in order when the stream chunks cannot be paired with the calls', () => {
    const message = {
      tool_calls: [
        { id: 'a', name: 'lineage_search_objects', args: { query: 'a' } },
        { id: 'b', name: 'lineage_search_objects', args: { query: 'b' } },
        { id: 'c', name: 'lineage_search_objects', args: { query: 'c' } },
      ],
      invalid_tool_calls: [{ id: 'd', name: 'lineage_search_objects', args: '{bad' }],
      tool_call_chunks: [],
    };
    expect(emittedToolCalls(message as never)).toEqual([
      { id: 'a', name: 'lineage_search_objects', args: { query: 'a' } },
      { id: 'b', name: 'lineage_search_objects', args: { query: 'b' } },
      { id: 'c', name: 'lineage_search_objects', args: { query: 'c' } },
      { id: 'd', name: 'lineage_search_objects', malformedArgs: '{bad' },
    ]);
  });
});
