/**
 * A provider failure in a forced structured generation (the entry classification) follows the
 * contract of the tool phases: one retry after a connection-level interruption, then the turn ends
 * with the `provider_error` stop reason and the same user text; a provider verdict is never retried.
 * Scripted replies exercise graph wiring only; they say nothing about inference.
 */
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import { messageContentToText, ModelPortError, type GenerateStructuredInput, type ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { ScriptedModelPort, scriptedRegistry } from '../../harness/scriptedModelPort';

const view = '[d].[view]', table = '[d].[table]';

function seed(session: AiSession): void {
  const nodes: LineageNode[] = [
    makeNode({ id: view, schema: 'd', name: 'view', type: 'view', bodyScript: `CREATE VIEW ${view} AS SELECT 1 AS Value FROM ${table}` }),
    makeNode({ id: table, schema: 'd', name: 'table', type: 'table' }),
  ];
  const edges: Array<[string, string]> = [[table, view]];
  session.model = makeModel(nodes, edges, ['d']);
  session.graph = makeGraph(nodes, edges);
}

/** What the headless and VS Code ports throw for a failed request: the port code, the cause chain on `cause`. */
function providerFailure(message: string, causeCode: string): ModelPortError {
  return new ModelPortError('provider_error', message, Object.assign(new Error(message), { code: causeCode }));
}

/** Counts each structured generation as a provider call, as the VS Code port does. */
class CountingStructuredPort extends ScriptedModelPort {
  public override get modelCalls(): number {
    return super.modelCalls + this.structuredCallCount;
  }
}

/** Keeps each structured request so a test can read the correction the next classification sees. */
class RecordingStructuredPort extends CountingStructuredPort {
  public readonly structuredRequests: Array<GenerateStructuredInput<unknown>> = [];

  public override async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    this.structuredRequests.push(input);
    return super.generateStructured(input);
  }
}

function world(structured: readonly unknown[], lines: string[] = [], Port: typeof ScriptedModelPort = ScriptedModelPort) {
  const session = new AiSession();
  seed(session);
  const epoch = session.beginTurn();
  const { registry } = scriptedRegistry([]);
  const model = new Port([{ text: 'Done.' }], [], structured);
  const runtime = new AgentRuntime({
    threadId: 'structured-provider', getSession: () => session, model: model as unknown as ModelPort, registry,
    sink: new TurnEventSink(() => {}), turnEpoch: epoch, maxRounds: 10, transportRetryDelayMs: 0,
    logger: { debug: (m: string) => lines.push(m), info: () => {}, warn: () => {}, error: () => {}, trace: () => {} } as never,
  });
  return { runtime, model, lines };
}

describe('structured generation provider failure (entry classification)', () => {
  const route = { entry: 'discovery', targetColumns: null };

  it('retries one connection-level interruption and continues with the retried classification', async () => {
    const w = world([providerFailure('fetch failed', 'ECONNRESET'), route]);
    expect(await w.runtime.run('Show me the objects')).toBe('ok');
    expect(w.model.structuredCallCount).toBe(2);
    expect(w.lines.some(line => line.includes('transport-retry phase=detect_entry'))).toBe(true);
  });

  it('charges only the retried generation when the retry returns schema-invalid output', async () => {
    const invalid = { entry: 'not-an-entry' };
    const w = world([providerFailure('fetch failed', 'ECONNRESET'), invalid, invalid, route], [], CountingStructuredPort);
    expect(await w.runtime.run('Show me the objects')).toBe('ok');
    expect(w.model.structuredCallCount).toBe(4);
    expect(w.lines.some(line => line.includes('phase=detect_entry providerCalls=1 noProgressCalls=1'))).toBe(true);
  });

  it('states the replies left on a schema-invalid entry classification, without a tool result', async () => {
    const invalid = { entry: 'not-an-entry' };
    const session = new AiSession();
    seed(session);
    const epoch = session.beginTurn();
    const { registry } = scriptedRegistry([]);
    const model = new RecordingStructuredPort([{ text: 'Done.' }], [], [invalid, invalid, route]);
    const runtime = new AgentRuntime({
      threadId: 'structured-entry-repair', getSession: () => session, model: model as unknown as ModelPort, registry,
      sink: new TurnEventSink(() => {}), turnEpoch: epoch, maxRounds: 10, transportRetryDelayMs: 0,
    });

    expect(await runtime.run('Show me the objects')).toBe('ok');

    const corrections = (requestIndex: number): string[] => model.structuredRequests[requestIndex]!.messages
      .filter((message): message is HumanMessage => message instanceof HumanMessage)
      .map(message => messageContentToText(message.content))
      .filter(text => text.startsWith('Correction for entry_detection:'));
    const hasToolResult = (requestIndex: number): boolean =>
      model.structuredRequests[requestIndex]!.messages.some(message => message instanceof ToolMessage);

    expect(corrections(0)).toEqual([]);
    expect(hasToolResult(1)).toBe(false);
    expect(corrections(1)).toHaveLength(1);
    expect(corrections(1)[0]).toContain('Return exactly one object matching the entry-detection schema.');
    expect(corrections(1)[0]).toMatch(/2 replies left for this step\.$/);
    expect(corrections(1)[0]).not.toContain('invalid_structured_output');
    expect(hasToolResult(2)).toBe(false);
    expect(corrections(2).at(-1)).toMatch(/Last reply for this step\.$/);
  });

  it('a second interruption ends the turn as provider_error with the interruption text', async () => {
    const w = world([providerFailure('fetch failed', 'ECONNRESET'), providerFailure('fetch failed', 'ECONNRESET')]);
    expect(await w.runtime.run('Show me the objects')).toBe('error');
    expect(w.model.structuredCallCount).toBe(2);
    expect(w.model.modelCalls).toBe(0);
    expect(w.runtime.lastFailureDetail).toMatchObject({ stop: 'provider_error', message: expect.stringContaining('connection was interrupted') });
  });

  it('a provider verdict is never retried and keeps its message', async () => {
    const w = world([providerFailure('Provider returned 500', 'HTTP_500'), route]);
    expect(await w.runtime.run('Show me the objects')).toBe('error');
    expect(w.model.structuredCallCount).toBe(1);
    expect(w.runtime.lastFailureDetail).toMatchObject({ stop: 'provider_error', message: expect.stringContaining('HTTP_500') });
  });

  it('a host permission refusal ends the turn with its plain-words text, without a retry', async () => {
    const refusal = new ModelPortError('no_permission', 'denied', Object.assign(new Error('denied'), { code: 'NoPermissions' }));
    const w = world([refusal, route]);
    expect(await w.runtime.run('Show me the objects')).toBe('error');
    expect(w.model.structuredCallCount).toBe(1);
    expect(w.runtime.lastFailureDetail).toMatchObject({ stop: 'provider_error', message: expect.stringContaining('not allowed to use the selected language model') });
  });

  it('a non-provider exception is not reclassified as a provider failure', async () => {
    const w = world([new TypeError('programming error'), route]);
    expect(await w.runtime.run('Show me the objects')).toBe('error');
    expect(w.model.structuredCallCount).toBe(1);
    expect(w.runtime.lastFailureDetail?.stop).toBeUndefined();
    expect(w.runtime.lastFailureDetail?.message).toContain('programming error');
  });
});
