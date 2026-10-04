/**
 * Pins that the turn's `AbortSignal` rides `graph.invoke`'s `RunnableConfig.signal`, so LangGraph
 * itself stops the run at the next step after a cancel and no further model call is made.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { PREVIEW_REQUEST_MARKER } from '../../../src/ai/prompting/prompts';
import { MAX_TOOL_PROVIDER_CALLS } from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { ScriptedModelPort, invalidCall, scriptedRegistry } from '../../harness/scriptedModelPort';

describe('AgentRuntime — cancel rides the LangGraph run config', () => {
  it('stops the graph after the model call during which the user cancelled', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.storeDiscoveryScope({
      turnEpoch: epoch,
      origin: '[ai].[Origin]',
      direction: 'upstream',
      nodeIds: ['[ai].[Origin]'],
      edges: [],
    }, epoch);
    session.settleDiscoveryTurn(
      epoch,
      'What feeds Origin?',
      'Origin has no upstream dependencies.',
      { origin: '[ai].[Origin]', walkCount: 1 },
      false,
    );
    const { registry } = scriptedRegistry([{ name: 'lineage_present_result', result: '{"ok":true}' }]);
    const script = Array.from({ length: MAX_TOOL_PROVIDER_CALLS }, (_, i) => ({
      toolCalls: [invalidCall(`present-${i}`, 'lineage_present_result', 'invalid_tool_input', 'sections.0.text: Required', ['sections.0.text'])],
    }));
    const scripted = new ScriptedModelPort(script);
    const controller = new AbortController();
    let modelCalls = 0;
    const model = new Proxy(scripted, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function' || !['generateToolTurn', 'generateStructured', 'completeText'].includes(String(key))) return value;
        return (...args: unknown[]) => {
          modelCalls += 1;
          controller.abort();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const runtime = new AgentRuntime({
      threadId: 'runtime-abort-signal',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink: new TurnEventSink(() => {}),
      signal: controller.signal,
      turnEpoch: epoch,
      maxRounds: 10,
    });

    const outcome = await runtime.run(PREVIEW_REQUEST_MARKER);

    expect(outcome).toBe('cancelled');
    expect(modelCalls, 'no model call after the cancel').toBe(1);
  });
});
