import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';
import { transcriptTurn } from '../../../src/ai/model/modelPort';
import { STRUCTURED_OUTPUT_TOOL, StructuredOutputError } from '../../../src/ai/providers/structuredOutput';
import { ProviderModelPort } from '../../../src/ai/model/providerModelPort';
import { scriptedChat } from './helpers/scriptedChat';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';

/**
 * Pins the streamed tool-call decode of the provider port: a call whose arguments are not valid
 * JSON must not end the turn. It reaches the tool boundary with the text as streamed, and that
 * boundary rejects it by call id.
 */
const schema = z.object({ sections: z.object({ technical: z.string() }) });

function portStreaming(argChunks: string[], toolName = 'lineage_present_result'): ProviderModelPort {
  return new ProviderModelPort(scriptedChat([
    ...argChunks.map((args, index) => new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ type: 'tool_call_chunk', index: 0, id: index === 0 ? 'call_1' : undefined, name: index === 0 ? toolName : undefined, args }],
    })),
    new AIMessageChunk({ content: '', response_metadata: { finish_reason: 'tool_calls' } }),
  ]));
}

const turn = (port: ProviderModelPort) => port.generateToolTurn({
  messages: [],
  tools: [{ name: 'lineage_present_result', description: 'd', inputSchema: schema }],
  phase: 'test',
});

describe('ProviderModelPort streamed tool-call arguments', () => {
  it('hands a call with arguments that are not valid JSON to the boundary, which rejects it by id', async () => {
    const result = await turn(portStreaming(['{"sections":{"technical":"cu']));
    expect(result.status).toBe('completed');
    const call = result.toolCalls[0];
    expect(call).toMatchObject({ valid: true, callId: 'call_1', toolName: 'lineage_present_result', input: '{"sections":{"technical":"cu' });
    const parsed = schema.safeParse((call as { input: unknown }).input);
    expect(parsed.success).toBe(false);
    const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_input', input: (call as { input: unknown }).input, schema });
    expect(rejection.reason).toContain('not valid JSON: the text ends before the object closes');
  });

  it('still decodes arguments that are valid JSON, across chunks', async () => {
    const result = await turn(portStreaming(['{"sections":{"tech', 'nical":"x"}}']));
    expect(result.toolCalls[0]).toMatchObject({ valid: true, callId: 'call_1', input: { sections: { technical: 'x' } } });
  });

  it('replays a malformed call with empty arguments, not as LangChain completes it, and a valid call unchanged', async () => {
    const cut = '{"sections":{"technical":"cu';
    const result = await turn(portStreaming([cut]));
    if (result.status !== 'completed') throw new Error('turn failed');
    // LangChain completes the cut text into an object; the replayed turn must not carry that.
    expect(result.message.tool_calls?.[0]?.args).toEqual({ sections: { technical: 'cu' } });
    const replayed = transcriptTurn(result.message, result.toolCalls);
    expect(replayed.tool_calls).toEqual([{ id: 'call_1', name: 'lineage_present_result', args: {}, type: 'tool_call' }]);

    const valid = await turn(portStreaming(['{"sections":{"technical":"x"}}']));
    if (valid.status !== 'completed') throw new Error('turn failed');
    expect(transcriptTurn(valid.message, valid.toolCalls)).toBe(valid.message);

    // A JSON string literal parses, but is no object: it replays as empty arguments too.
    const literal = await turn(portStreaming(['"abc"']));
    if (literal.status !== 'completed') throw new Error('turn failed');
    expect(transcriptTurn(literal.message, literal.toolCalls).tool_calls?.[0]?.args).toEqual({});
  });

  it('files a structured output with malformed arguments as a structured rejection, not a SyntaxError', async () => {
    const error = await portStreaming(['{"sections":{"technical":"cu'], STRUCTURED_OUTPUT_TOOL)
      .generateStructured({ messages: [], schema, phase: 'test' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).code).toBe('invalid_structured_output');
    expect((error as StructuredOutputError).reason).toContain('not valid JSON: the text ends before the object closes');
  });

  it('disambiguates a repeated tool_call id so transcriptTurn and paired ToolMessages satisfy 1:1 pairing', async () => {
    const port = new ProviderModelPort(scriptedChat([
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { type: 'tool_call_chunk', index: 0, id: 'call_dup', name: 'lineage_present_result', args: '{"sections":{"technical":"first"}}' },
          { type: 'tool_call_chunk', index: 1, id: 'call_dup', name: 'lineage_present_result', args: '{"sections":{"technical":"second"}}' },
        ],
      }),
      new AIMessageChunk({ content: '', response_metadata: { finish_reason: 'tool_calls' } }),
    ]));
    const result = await turn(port);
    if (result.status !== 'completed') throw new Error('turn failed');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({
      valid: true,
      callId: 'call_dup',
      toolName: 'lineage_present_result',
      input: { sections: { technical: 'first' } },
    });
    expect(result.toolCalls[1]).toMatchObject({
      valid: false,
      code: 'duplicate_call_id',
      toolName: 'lineage_present_result',
    });
    const dupCallId = result.toolCalls[1].callId;
    expect(dupCallId).not.toBe('call_dup');

    const replayed = transcriptTurn(result.message, result.toolCalls);
    expect(replayed.tool_calls).toEqual([
      { id: 'call_dup', name: 'lineage_present_result', args: { sections: { technical: 'first' } }, type: 'tool_call' },
      { id: dupCallId, name: 'lineage_present_result', args: {}, type: 'tool_call' },
    ]);
    expect(() => assertToolPairingWellFormed([
      new HumanMessage('go'),
      replayed,
      new ToolMessage({ tool_call_id: 'call_dup', content: 'ok' }),
      new ToolMessage({ tool_call_id: dupCallId, content: 'duplicate', status: 'error' }),
    ])).not.toThrow();
  });

  it('avoids colliding with another emitted tool_call id when minting a duplicate id', async () => {
    const port = new ProviderModelPort(scriptedChat([
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { type: 'tool_call_chunk', index: 0, id: 'call_dup', name: 'lineage_present_result', args: '{"sections":{"technical":"a"}}' },
          { type: 'tool_call_chunk', index: 1, id: 'call_dup', name: 'lineage_present_result', args: '{"sections":{"technical":"b"}}' },
          { type: 'tool_call_chunk', index: 2, id: 'call_dup_dup_1', name: 'lineage_present_result', args: '{"sections":{"technical":"c"}}' },
        ],
      }),
      new AIMessageChunk({ content: '', response_metadata: { finish_reason: 'tool_calls' } }),
    ]));
    const result = await turn(port);
    if (result.status !== 'completed') throw new Error('turn failed');
    const ids = result.toolCalls.map((call) => call.callId);
    expect(new Set(ids).size).toBe(3);
    expect(result.toolCalls[0]).toMatchObject({ valid: true, callId: 'call_dup' });
    expect(result.toolCalls[1]).toMatchObject({ valid: false, code: 'duplicate_call_id' });
    expect(result.toolCalls[2]).toMatchObject({ valid: true, callId: 'call_dup_dup_1' });
  });

  it('assertToolPairingWellFormed rejects an AIMessage with duplicate tool_calls[].id or duplicate ToolMessages', () => {
    const duplicateAssistant = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_dup', name: 'lineage_present_result', args: { sections: { technical: 'a' } }, type: 'tool_call' },
        { id: 'call_dup', name: 'lineage_present_result', args: { sections: { technical: 'b' } }, type: 'tool_call' },
      ],
    });
    expect(() => assertToolPairingWellFormed([
      new HumanMessage('go'),
      duplicateAssistant,
      new ToolMessage({ tool_call_id: 'call_dup', content: 'ok' }),
    ])).toThrow(/duplicate/i);
    expect(() => assertToolPairingWellFormed([
      new HumanMessage('go'),
      duplicateAssistant,
      new ToolMessage({ tool_call_id: 'call_dup', content: 'ok' }),
      new ToolMessage({ tool_call_id: 'call_dup', content: 'dup', status: 'error' }),
    ])).toThrow(/duplicate/i);

    const singleAssistant = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'lineage_present_result', args: { sections: { technical: 'a' } }, type: 'tool_call' },
      ],
    });
    expect(() => assertToolPairingWellFormed([
      new HumanMessage('go'),
      singleAssistant,
      new ToolMessage({ tool_call_id: 'call_1', content: 'ok' }),
      new ToolMessage({ tool_call_id: 'call_1', content: 'extra' }),
    ])).toThrow(/duplicate/i);
  });
});
