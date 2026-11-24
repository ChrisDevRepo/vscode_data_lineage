import { AIMessageChunk } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { transcriptTurn } from '../../../src/ai/model/modelPort';
import { STRUCTURED_OUTPUT_TOOL, StructuredOutputError } from '../../../src/ai/providers/structuredOutput';
import { ProviderModelPort, type ModelTransport } from '../../../src/ai/model/providerModelPort';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';

/**
 * Pins the streamed tool-call decode of the provider port: a call whose arguments are not valid
 * JSON must not end the turn. It reaches the tool boundary with the text as streamed, and that
 * boundary rejects it by call id.
 */
const schema = z.object({ sections: z.object({ technical: z.string() }) });

function portStreaming(argChunks: string[], toolName = 'lineage_present_result'): ProviderModelPort {
  const transport: ModelTransport = {
    id: 'test',
    identity: { id: 'm', name: 'm', vendor: 'v', family: 'f', version: '1' },
    countTokens: async () => 1,
    async *stream() {
      for (const [index, args] of argChunks.entries()) {
        yield new AIMessageChunk({
          content: '',
          tool_call_chunks: [{ type: 'tool_call_chunk', index: 0, id: index === 0 ? 'call_1' : undefined, name: index === 0 ? toolName : undefined, args }],
        });
      }
      yield new AIMessageChunk({ content: '', response_metadata: { streamEnd: true } });
    },
  };
  return new ProviderModelPort(transport);
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
});
