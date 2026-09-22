/**
 * Run-level coverage for the ONE repeated-error guard in `src/ai/agent/graph.ts` —
 * `activeWorkerNode`'s stop-handling for `stopReason === 'semantic_failures'`.
 *
 * The contract these tests pin: an exhausted attempt budget gets the SAME disposition in the
 * active hop as in every other phase. The stop stands, `shouldSalvageActiveStop` decides between
 * rendering completed hops and failing the turn, and nothing recovers the stuck hop. The active
 * phase previously owned a private second handler that converted this identical stop into a
 * host-authored `verdict: 'prune'` on the stuck focus; that gave one condition two behaviours and
 * deleted a node the model never voted to remove. The engine validates verdicts — it does not
 * author them (`docs/ARCHITECTURE.md`).
 *
 * @remarks
 * `scriptedRegistry`'s fake `lineage_submit_findings` handler below calls the REAL
 * `NavigationEngine.submitFindings`/`getHopContext` on the session's live engine (proxying exactly
 * what the production tool handler, `src/ai/tools/handlers/submitFindings.ts`, does) so the agenda
 * genuinely advances hop to hop and a prune authored anywhere else would show up in
 * `getPrunedDetails()`.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission } from '../../../src/ai/sm/smTypes';
import { MAX_TOOL_SEMANTIC_FAILURES } from '../../../src/ai/agent/toolAttempt';
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


describe('active-hop semantic-failure stop (run level) — one guard, one disposition', () => {
  it('stops the exploration on the stuck focus and salvages the hops already submitted', async () => {
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
            // Hop 1 (origin): queue both leaves, so the agenda still holds live work when the
            // next hop gets stuck. Under the old private handler that was the trigger to skip and
            // carry on; under one guard it changes nothing.
            return JSON.stringify(submitAndAdvance(engine, {
              focus_node_id: engine.currentFocus!,
              sections: [{ angle: 'business', text: 'origin analyzed' }],
              summary: 'origin analyzed',
              verdict: 'analyze',
              route_requests: leaves.map(id => ({ nodeId: id, question: `origin of ${id}?` })),
            }));
          }
          // Hop 2 (first dequeued leaf): MAX_TOOL_SEMANTIC_FAILURES rejections in a row.
          return SYNTHETIC_REJECTION;
        },
      },
      { name: 'lineage_present_result', result: () => commitStubPresentation(session, epoch) },
    ]);

    // No fourth submit is scripted: the budget trips on the third rejection and the very next
    // generation the run asks for is synthesis. A script longer than this would not be consumed.
    const script = [
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
      { toolCalls: [validCall('submit-origin', 'lineage_submit_findings', { summary: 'origin analyzed', verdict: 'analyze' })] },
      ...Array.from({ length: MAX_TOOL_SEMANTIC_FAILURES }, (_, i) => (
        { toolCalls: [validCall(`submit-reject-${i}`, 'lineage_submit_findings', { attempt: i })] }
      )),
      { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
    ];
    const model = new ScriptedModelPort(script);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'semantic-stop-salvage',
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

    // One submitted hop exists, so the stop renders it rather than discarding the turn.
    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');
    expect(model.requests.length).toBe(script.length);

    // The decisive assertion: every `submit_findings` the engine saw came from the script. The
    // host authored none of its own — 1 accepted origin hop + MAX_TOOL_SEMANTIC_FAILURES rejects.
    expect(invocations.filter(call => call.toolName === 'lineage_submit_findings').length)
      .toBe(1 + MAX_TOOL_SEMANTIC_FAILURES);

    const engine = session.stateMachine as NavigationEngine;
    // Nothing was pruned. The stuck focus is left UNDISPOSITIONED, not removed, and the leaf the
    // walk never reached is simply uncovered — both are honest states the result must carry.
    expect(engine.getPrunedDetails().length, 'no node may be removed by a stop').toBe(0);
    for (const leaf of leaves) {
      expect(engine.toJSON().removedSet.includes(leaf), `${leaf} must not be removed`).toBe(false);
    }
  });

  it('fails the turn instead of rendering when the stop lands before any hop was submitted', async () => {
    // `shouldSalvageActiveStop` requires at least one SUBMITTED hop. With the origin itself stuck
    // there is no partial coverage to show, so the turn must fail rather than render an empty
    // graph — the same disposition every other phase gives a first-attempt budget exhaustion.
    const session = new AiSession();
    const leaves = seedFanOutLineage(session, 2);
    const epoch = session.beginTurn();
    seedProposal(session, epoch, leaves.length + 1);

    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      { name: 'lineage_submit_findings', result: (): string => SYNTHETIC_REJECTION },
      { name: 'lineage_present_result', result: () => commitStubPresentation(session, epoch) },
    ]);

    const script = [
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
      ...Array.from({ length: MAX_TOOL_SEMANTIC_FAILURES }, (_, i) => (
        { toolCalls: [validCall(`submit-reject-${i}`, 'lineage_submit_findings', { attempt: i })] }
      )),
    ];
    const model = new ScriptedModelPort(script);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'semantic-stop-fail',
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

    expect(outcome).not.toBe('ok');
    expect(model.requests.length).toBe(script.length);
    // Only the three scripted rejects reached the engine — the host authored no fourth call to
    // dispose of the stuck origin. (The failed turn discards `session.stateMachine`, so the
    // engine's own post-state is not observable here; the invocation count is what pins the
    // contract, and the origin is prune-refused structurally in any case.)
    expect(invocations.filter(call => call.toolName === 'lineage_submit_findings').length)
      .toBe(MAX_TOOL_SEMANTIC_FAILURES);
  });
});
