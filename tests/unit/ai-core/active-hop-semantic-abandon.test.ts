/**
 * Run-level coverage for the active-hop semantic-failure abandonment repair in
 * `src/ai/agent/graph.ts` — see `tests/unit/sm/active-hop-abandonment.test.ts` for the engine-level
 * mechanism (`tryAbandonStuckFocus`/`countAbandonedHops`) this exercises through the actual graph
 * wiring: `activeWorkerNode`'s stop-handling for `stopReason === 'semantic_failures'`.
 *
 * @remarks
 * `scriptedRegistry`'s fake `lineage_submit_findings` handler below calls the REAL
 * `NavigationEngine.submitFindings`/`getHopContext` on the session's live engine (proxying exactly
 * what the production tool handler, `src/ai/tools/handlers/submitFindings.ts`, does — not owned by
 * this fix and not edited here) so the agenda genuinely advances hop to hop, the same way it did in
 * the captured defect (T8, zai lane: `[ai].[spCleanOrders]` racked up 3 rejections and ended a
 * 23-node exploration after 3 hops even though 20 nodes remained unvisited).
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission } from '../../../src/ai/sm/smTypes';
import { ABANDONED_HOP_SUMMARY_PREFIX } from '../../../src/ai/agent/graph';
import { MAX_ABANDONED_HOPS_PER_RUN, MAX_TOOL_SEMANTIC_FAILURES } from '../../../src/ai/agent/toolAttempt';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';
import { ScriptedModelPort, scriptedRegistry, validCall } from './helpers/scriptedModelPort';

const GATE_RESULT = JSON.stringify({
  error: 'action_required',
  gate: 'confirm_sm_start',
  classes: [],
  nodeIds: [],
  detail: 'review revision 1',
  proposalRevision: 1,
});

/** Seeds a real BFS graph: one origin fanning out (upstream) to `leafCount` sibling leaves. */
function seedFanOutLineage(session: AiSession, leafCount: number): string[] {
  const leaves = Array.from({ length: leafCount }, (_, i) => `[ai].[Leaf${i}]`);
  const nodes = [
    makeNode({ id: '[ai].[Origin]', schema: 'ai', name: 'Origin', type: 'view', bodyScript: 'CREATE VIEW [ai].[Origin] AS SELECT 1 AS X' }),
    ...leaves.map(id => makeNode({ id, schema: 'ai', name: id.replace(/[[\]]/g, '').split('.')[1], type: 'view', bodyScript: `CREATE VIEW ${id} AS SELECT 1 AS X` })),
  ];
  const edges: Array<[string, string]> = leaves.map(id => [id, '[ai].[Origin]']);
  session.model = makeModel(nodes, edges, ['ai']);
  session.graph = makeGraph(
    nodes.map(n => ({ id: n.id, schema: n.schema, name: n.name, type: n.type })),
    edges,
  );
  return leaves;
}

function seedProposal(session: AiSession, epoch: number, scopeCount: number): void {
  session.storePendingExploration({
    init: {
      question: 'Trace Origin upstream.',
      origin: '[ai].[Origin]',
      analysisMode: 'bb',
      direction: 'upstream',
      depthIntent: { kind: 'full_frontier' },
    },
    classification: 'business',
    activeFilter: {
      schemas: [],
      types: [],
      hideIsolated: false,
      focusSchemas: [],
      showExternalRefs: false,
      externalRefTypes: [],
    },
    summary: {
      hopCount: scopeCount,
      scopeCount,
      origin: '[ai].[Origin]',
      depth: null,
      depthIntent: { kind: 'full_frontier' },
      direction: 'upstream',
      analysisMode: 'bb',
      columnAspectActive: false,
      estimatedDdlChars: 0,
      estimatedDdlTokens: 0,
      bySchema: {
        ai: {
          hops: scopeCount,
          scope: scopeCount,
          byType: { view: { hops: scopeCount, scope: scopeCount, nodeNames: [], omitted: 0 } },
        },
      },
      scopeNotes: [],
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
    },
  }, epoch);
}

/** Collects turn events and hands out each native gate as it is emitted. */
function makeGateSink() {
  const events: TurnEvent[] = [];
  const waiters: Array<(gate: NativeGateEvent) => void> = [];
  const pending: NativeGateEvent[] = [];
  const sink = new TurnEventSink((event) => {
    events.push(event);
    if (event.type !== 'gate') return;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else pending.push(event);
  });
  const nextGate = (): Promise<NativeGateEvent> => {
    const gate = pending.shift();
    return gate ? Promise.resolve(gate) : new Promise(resolve => waiters.push(resolve));
  };
  return { events, sink, nextGate };
}

/**
 * Submits through the REAL engine and, on acceptance, dequeues the next agenda entry — mirroring
 * `submitFindings.ts`'s own post-commit `getHopContext()` call so the fake registry entry below
 * advances hop to hop exactly like production.
 */
function submitAndAdvance(engine: NavigationEngine, finding: HopSubmission) {
  const result = engine.submitFindings(finding);
  if (!('error' in result)) engine.getHopContext();
  return result;
}

/**
 * Commits a minimal presentation artifact through the same public, turn-guarded write the real
 * `lineage_present_result` handler uses (`AiSession.commitPresentResultSuccess`) — content is
 * never asserted on, only that synthesis's own completion flag (`presentResultCalledThisTurn`)
 * flips, matching the real handler's side effect.
 */
function commitStubPresentation(session: AiSession, epoch: number): string {
  session.commitPresentResultSuccess(epoch, {
    name: 'Test Result',
    nodeIds: [],
    aiMetadata: { summary: 'test', description: 'test' },
  } as unknown as PresentationArtifact);
  return JSON.stringify({ ok: true });
}

const SYNTHETIC_REJECTION = JSON.stringify({
  error: 'synthetic_test_semantic_failure',
  hint: 'scripted rejection standing in for a real semantic-boundary rejection',
});

describe('active-hop semantic-failure abandonment (run level)', () => {
  it('abandons the stuck focus and still visits the remaining agenda node', async () => {
    const session = new AiSession();
    const leaves = seedFanOutLineage(session, 2);
    const epoch = session.beginTurn();
    seedProposal(session, epoch, leaves.length + 1);

    let submitCalls = 0;
    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      {
        name: 'lineage_submit_findings',
        result: (): string => {
          submitCalls += 1;
          const engine = session.stateMachine as NavigationEngine;
          if (submitCalls === 1) {
            // Hop 1 (origin): queue both leaves.
            return JSON.stringify(submitAndAdvance(engine, {
              focus_node_id: engine.currentFocus!,
              sections: [{ angle: 'business', text: 'origin analyzed' }],
              summary: 'origin analyzed',
              verdict: 'analyze',
              route_requests: leaves.map(id => ({ nodeId: id, question: `origin of ${id}?` })),
            }));
          }
          if (submitCalls <= 1 + MAX_TOOL_SEMANTIC_FAILURES) {
            // Hop 2 (first dequeued leaf): MAX_TOOL_SEMANTIC_FAILURES rejections in a row.
            return SYNTHETIC_REJECTION;
          }
          // Hop 3 (the remaining leaf, reached only if the run survived the breaker): accept.
          return JSON.stringify(submitAndAdvance(engine, {
            focus_node_id: engine.currentFocus!,
            sections: [{ angle: 'business', text: 'leaf analyzed' }],
            summary: 'leaf analyzed',
            verdict: 'analyze',
          }));
        },
      },
      { name: 'lineage_present_result', result: () => commitStubPresentation(session, epoch) },
    ]);

    const script = [
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
      { toolCalls: [validCall('submit-origin', 'lineage_submit_findings', { summary: 'origin analyzed', verdict: 'analyze' })] },
      ...Array.from({ length: MAX_TOOL_SEMANTIC_FAILURES }, (_, i) => (
        { toolCalls: [validCall(`submit-reject-${i}`, 'lineage_submit_findings', { attempt: i })] }
      )),
      { toolCalls: [validCall('submit-remaining-leaf', 'lineage_submit_findings', { summary: 'leaf analyzed', verdict: 'analyze' })] },
      { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
    ];
    const model = new ScriptedModelPort(script);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'abandon-continue',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink: turn.sink,
      turnEpoch: epoch,
      maxRounds: 10,
    });

    const running = runtime.run('/trace [ai].[Origin]');
    const gate = await turn.nextGate();
    expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    const outcome = await running;

    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');
    // The run reached synthesis instead of failing on the breaker — every scripted generation was
    // consumed, including the post-abandonment leaf hop and the synthesis present_result call.
    expect(model.requests.length).toBe(script.length);
    expect(invocations.filter(call => call.toolName === 'lineage_submit_findings').length)
      .toBe(1 + MAX_TOOL_SEMANTIC_FAILURES + 1);

    const engine = session.stateMachine as NavigationEngine;
    expect(engine.status).toBe('complete');
    // The abandoned leaf is recorded, never silent, and the OTHER leaf was genuinely visited —
    // this is the "agenda still holds nodes" case from the defect, proven end to end.
    const abandonedLeaf = leaves.find(id => engine.getPrunedDetails().some(detail => detail.nodeId === id));
    expect(abandonedLeaf).toBeDefined();
    const visitedLeaf = leaves.find(id => id !== abandonedLeaf);
    expect(engine.getResult().detail_slots.some(slot => slot.nodeId === visitedLeaf)).toBe(true);
    expect(
      engine.getPrunedDetails().find(detail => detail.nodeId === abandonedLeaf)!.summary
        .startsWith(ABANDONED_HOP_SUMMARY_PREFIX),
    ).toBe(true);
  });

  it('terminates into salvage once the run-level abandon governor is exhausted, instead of looping', async () => {
    const session = new AiSession();
    const leafCount = MAX_ABANDONED_HOPS_PER_RUN + 1;
    const leaves = seedFanOutLineage(session, leafCount);
    const epoch = session.beginTurn();
    seedProposal(session, epoch, leaves.length + 1);

    let submitCalls = 0;
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      {
        name: 'lineage_submit_findings',
        result: (): string => {
          submitCalls += 1;
          const engine = session.stateMachine as NavigationEngine;
          if (submitCalls === 1) {
            return JSON.stringify(submitAndAdvance(engine, {
              focus_node_id: engine.currentFocus!,
              sections: [{ angle: 'business', text: 'origin analyzed' }],
              summary: 'origin analyzed',
              verdict: 'analyze',
              route_requests: leaves.map(id => ({ nodeId: id, question: `origin of ${id}?` })),
            }));
          }
          // Every leaf hop rejects MAX_TOOL_SEMANTIC_FAILURES times in a row, with no accepting
          // hop ever scripted — the pathological "every remaining hop fails" case.
          return SYNTHETIC_REJECTION;
        },
      },
      { name: 'lineage_present_result', result: () => commitStubPresentation(session, epoch) },
    ]);

    const rejectCallCount = leafCount * MAX_TOOL_SEMANTIC_FAILURES;
    const script = [
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
      { toolCalls: [validCall('submit-origin', 'lineage_submit_findings', { summary: 'origin analyzed', verdict: 'analyze' })] },
      ...Array.from({ length: rejectCallCount }, (_, i) => (
        { toolCalls: [validCall(`submit-reject-${i}`, 'lineage_submit_findings', { attempt: i })] }
      )),
      { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
    ];
    const model = new ScriptedModelPort(script);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'abandon-exhausted',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink: turn.sink,
      turnEpoch: epoch,
      maxRounds: 30,
    });

    const running = runtime.run('/trace [ai].[Origin]');
    const gate = await turn.nextGate();
    expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    const outcome = await running;

    // The run terminated (every scripted generation consumed, turn closed 'ok' via synthesis
    // salvage) rather than hanging or exhausting the script mid-run — the real stop condition this
    // repair is required to keep: an all-failing agenda still ends the turn.
    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');
    expect(model.requests.length).toBe(script.length);

    const engine = session.stateMachine as NavigationEngine;
    // Exactly MAX_ABANDONED_HOPS_PER_RUN leaves were force-abandoned before the governor refused a
    // further one and fell back to salvage for the rest of the agenda.
    const abandoned = engine.getPrunedDetails().filter(detail => detail.summary.startsWith(ABANDONED_HOP_SUMMARY_PREFIX));
    expect(abandoned.length).toBe(MAX_ABANDONED_HOPS_PER_RUN);
  });
});
