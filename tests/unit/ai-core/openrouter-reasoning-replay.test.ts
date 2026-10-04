import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { OpenAiCompatiblePort, type OpenAiLaneCapabilities } from '../../harness/openAiCompatiblePort';

const details = [
  { type: 'reasoning.text', text: 'Inspect the requested object.', format: 'unknown', index: 0 },
  { type: 'reasoning.encrypted', data: 'opaque+/==', id: 'r-1', format: 'vendor', index: 1 },
  { type: 'reasoning.summary', summary: 'Continue with the tool result.', index: 2, extra: { untouched: true } },
];
const tool = { name: 'lineage_submit_findings', description: 'Submit findings', inputSchema: z.object({}).strict() };

async function replay(capabilities: OpenAiLaneCapabilities, textOnly = false) {
  const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const port = new OpenAiCompatiblePort({
    baseUrl: 'https://provider.invalid/v1', model: 'canned', apiKey: 'test', laneId: 'test', capabilities,
  }, {
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const first = bodies.length === 1;
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
        choices: [{ finish_reason: first && !textOnly ? 'tool_calls' : 'stop', message: first ? {
          role: 'assistant', content: textOnly ? 'A response' : null,
          reasoning_content: 'Existing text reasoning', reasoning_details: details,
          ...(!textOnly ? { tool_calls: ['a', 'b'].map(id => ({ id, type: 'function', function: { name: tool.name, arguments: '{}' } })) } : {}),
        } : { role: 'assistant', content: 'Done' } }],
      }) };
    },
  });
  const generated = await port.generateToolTurn({ messages: [new HumanMessage('Investigate')], tools: [tool], phase: 'investigate' });
  expect(generated.status).toBe('completed');
  if (generated.status !== 'completed') throw new Error('Canned response failed');
  const assistant = generated.message;
  await port.generateToolTurn({ messages: [new HumanMessage('Investigate'), assistant,
    ...(!textOnly ? ['a', 'b'].map(id => new ToolMessage({ content: 'Accepted', tool_call_id: id })) : []),
    new AIMessage({ content: 'Unrelated assistant' }),
  ], tools: [tool], phase: 'investigate' });
  return bodies[1].messages.filter(message => message.role === 'assistant');
}

describe('opaque provider reasoning replay', () => {
  it('preserves full ordered details on the matching parallel-tool turn only', async () => {
    const assistants = await replay({ echoReasoningDetails: true });
    expect(assistants[0].reasoning_details).toEqual(details);
    expect(JSON.stringify(assistants[0].reasoning_details)).toBe(JSON.stringify(details));
    expect(assistants[0].reasoning_content).toBeUndefined();
    expect(assistants[1].reasoning_details).toBeUndefined();
  });
  it('preserves details on a text-only assistant turn', async () => {
    expect((await replay({ echoReasoningDetails: true }, true))[0].reasoning_details).toEqual(details);
  });
  it('does not enable details for other lanes and retains text reasoning controls', async () => {
    for (const echoReasoning of [false, true]) {
      const assistants = await replay({ echoReasoning });
      expect(assistants[0].reasoning_details).toBeUndefined();
      expect(assistants[0].reasoning_content).toBe(echoReasoning ? 'Existing text reasoning' : undefined);
    }
  });
});
