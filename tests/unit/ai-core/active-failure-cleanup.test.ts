/** Failure cleanup preserves newer work and leaves a current failure ready for a fresh trace. */
import { describe, expect, it } from 'vitest';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';
import { ScriptedModelPort, validCall } from '../../harness/scriptedModelPort';

const origin = '[ai].[Origin]', source = '[ai].[Source]';
const depth = { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } };
const start = { origin, analysisMode: 'bb', classification: 'technical', question: 'Inspect Origin.', depth };
const first = { toolCalls: [validCall('start', 'lineage_start_exploration', start)] };
const fault = { status: 'error' as const, error: 'Synthetic provider failure.', providerError: { phase: 'active', name: 'Error', message: 'Synthetic provider failure.', code: 'HTTP_500' } };

function completedModel() {
  return new ScriptedModelPort([
    first,
    ...[origin, source].map((focus, index) => ({ toolCalls: [validCall(`finding-${index}`, 'lineage_submit_findings', {
      focus_node_id: focus, verdict: 'analyze', summary: 'Synthetic view.', sections: { technical: 'Synthetic evidence.' },
    })] })),
    { toolCalls: [validCall('present', 'lineage_present_result', {
      name: 'Synthetic report', summary: 'Synthetic lineage.', highlight_groups: [{ label: 'Views', color: 'target', node_ids: [origin, source] }],
      sections: [{ label: 'Views', node_ids: [origin, source], text: 'Synthetic evidence.' }],
    })] },
  ]);
}

function world() {
  const session = new AiSession();
  const nodes = [origin, source].map(id => makeNode({ id, schema: 'ai', name: id === origin ? 'Origin' : 'Source', type: 'view', bodyScript: 'SELECT 1 AS Value;' }));
  session.model = makeModel(nodes, [[source, origin]], ['ai']);
  session.model.neighborIndex = { [origin]: { in: [source], out: [] }, [source]: { in: [], out: [origin] } };
  session.graph = makeGraph(nodes, [[source, origin]]);
  const noop = () => {};
  const channel = { debug: noop, info: noop, warn: noop, error: noop } as never;
  const runtime = new LineageRuntime({ getSession: () => session, createRegistry: (lease, model) =>
    buildAiToolRegistry(() => session, channel, () => undefined, lease, { model }) });
  const run = (id: string, model: ScriptedModelPort) => runtime.run({
    request: { id, prompt: `/trace ${origin} ${id}` }, model: model as unknown as ModelPort,
    sink: new TurnEventSink(event => { if (event.type === 'gate') void runtime.resumeGate(event.gateId, { kind: 'approve', classes: [] }); }),
  });
  return { session, run };
}

describe('active failure cleanup', () => {
  it('does not erase a newer completed native chat when the older provider fails', async () => {
    const w = world();
    const old = new ScriptedModelPort([first, fault]);
    const generate = old.generateToolTurn.bind(old);
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    old.generateToolTurn = async input => {
      if (input.phase === 'active') { started(); await paused; }
      return generate(input);
    };
    const oldRun = w.run('old', old);
    await ready;
    w.session.beginNativeChatSession();
    const newerResult = await w.run('new', completedModel());
    const newest = w.session.resultGraph, newestEngine = w.session.stateMachine;
    release();
    expect((await oldRun).outcome).toBe('error');
    expect(newerResult.outcome).toBe('ok');
    expect(w.session.resultGraph).toBe(newest);
    expect(w.session.stateMachine).toBe(newestEngine);
    expect(w.session.memory.getUserQuestion()).toBe(`/trace ${origin} new`);
    expect(w.session.phase.kind).toBe('completed');
  });

  it('clears the failed current engine and completes the next trace normally', async () => {
    const w = world();
    expect((await w.run('failed', new ScriptedModelPort([first, fault]))).outcome).toBe('error');
    const failedState = { engine: w.session.stateMachine, result: w.session.resultGraph, phase: w.session.phase.kind };
    const recovered = await w.run('recovered', completedModel());
    expect(recovered.outcome).toBe('ok');
    expect(failedState).toEqual({ engine: null, result: null, phase: 'idle' });
    expect(w.session.stateMachine?.status).toBe('complete');
    expect(w.session.resultGraph?.nodeIds).toEqual(expect.arrayContaining([origin, source]));
    expect(w.session.phase.kind).toBe('completed');
  });
});
