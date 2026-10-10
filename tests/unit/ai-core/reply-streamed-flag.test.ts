/**
 * A failed generation reports whether reply text already reached the chat, so the graph's single
 * transport retry never sends a second reply after the first one was partly shown.
 */
import { describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import { executeToolAttempt } from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ScriptedModelPort, scriptedRegistry, type ScriptedGeneration } from '../../harness/scriptedModelPort';

const transport: ScriptedGeneration = {
  status: 'error',
  error: 'The AI provider connection was interrupted (ECONNRESET).',
  providerError: { phase: 'discover', name: 'Error', message: 'socket hang up', code: 'ECONNRESET' },
};

function plan(buffered: boolean) {
  const { registry } = scriptedRegistry([{ name: 'lineage_search_objects', result: '{}' }]);
  return compileInstructionPlan({
    kind: 'converse', stage: { kind: 'discover' }, registry,
    messages: [new HumanMessage('Which objects read Orders?')], sink: new TurnEventSink(() => {}),
    facts: { memorySections: [] }, toolChoice: 'auto',
    ...(buffered ? { proseGate: 'buffer-until-tool' as const } : {}),
  });
}

describe('replyStreamed on a failed generation', () => {
  it('is set when a streamed delta preceded the interruption', async () => {
    const result = await executeToolAttempt(new ScriptedModelPort([{ ...transport, textDeltas: ['Partial answer'] }]), plan(false));
    expect(result.stop).toBe('error');
    expect(result.replyStreamed).toBe(true);
  });

  it('is absent when nothing streamed before the interruption', async () => {
    const result = await executeToolAttempt(new ScriptedModelPort([{ ...transport, textDeltas: [''] }]), plan(false));
    expect(result.stop).toBe('error');
    expect(result.replyStreamed).toBeUndefined();
  });

  it('is absent when the phase buffers prose until a tool call', async () => {
    const result = await executeToolAttempt(new ScriptedModelPort([{ ...transport, textDeltas: ['Partial answer'] }]), plan(true));
    expect(result.stop).toBe('error');
    expect(result.replyStreamed).toBeUndefined();
  });
});
