import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
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
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { events, sink, nextGate } = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'refine-provider-failure',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
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

    const holdModel = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: '[ai].[FactSalesReport]',
          analysisMode: 'bb',
          classification: 'business',
        })],
      },
    ]);
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const holdTurn = makeGateSink();
    const holdRuntime = new AgentRuntime({
      threadId: 'hold-turn',
      getSession: () => session,
      model: holdModel as unknown as ModelPort,
      registry,
      sink: holdTurn.sink,
      turnEpoch: firstEpoch,
      maxRounds: 1,
    });

    const holding = holdRuntime.run('/trace [ai].[FactSalesReport]');
    const heldGate = await holdTurn.nextGate();
    expect(holdRuntime.resumeGate(heldGate.gateId, { kind: 'hold' })).toBe(true);

    // The turn closes cleanly so VS Code releases the chat input, and the reviewed proposal
    // survives with the session still parked on the gate.
    await expect(holding).resolves.toBe('ok');
    expect(session.pendingExploration?.revision).toBe(1);
    expect(session.phase.kind).toBe('awaiting_gate');
    expect(session.stateMachine).toBeNull();
    expect(holdTurn.events).toContainEqual({
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
      registry,
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

    const holdModel = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: '[ai].[FactSalesReport]',
          analysisMode: 'bb',
          classification: 'business',
        })],
      },
    ]);
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const holdTurn = makeGateSink();
    const holdRuntime = new AgentRuntime({
      threadId: 'hold-then-slash',
      getSession: () => session,
      model: holdModel as unknown as ModelPort,
      registry,
      sink: holdTurn.sink,
      turnEpoch: holdEpoch,
      maxRounds: 1,
    });
    const holding = holdRuntime.run('/trace [ai].[FactSalesReport]');
    const heldGate = await holdTurn.nextGate();
    holdRuntime.resumeGate(heldGate.gateId, { kind: 'hold' });
    await expect(holding).resolves.toBe('ok');
    expect(session.pendingExploration).not.toBeNull();

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
      registry,
      sink: makeGateSink().sink,
      turnEpoch: slashEpoch,
      maxRounds: 1,
    });

    await slashRuntime.run('/search Sales');

    // The stated command wins, so the abandoned proposal cannot be mistaken for a refine target.
    expect(session.pendingExploration).toBeNull();
    expect(session.phase.kind).not.toBe('awaiting_gate');
  });
});
