/**
 * The active coordinator settles an engine-invariant failure through the incomplete-run path, and a
 * follow-up reroute counts only the hops already submitted. Scripted model replies exercise graph
 * wiring only; they say nothing about inference.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { NavigationInitParams } from '../../../src/ai/sm/smTypes';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { ScriptedModelPort, scriptedRegistry, validCall, type ScriptedGeneration } from '../../harness/scriptedModelPort';
import { INTERNAL_INVARIANT_STOP_TEXT, InternalInvariantError } from '../../../src/ai/support/internalInvariant';

const caller = '[d].[caller]', fn = '[d].[fn]', source = '[d].[source]', extra = '[d].[extra]';
const col = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
const sections = [{ angle: 'technical' as const, text: 'Evidence.' }];
const depthIntent = { upstream: { levels: 'all' as const, exactness: 'exact' as const }, downstream: { levels: 0 as const, exactness: 'exact' as const } };
const GATE_RESULT = JSON.stringify({ code: 'action_required', reason: 'review revision 1',
  detail: { gate: 'confirm_sm_start', classes: [], nodeIds: [], detail: 'review revision 1', proposalRevision: 1 } });

function seed(session: AiSession): LineageNode[] {
  const nodes: LineageNode[] = [
    makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [col('Value')], bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s` }),
    makeNode({ id: fn, schema: 'd', name: 'fn', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END` }),
    makeNode({ id: source, schema: 'd', name: 'source', type: 'table', columns: [col('Amount')] }),
    makeNode({ id: extra, schema: 'd', name: 'extra', type: 'view', columns: [col('Value')], bodyScript: `CREATE VIEW ${extra} AS SELECT Value FROM ${caller}` }),
  ];
  const edges: Array<[string, string]> = [[source, caller], [fn, caller], [caller, extra]];
  session.model = makeModel(nodes, edges, ['d']);
  session.graph = makeGraph(nodes, edges);
  return nodes;
}

function proposal(init: NavigationInitParams) {
  const analysisMode = init.analysisMode ?? 'bb';
  return {
    init,
    classification: 'technical' as const,
    activeFilter: { schemas: [], types: [], hideIsolated: false, focusSchemas: [], showExternalRefs: false, externalRefTypes: [] },
    summary: {
      hopCount: 2, scopeCount: 3, origin: caller, depth: null, depthIntent, direction: 'upstream' as const, analysisMode,
      columnAspectActive: analysisMode === 'ct', estimatedDdlChars: 0, estimatedDdlTokens: 0,
      bySchema: { d: { hops: 2, scope: 3, byType: { view: { hops: 1, scope: 1, nodeNames: [], omitted: 0 } } } },
      scopeNotes: [], activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
    },
  };
}

function gateSink() {
  const events: TurnEvent[] = [];
  const waiters: Array<(gate: NativeGateEvent) => void> = [];
  const sink = new TurnEventSink(event => {
    events.push(event);
    if (event.type === 'gate') waiters.shift()?.(event);
  });
  return { events, sink, nextGate: () => new Promise<NativeGateEvent>(resolve => waiters.push(resolve)) };
}

function logger(lines: string[]) {
  const push = (level: string) => (message: string, detail?: unknown) => { lines.push(`${level} ${message}${detail === undefined ? "" : ` ${detail instanceof Error ? detail.stack : String(detail)}`}`); };
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'), trace: push('trace') } as never;
}

describe('active coordinator', () => {
  it('ends the run through the incomplete-run path with the engine reason when the next dispatch breaks an engine invariant', async () => {
    const session = new AiSession();
    const nodes = seed(session);
    const epoch = session.beginTurn();
    session.storePendingExploration(proposal({ question: 'Trace Value', origin: caller, analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent }), epoch);
    const { registry } = scriptedRegistry([
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      {
        name: 'lineage_submit_findings',
        result: () => {
          const engine = session.stateMachine as NavigationEngine;
          const result = engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Value applies fn', sections, column_flow: [],
            questions: [{ nodeId: fn, question: 'Establish the returned value.', caller_context: { node: caller, col: 'Value' } }] });
          nodes[0].bodyScript = `${nodes[0].bodyScript} -- edited`;
          engine.getHopContext();
          return JSON.stringify(result);
        },
      },
    ]);
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: caller, analysisMode: 'ct', targetColumns: ['Value'], classification: 'technical' })] },
      { toolCalls: [validCall('submit-1', 'lineage_submit_findings', { summary: 'Value applies fn', verdict: 'analyze' })] },
    ]);
    const turn = gateSink();
    const runtime = new AgentRuntime({ threadId: 'invariant', getSession: () => session, model: model as unknown as ModelPort, registry, sink: turn.sink, turnEpoch: epoch, maxRounds: 10 });
    const running = runtime.run('/trace [d].[caller] Value');
    const gate = await turn.nextGate();
    expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    expect(await running).toBe('error');
    expect(runtime.lastFailureDetail).toMatchObject({ stop: 'engine_error', message: expect.stringMatching(/^Exploration stopped: a queued function investigation no longer matches/) });
    expect(runtime.lastFailureDetail?.message).not.toContain('saved exploration state');
  });
});

describe('active worker', () => {
  it('ends the run on the first submit when the caller SQL of the current function hop changed, without asking the model to retry', async () => {
    const session = new AiSession();
    const nodes = seed(session);
    const epoch = session.beginTurn();
    session.storePendingExploration(proposal({ question: 'Trace Value', origin: caller, analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent }), epoch);
    let fnSubmits = 0;
    const { registry } = scriptedRegistry([
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      {
        name: 'lineage_submit_findings',
        result: () => {
          const engine = session.stateMachine as NavigationEngine;
          if (engine.currentFocus === caller) {
            const result = engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Value applies fn', sections, column_flow: [],
              questions: [{ nodeId: fn, question: 'Establish the returned value.', caller_context: { node: caller, col: 'Value' } }] });
            engine.getHopContext();
            return JSON.stringify(result);
          }
          fnSubmits += 1;
          nodes[0].bodyScript = `${nodes[0].bodyScript} -- edited`;
          return JSON.stringify(engine.submitFindings({ focus_node_id: fn, verdict: 'analyze', summary: 'fn returns Amount', sections, column_flow: [] }));
        },
      },
    ]);
    const submit = (id: string): ScriptedGeneration => ({ toolCalls: [validCall(id, 'lineage_submit_findings', { summary: 'Reviewed', verdict: 'analyze' })] });
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: caller, analysisMode: 'ct', targetColumns: ['Value'], classification: 'technical' })] },
      submit('submit-caller'), submit('submit-fn-1'), submit('submit-fn-2'), submit('submit-fn-3'),
    ]);
    const turn = gateSink();
    const runtime = new AgentRuntime({ threadId: 'caller-changed', getSession: () => session, model: model as unknown as ModelPort, registry, sink: turn.sink, turnEpoch: epoch, maxRounds: 10 });
    const running = runtime.run('/trace [d].[caller] Value');
    const gate = await turn.nextGate();
    expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    expect(await running).toBe('error');
    expect(fnSubmits).toBe(1);
    expect(runtime.lastFailureDetail).toMatchObject({ stop: 'engine_error', message: expect.stringMatching(/^Exploration stopped: a queued function investigation no longer matches/) });
    expect(session.resultGraph).toBeNull();
  });
});

describe('backend fault', () => {
  const projectMissing = 'The analysis stopped at `d.caller`: no project is loaded in the Data Lineage panel. The run is incomplete, so no result is shown and the graph was not changed. Open the project and ask again.';
  it.each(['internal_error', 'tool_execution_error', 'engine_crash', 'invalid_status', 'no_active_session', 'stale_turn', 'no_project_loaded'])(
    'ends the run on the first %s without asking the model to retry', async code => {
      const session = new AiSession();
      seed(session);
      const epoch = session.beginTurn();
      session.storePendingExploration(proposal({ question: 'Trace Value', origin: caller, analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent }), epoch);
      let submits = 0;
      const { registry } = scriptedRegistry([
        { name: 'lineage_start_exploration', result: GATE_RESULT },
        { name: 'lineage_submit_findings', result: () => { submits += 1; return JSON.stringify({ code, reason: 'Synthetic backend fault.' }); } },
      ]);
      const submit = (id: string): ScriptedGeneration => ({ toolCalls: [validCall(id, 'lineage_submit_findings', { summary: 'Reviewed caller', verdict: 'analyze' })] });
      const model = new ScriptedModelPort([
        { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: caller, analysisMode: 'ct', targetColumns: ['Value'], classification: 'technical' })] },
        submit('submit-1'), submit('submit-2'), submit('submit-3'),
      ]);
      const turn = gateSink();
      const lines: string[] = [];
      const runtime = new AgentRuntime({ threadId: `fault-${code}`, getSession: () => session, model: model as unknown as ModelPort, registry,
        sink: turn.sink, turnEpoch: epoch, maxRounds: 10, logger: logger(lines) });
      const running = runtime.run('/trace [d].[caller] Value');
      const gate = await turn.nextGate();
      expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
      expect(await running).toBe('error');
      expect(submits).toBe(1);
      expect(runtime.lastFailureDetail).toMatchObject({
        stop: 'backend_fault',
        message: code === 'no_project_loaded'
          ? projectMissing
          : 'The analysis stopped at `d.caller`: an internal error occurred (' + code + '). The run is incomplete, so no result is shown and the graph was not changed. Details are in the debug log. Ask again.',
      });
      expect(session.resultGraph).toBeNull();
      expect(lines.some(line => line.includes('reason=backend_fault') && line.includes(`code=${code}`))).toBe(true);
    });
});

describe('provider transport interruption', () => {
  const transport = { status: 'error' as const, error: 'The AI provider connection was interrupted (ECONNRESET).', providerError: { phase: 'active', name: 'Error', message: 'socket hang up', code: 'ECONNRESET' } };
  const verdict = { status: 'error' as const, error: 'The AI provider reported an error (HTTP 500).', providerError: { phase: 'active', name: 'Error', message: 'HTTP 500', code: 'HTTP_500' } };
  const world = (generations: ScriptedGeneration[]) => {
    const session = new AiSession();
    seed(session);
    const epoch = session.beginTurn();
    session.storePendingExploration(proposal({ question: 'Trace Value', origin: caller, analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent }), epoch);
    let submits = 0;
    const { registry } = scriptedRegistry([
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      { name: 'lineage_submit_findings', result: () => { submits += 1; return JSON.stringify({ code: 'internal_error', reason: 'Synthetic backend fault.' }); } },
    ]);
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: caller, analysisMode: 'ct', targetColumns: ['Value'], classification: 'technical' })] },
      ...generations,
    ]);
    const turn = gateSink();
    const lines: string[] = [];
    const runtime = new AgentRuntime({ threadId: 'transport', getSession: () => session, model: model as unknown as ModelPort, registry,
      sink: turn.sink, turnEpoch: epoch, maxRounds: 10, logger: logger(lines), transportRetryDelayMs: 0 });
    return { runtime, turn, model, lines, submits: () => submits };
  };
  const submit = (id: string): ScriptedGeneration => ({ toolCalls: [validCall(id, 'lineage_submit_findings', { summary: 'Reviewed caller', verdict: 'analyze' })] });
  const run = async (w: ReturnType<typeof world>) => {
    const running = w.runtime.run('/trace [d].[caller] Value');
    const gate = await w.turn.nextGate();
    expect(w.runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    return running;
  };

  it('retries the generation once and the retry is the reply the step is charged for', async () => {
    const w = world([transport, submit('submit-1')]);
    expect(await run(w)).toBe('error');
    expect(w.submits()).toBe(1);
    expect(w.runtime.lastFailureDetail?.stop).toBe('backend_fault');
    expect(w.lines.some(line => line.includes('transport-retry'))).toBe(true);
  });

  it('a second interruption ends the turn as the provider error', async () => {
    const w = world([transport, transport, submit('submit-1')]);
    expect(await run(w)).toBe('error');
    expect(w.submits()).toBe(0);
    expect(w.runtime.lastFailureDetail?.message).toContain('connection was interrupted');
    expect(w.model.requests).toHaveLength(3);
  });

  it('a Chromium HTTP/2 protocol error, which carries no Node code, is retried once like any connection interruption', async () => {
    const chromium = { status: 'error' as const, error: 'The AI provider connection was interrupted (net::ERR_HTTP2_PROTOCOL_ERROR).', providerError: { phase: 'active', name: 'Error', message: 'net::ERR_HTTP2_PROTOCOL_ERROR', code: 'net::ERR_HTTP2_PROTOCOL_ERROR' } };
    const w = world([chromium, submit('submit-1')]);
    expect(await run(w)).toBe('error');
    expect(w.submits()).toBe(1);
    expect(w.lines.some(line => line.includes('transport-retry'))).toBe(true);
  });

  it('a provider failure before any exploration records the provider_error stop reason', async () => {
    const session = new AiSession();
    seed(session);
    const epoch = session.beginTurn();
    const { registry } = scriptedRegistry([]);
    const model = new ScriptedModelPort([verdict]);
    const runtime = new AgentRuntime({ threadId: 'discovery-provider', getSession: () => session, model: model as unknown as ModelPort, registry,
      sink: new TurnEventSink(() => {}), turnEpoch: epoch, maxRounds: 10, transportRetryDelayMs: 0 });
    expect(await runtime.run('/trace [d].[caller]')).toBe('error');
    expect(runtime.lastFailureDetail).toMatchObject({ stop: 'provider_error', message: expect.stringContaining('HTTP 500') });
  });

  it('a provider verdict is never retried', async () => {
    const w = world([verdict, submit('submit-1')]);
    expect(await run(w)).toBe('error');
    expect(w.submits()).toBe(0);
    expect(w.model.requests).toHaveLength(2);
  });
});

describe('negative lane: replies without the required hop call', () => {
  const run = async (replies: ScriptedGeneration[]) => {
    const session = new AiSession();
    seed(session);
    const epoch = session.beginTurn();
    session.storePendingExploration(proposal({ question: 'Trace Value', origin: caller, analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent }), epoch);
    const { registry } = scriptedRegistry([
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      { name: 'lineage_submit_findings', result: '{}' },
    ]);
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: caller, analysisMode: 'ct', targetColumns: ['Value'], classification: 'technical' })] },
      ...replies,
    ]);
    const turn = gateSink();
    const lines: string[] = [];
    const runtime = new AgentRuntime({ threadId: 'negative', getSession: () => session, model: model as unknown as ModelPort, registry,
      sink: turn.sink, turnEpoch: epoch, maxRounds: 10, logger: logger(lines) });
    const running = runtime.run('/trace [d].[caller] Value');
    const gate = await turn.nextGate();
    expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    return { outcome: await running, runtime, model, lines };
  };

  it('answers empty and text-only replies with a correction naming the call, and stops on the third as no progress', async () => {
    const { outcome, runtime, model, lines } = await run([{ text: '' }, { text: 'Here is my analysis in prose.' }, { text: '' }]);
    expect(outcome).toBe('error');
    expect(runtime.lastFailureDetail?.stop).toBe('no_progress');
    expect(model.requests).toHaveLength(4);
    const corrections = model.requests.slice(2).map(request => JSON.stringify(request.messages));
    for (const correction of corrections) expect(correction).toContain('Correction for lineage_submit_findings');
    expect(corrections[0]).toContain('The provider returned an empty response');
    expect(corrections[1]).toContain('No tool call was received');
    expect(lines.some(line => line.includes('code=empty_generation'))).toBe(true);
    expect(lines.some(line => line.includes('code=missing_required_tool_call'))).toBe(true);
  });
});

describe('negative lane: approval of a superseded proposal', () => {
  it('refuses to activate a revision other than the one pending and builds nothing', () => {
    const session = new AiSession();
    seed(session);
    const epoch = session.beginTurn();
    session.storePendingExploration(proposal({ question: 'Trace Value', origin: caller, analysisMode: 'bb', direction: 'upstream', depthIntent }), epoch);
    const pending = session.pendingExploration!.revision;
    let built = false;
    const outcome = session.activatePendingExploration(pending + 1, epoch, () => { built = true; throw new Error('must not build'); });
    expect(outcome).toEqual({ kind: 'rejected', reason: `stale_proposal_revision:${pending + 1}->${pending}` });
    expect(built).toBe(false);
    expect(session.stateMachine).toBeNull();
  });
});

describe('broken runtime invariant', () => {
  it('ends the turn with the stable internal-error text and keeps the developer message in the log', async () => {
    const session = new AiSession();
    seed(session);
    const epoch = session.beginTurn();
    const { registry } = scriptedRegistry([{ name: 'lineage_start_exploration', result: GATE_RESULT }]);
    const scripted = new ScriptedModelPort([]);
    const model = new Proxy(scripted, {
      get(target, key, receiver) {
        if (key === 'generateToolTurn') return () => { throw new InternalInvariantError('Single-generation model-port contract violated: synthetic.'); };
        return Reflect.get(target, key, receiver);
      },
    });
    const lines: string[] = [];
    const runtime = new AgentRuntime({ threadId: 'invariant-text', getSession: () => session, model: model as unknown as ModelPort, registry,
      sink: gateSink().sink, turnEpoch: epoch, maxRounds: 10, logger: logger(lines) });
    expect(await runtime.run('/trace [d].[caller] Value')).toBe('error');
    expect(runtime.lastFailureDetail?.message).toBe(INTERNAL_INVARIANT_STOP_TEXT);
    expect(runtime.lastFailureDetail?.message).not.toContain('contract violated');
    expect(lines.some(line => line.includes('contract violated: synthetic'))).toBe(true);
  });
});

describe('follow-up reroute', () => {
  it('ends a stopped supplement hop as an error that reports the hops actually completed and renders no result', async () => {
    const session = new AiSession();
    seed(session);
    const first = session.beginTurn();
    session.storePendingExploration(proposal({ question: 'Inspect caller', origin: caller, analysisMode: 'bb', direction: 'upstream', depthIntent }), first);
    const activation = session.activatePendingExploration(1, first, pending => {
      const engine = new NavigationEngine(session.model!, session.graph!, () => {}, { activeFilter: pending.activeFilter });
      const started = engine.init(pending.init);
      return 'code' in started ? started : engine;
    });
    expect(activation.kind).toBe('accepted');
    const engine = session.stateMachine as NavigationEngine;
    for (const focus of [caller, fn]) {
      expect(engine.getHopContext()).toMatchObject({ focus_node: { id: focus } });
      expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Reviewed ${focus}`, sections })).toMatchObject({ ok: true });
    }
    expect(engine.getHopContext()).toMatchObject({ done: true });
    session.storeSmResult(engine.getResult(), first);
    session.enterCompleted(first);

    const second = session.beginTurn();
    let presented = 0;
    const { registry } = scriptedRegistry([
      {
        name: 'lineage_start_exploration',
        result: () => {
          const res = engine.supplementAgenda([extra]);
          session.enterExploring(second);
          return JSON.stringify({ ok: true, supplement: res, ...engine.getHopContext() });
        },
      },
      { name: 'lineage_submit_findings', result: JSON.stringify({ code: 'not_called' }) },
      {
        name: 'lineage_present_result',
        result: () => {
          presented += 1;
          session.commitPresentResultSuccess(second, { name: 'Result', nodeIds: [], aiMetadata: { summary: 's', description: 'd' } } as unknown as PresentationArtifact);
          return JSON.stringify({ ok: true });
        },
      },
    ]);
    const silent: ScriptedGeneration = { text: 'Still thinking.' };
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('supplement-1', 'lineage_start_exploration', { supplement: { nodeIds: [extra] } })] },
      silent, silent, silent,
      { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
    ]);
    const lines: string[] = [];
    const runtime = new AgentRuntime({ threadId: 'follow-up', getSession: () => session, model: model as unknown as ModelPort, registry,
      sink: gateSink().sink, turnEpoch: second, maxRounds: 10, logger: logger(lines) });
    expect(await runtime.run('Also explore the extra view.')).toBe('error');
    expect(engine.currentHop).toBe(3);
    expect(runtime.lastFailureDetail).toMatchObject({
      stop: 'no_progress',
      message: expect.stringMatching(/^The analysis stopped at `d\.extra`: 3 model replies for this object were not accepted\. 2 objects were analysed before the stop\. The run is incomplete, so no result is shown/),
    });
    expect(presented).toBe(0);
    expect(session.resultGraph).toBeNull();
    expect(lines.some(line => line.includes('[Salvage]'))).toBe(false);
  });
});
