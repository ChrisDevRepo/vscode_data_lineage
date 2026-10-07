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
      message: expect.stringMatching(/^The analysis stopped at `d\.extra`: 3 model replies in a row were not accepted\. 2 objects were analysed before the stop\. The run is incomplete, so no result is shown/),
    });
    expect(presented).toBe(0);
    expect(session.resultGraph).toBeNull();
    expect(lines.some(line => line.includes('[Salvage]'))).toBe(false);
  });
});
