/**
 * Chat-visibility cover for the repair-progress emissions in `src/ai/agent/graph.ts`.
 *
 * @remarks
 * A semantic failure inside a self-looping phase used to be invisible in chat — the phase's entry
 * status repeated identically (the observed "Hop 3/3 — analysing X" twice). These tests pin the
 * two emission sites through the real graph wiring: `emitRepairProgress` for the standard phases
 * (discovery here) and the active worker's suffixed hop status plus cause line, so a retry reads
 * as progress in the same bracket grammar as the hop counter's `(+N added, −N pruned)`.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { PREVIEW_REQUEST_MARKER } from '../../../src/ai/prompting/prompts';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission } from '../../../src/ai/sm/smTypes';
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

const SYNTHETIC_REJECTION = JSON.stringify({
  error: 'synthetic_test_semantic_failure',
  hint: 'scripted rejection standing in for a real semantic-boundary rejection',
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
 * `submitFindings.ts`'s own post-commit `getHopContext()` call.
 */
function submitAndAdvance(engine: NavigationEngine, finding: HopSubmission) {
  const result = engine.submitFindings(finding);
  if (!('error' in result)) engine.getHopContext();
  return result;
}

/** Commits a minimal presentation artifact through the same public, turn-guarded write the real handler uses. */
function commitStubPresentation(session: AiSession, epoch: number): string {
  session.commitPresentResultSuccess(epoch, {
    name: 'Test Result',
    nodeIds: [],
    aiMetadata: { summary: 'test', description: 'test' },
  } as unknown as PresentationArtifact);
  return JSON.stringify({ ok: true });
}

const statusLabels = (events: readonly TurnEvent[]): string[] =>
  events.filter((e): e is Extract<TurnEvent, { type: 'status' }> => e.type === 'status').map(e => e.label);
const textDeltas = (events: readonly TurnEvent[]): string[] =>
  events.filter((e): e is Extract<TurnEvent, { type: 'text' }> => e.type === 'text').map(e => e.delta);

describe('repair-progress chat emissions', () => {
  it('announces a visual-preview semantic-failure retry with the repair suffix and cause line', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    // Seed the post-discovery state the preview pill re-enters with: a cached scope and answer.
    session.storeDiscoveryScope({
      turnEpoch: epoch,
      origin: '[ai].[Origin]',
      direction: 'upstream',
      nodeIds: ['[ai].[Origin]'],
      edges: [],
    }, epoch);
    session.recordDiscovery('[ai].[Origin]', 1, 'What feeds Origin?', 'Origin has no upstream dependencies.');

    let presentCalls = 0;
    const { registry } = scriptedRegistry([
      { name: 'lineage_present_result', result: (): string => {
        presentCalls += 1;
        // First dispatch is the scripted rejection; the repair attempt commits for real.
        return presentCalls === 1 ? SYNTHETIC_REJECTION : commitStubPresentation(session, epoch);
      } },
    ]);

    const script = [
      // Attempt 1: the call is dispatched but rejected — one semantic failure, loop continues.
      { toolCalls: [validCall('present-reject', 'lineage_present_result', {})] },
      // Attempt 2 (the repair): accepted — the phase completes.
      { toolCalls: [validCall('present-ok', 'lineage_present_result', {})] },
    ];
    const model = new ScriptedModelPort(script);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'repair-visual-preview',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink: turn.sink,
      turnEpoch: epoch,
      maxRounds: 10,
    });

    const outcome = await runtime.run(PREVIEW_REQUEST_MARKER);
    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');

    // The retry is announced on the status line with the bracketed attempt counter...
    expect(statusLabels(turn.events)).toContain('Building lineage preview… (attempt 2 — repairing)');
    // ...and one permanent italic line names the failed attempt and its cause. The synthetic
    // rejection's code is deliberately unmapped, pinning the verbatim fallthrough.
    expect(textDeltas(turn.events)).toContain('\n\n_Visual preview attempt 1 failed (synthetic_test_semantic_failure) — repairing…_');
    // No announcement without a new failure: the accepted attempt emits no second repair line.
    expect(statusLabels(turn.events).filter(label => label.includes('repairing')).length).toBe(1);
  });

  it('suffixes the re-entered hop status with the repair counter instead of repeating the identical line', async () => {
    const session = new AiSession();
    const leaves = seedFanOutLineage(session, 2);
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
          if (submitCalls === 2) {
            // Hop 2 (first leaf): one rejection, then the repair attempt below accepts.
            return SYNTHETIC_REJECTION;
          }
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
      { toolCalls: [validCall('submit-reject-0', 'lineage_submit_findings', { attempt: 0 })] },
      { toolCalls: [validCall('submit-leaf-0', 'lineage_submit_findings', { summary: 'leaf analyzed', verdict: 'analyze' })] },
      { toolCalls: [validCall('submit-leaf-1', 'lineage_submit_findings', { summary: 'leaf analyzed', verdict: 'analyze' })] },
      { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
    ];
    const model = new ScriptedModelPort(script);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'repair-active-hop',
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
    expect(model.requests.length).toBe(script.length);

    // Hop 2 was entered twice: bare the first time, repair-suffixed on the re-entry after the
    // rejected submit — the two lines are never identical (the observed duplicate).
    const hop2 = statusLabels(turn.events).filter(label => label.startsWith('Hop 2/'));
    expect(hop2.length).toBe(2);
    expect(hop2[0]).toMatch(/^Hop 2\/\d+ — analysing Leaf0$/);
    expect(hop2[1]).toMatch(/^Hop 2\/\d+ — analysing Leaf0 \(attempt 2 — repairing\)$/);
    // The permanent cause line explains the retry in the transcript.
    expect(textDeltas(turn.events)).toContain('\n\n_Hop 2 attempt 1 failed (synthetic_test_semantic_failure) — repairing…_');
  });
});
