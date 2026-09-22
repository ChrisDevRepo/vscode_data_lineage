import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import {
  RUN_TRACE_TRIGGER,
  TRACE_REQUEST_MARKER,
  expandRunTracePrompt,
} from '../../../src/ai/prompting/prompts';
import {
  ScriptedModelPort,
  scriptedRegistry,
  validCall,
} from './helpers/scriptedModelPort';

/** Stores the revision-1 proposal the gate rounds under test all review. */
function seedProposal(session: AiSession, epoch: number): void {
  session.storePendingExploration({
    init: {
      question: 'Trace FactSalesReport upstream.',
      origin: '[ai].[FactSalesReport]',
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
      hopCount: 1,
      scopeCount: 2,
      origin: '[ai].[FactSalesReport]',
      depth: null,
      depthIntent: { kind: 'full_frontier' },
      direction: 'upstream',
      analysisMode: 'bb',
      columnAspectActive: false,
      estimatedDdlChars: 0,
      estimatedDdlTokens: 0,
      bySchema: {
        ai: {
          hops: 1,
          scope: 2,
          byType: {
            table: { hops: 1, scope: 2, nodeNames: ['DimCalendar', 'FactSalesReport'], omitted: 0 },
          },
        },
      },
      scopeNotes: [],
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
    },
  }, epoch);
}

const GATE_RESULT = JSON.stringify({
  error: 'action_required',
  gate: 'confirm_sm_start',
  classes: [],
  nodeIds: [],
  detail: 'review revision 1',
  proposalRevision: 1,
});

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

/** The two tools every round below offers: a search fallback plus the gated entry point. */
function standardRegistry() {
  return scriptedRegistry([
    { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
    { name: 'lineage_start_exploration', result: GATE_RESULT },
  ]).registry;
}

/**
 * Runs a `/trace` turn to its gate and holds it — the shared first half of every "next turn drops
 * or claims the hold" case below.
 */
async function holdFreshProposal(
  session: AiSession,
  epoch: number,
  threadId: string,
): Promise<{ heldGate: NativeGateEvent; events: readonly TurnEvent[] }> {
  const model = new ScriptedModelPort([{
    toolCalls: [validCall('start-1', 'lineage_start_exploration', {
      origin: '[ai].[FactSalesReport]',
      analysisMode: 'bb',
      classification: 'business',
    })],
  }]);
  const holdTurn = makeGateSink();
  const runtime = new AgentRuntime({
    threadId,
    getSession: () => session,
    model: model as unknown as ModelPort,
    registry: standardRegistry(),
    sink: holdTurn.sink,
    turnEpoch: epoch,
    maxRounds: 1,
  });
  const holding = runtime.run('/trace [ai].[FactSalesReport]');
  const heldGate = await holdTurn.nextGate();
  runtime.resumeGate(heldGate.gateId, { kind: 'hold' });
  await expect(holding).resolves.toBe('ok');
  expect(session.pendingExploration).not.toBeNull();
  return { heldGate, events: holdTurn.events };
}

describe('revision-bound gate refinement runtime', () => {
  it('re-emits the unchanged proposal after provider failure and keeps lookup available', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    seedProposal(session, epoch);

    const model = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: '[ai].[FactSalesReport]',
          analysisMode: 'bb',
          classification: 'business',
        })],
      },
      {
        status: 'error',
        error: 'provider unavailable',
        providerError: { phase: 'sm_entry', name: 'Error', message: 'provider unavailable' },
      },
    ]);
    const { events, sink, nextGate } = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'refine-provider-failure',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry: standardRegistry(),
      sink,
      turnEpoch: epoch,
      maxRounds: 1,
    });

    const running = runtime.run('/trace [ai].[FactSalesReport]');
    const firstGate = await nextGate();
    expect(runtime.resumeGate(firstGate.gateId, {
      kind: 'refine',
      refine: { instruction: 'remove DimCalender' },
    })).toBe(true);

    const replacementGate = await nextGate();
    // Each round is a distinct handle: the superseded card's buttons must not resolve the new gate.
    expect(replacementGate.gateId).not.toBe(firstGate.gateId);
    expect(session.pendingExploration?.revision).toBe(1);
    expect(session.stateMachine).toBeNull();
    expect(events).toContainEqual({
      type: 'error',
      message: 'Scope change was not applied: the model/provider could not complete the change. The existing proposal is still pending.',
      recoverable: true,
    });
    expect(model.requests[1].tools.map(tool => tool.name)).toEqual([
      'lineage_search_objects',
      'lineage_start_exploration',
    ]);

    expect(runtime.resumeGate(replacementGate.gateId, { kind: 'cancel' })).toBe(true);
    await expect(running).resolves.toBe('ok');
  });

  it('holds the proposal across turns and claims the next prompt as the refinement', async () => {
    const session = new AiSession();
    const firstEpoch = session.beginTurn();
    seedProposal(session, firstEpoch);

    const { heldGate, events } = await holdFreshProposal(session, firstEpoch, 'hold-turn');

    // The turn closes cleanly so VS Code releases the chat input, and the reviewed proposal
    // survives with the session still parked on the gate.
    expect(session.pendingExploration?.revision).toBe(1);
    expect(session.phase.kind).toBe('awaiting_gate');
    expect(session.stateMachine).toBeNull();
    expect(events).toContainEqual({
      type: 'text',
      delta: '\n\nType the scope change below and send it — the proposal above stays pending until then.',
    });

    // Next turn: a plain typed prompt is the scope change, routed straight to gate_refine.
    const refineEpoch = session.beginTurn();
    const refineModel = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-2', 'lineage_start_exploration', {
          proposalRevision: 1,
          excludeNodeIds: ['[ai].[dimcalendar]'],
        })],
      },
    ]);
    const refineTurn = makeGateSink();
    const refineRuntime = new AgentRuntime({
      threadId: 'refine-turn',
      getSession: () => session,
      model: refineModel as unknown as ModelPort,
      registry: standardRegistry(),
      sink: refineTurn.sink,
      turnEpoch: refineEpoch,
      maxRounds: 1,
    });

    const refining = refineRuntime.run('remove DimCalendar');
    const revisedGate = await refineTurn.nextGate();
    expect(revisedGate.gateId).not.toBe(heldGate.gateId);
    // No entry-detector call: the held proposal routes the prompt deterministically.
    expect(refineModel.requests).toHaveLength(1);
    expect(refineModel.requests[0].tools.map(tool => tool.name)).toEqual([
      'lineage_search_objects',
      'lineage_start_exploration',
    ]);

    expect(refineRuntime.resumeGate(revisedGate.gateId, { kind: 'cancel' })).toBe(true);
    await expect(refining).resolves.toBe('ok');
    expect(session.pendingExploration).toBeNull();
  });

  it('drops a held proposal when the next turn states a slash command', async () => {
    const session = new AiSession();
    const holdEpoch = session.beginTurn();
    seedProposal(session, holdEpoch);

    await holdFreshProposal(session, holdEpoch, 'hold-then-slash');

    const slashEpoch = session.beginTurn();
    const slashModel = new ScriptedModelPort([
      {
        toolCalls: [validCall('search-1', 'lineage_search_objects', { query: 'Sales' })],
      },
    ]);
    const slashRuntime = new AgentRuntime({
      threadId: 'slash-turn',
      getSession: () => session,
      model: slashModel as unknown as ModelPort,
      registry: standardRegistry(),
      sink: makeGateSink().sink,
      turnEpoch: slashEpoch,
      maxRounds: 1,
    });

    await slashRuntime.run('/search Sales');

    // The stated command wins, so the abandoned proposal cannot be mistaken for a refine target.
    expect(session.pendingExploration).toBeNull();
    expect(session.phase.kind).not.toBe('awaiting_gate');
  });

  it('drops a held proposal when the next turn is the post-discovery trace pill', async () => {
    const session = new AiSession();
    const holdEpoch = session.beginTurn();
    seedProposal(session, holdEpoch);
    // The captured discovery walk that made the pill render; it survives the hold, so the pill in
    // the transcript above the proposal stays clickable while the gate is parked.
    session.recordDiscovery('[ai].[FactSalesReport]', 2, 'What feeds FactSalesReport?', 'DimCalendar feeds it.');

    await holdFreshProposal(session, holdEpoch, 'hold-then-pill');

    // The host expands the pill sentinel exactly as the participant does before the turn starts.
    const pillPrompt = expandRunTracePrompt(RUN_TRACE_TRIGGER, session);
    expect(pillPrompt.startsWith(TRACE_REQUEST_MARKER)).toBe(true);

    const pillEpoch = session.beginTurn();
    const pillModel = new ScriptedModelPort([
      {
        toolCalls: [validCall('search-1', 'lineage_search_objects', { query: 'Sales' })],
      },
    ]);
    const pillRuntime = new AgentRuntime({
      threadId: 'pill-turn',
      getSession: () => session,
      model: pillModel as unknown as ModelPort,
      registry: standardRegistry(),
      sink: makeGateSink().sink,
      turnEpoch: pillEpoch,
      maxRounds: 1,
    });

    await pillRuntime.run(pillPrompt);

    // A host-owned route is as stated as a slash command: the hold is dropped, so the trace turn's
    // fresh start_exploration is not judged against the abandoned proposal's revision.
    expect(session.pendingExploration).toBeNull();
    expect(session.phase.kind).not.toBe('awaiting_gate');
  });
});
