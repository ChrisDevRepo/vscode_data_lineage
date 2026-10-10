/**
 * A read whose body is refused as `result_too_large` stores no evidence: it never counts as
 * progress, so a run of oversize reads ends the phase on the reply limit, and the discovery
 * salvage never asks for an answer when every held observation is such a refusal.
 */
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { MAX_TOOL_PROVIDER_CALLS } from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { ScriptedModelPort, scriptedRegistry, validCall } from '../../harness/scriptedModelPort';

/** A canonical-looking read body far above any stored-evidence share. */
const OVERSIZE = JSON.stringify({ objects: 'x'.repeat(4_000_000) });

describe('oversize discovery reads', () => {
  it('ends discovery on the reply limit without a salvage answer when every read was refused as too large', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const { registry, invocations } = scriptedRegistry([{ name: 'lineage_search_objects', result: OVERSIZE }]);
    const reads = Array.from({ length: MAX_TOOL_PROVIDER_CALLS }, (_, i) => ({
      toolCalls: [validCall(`read-${i}`, 'lineage_search_objects', { query: `Origin${i}` })],
    }));
    const model = new ScriptedModelPort([...reads, { text: 'Origin is fed by three tables.' }], [], [{ entry: 'discovery', targetColumns: null }]);
    const runtime = new AgentRuntime({
      threadId: 'oversize-read-progress',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink: new TurnEventSink(() => {}),
      turnEpoch: epoch,
      maxRounds: 20,
    });

    const outcome = await runtime.run('What feeds Origin?');

    expect(invocations).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
    expect(model.modelCalls, 'no salvage generation over refused observations').toBe(MAX_TOOL_PROVIDER_CALLS);
    expect(outcome).not.toBe('ok');
  });

  it('states the narrowing repair and the replies left, and hides the machine code', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const { registry } = scriptedRegistry([{ name: 'lineage_search_objects', result: OVERSIZE }]);
    const reads = Array.from({ length: MAX_TOOL_PROVIDER_CALLS }, (_, i) => ({
      toolCalls: [validCall(`read-${i}`, 'lineage_search_objects', { query: `Origin${i}` })],
    }));
    const model = new ScriptedModelPort(reads, [], [{ entry: 'discovery', targetColumns: null }]);
    const runtime = new AgentRuntime({
      threadId: 'oversize-read-repair-text',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink: new TurnEventSink(() => {}),
      turnEpoch: epoch,
      maxRounds: 20,
    });

    await runtime.run('What feeds Origin?');

    const toolText = (requestIndex: number): string => model.requests[requestIndex]!.messages
      .filter((message): message is ToolMessage => message instanceof ToolMessage)
      .map(message => String(message.content))
      .join('\n');
    const first = toolText(1);
    const second = toolText(2);
    expect(first).toContain('Narrow the request');
    expect(first).not.toContain('result_too_large');
    expect(first).toMatch(/2 replies left for this step\.$/);
    expect(second).toMatch(/Last reply for this step\.$/);
    expect(second).not.toContain('result_too_large');
  });
});


describe('discovery evidence on selected model windows', () => {
  it.each([8192, 131_072, undefined])('retains small reads and answers on a %s-token model window', async modelWindowTokens => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const result = JSON.stringify({ objects: [{ id: '[ai].[Origin]' }] });
    const { registry, invocations } = scriptedRegistry([{ name: 'lineage_search_objects', result }]);
    const reads = Array.from({ length: MAX_TOOL_PROVIDER_CALLS }, (_, i) => ({
      toolCalls: [validCall(`small-${i}`, 'lineage_search_objects', { query: `Origin${i}` })],
    }));
    const model = new ScriptedModelPort([...reads, { text: 'Origin is a view.' }], [],
      [{ entry: 'discovery', targetColumns: null }], createTurnTokenBudget({ modelWindowTokens }));
    const runtime = new AgentRuntime({ threadId: `small-read-${modelWindowTokens}`, getSession: () => session,
      model: model as unknown as ModelPort, registry, sink: new TurnEventSink(() => {}), turnEpoch: epoch });
    expect(await runtime.run('What is Origin?')).toBe('ok');
    expect(invocations).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
    expect(model.modelCalls).toBe(MAX_TOOL_PROVIDER_CALLS + 1);
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(result.replaceAll('"', '\\"'));
    expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('result_too_large');
  });
});
