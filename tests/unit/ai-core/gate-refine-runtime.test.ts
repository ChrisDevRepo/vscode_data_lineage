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

describe('revision-bound gate refinement runtime', () => {
  it('re-emits the unchanged proposal after provider failure and keeps lookup available', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
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
        activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
      },
    }, epoch);

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
      {
        name: 'lineage_start_exploration',
        result: JSON.stringify({
          error: 'action_required',
          gate: 'confirm_sm_start',
          classes: [],
          nodeIds: [],
          detail: 'review revision 1',
          proposalRevision: 1,
        }),
      },
    ]);
    const events: TurnEvent[] = [];
    const gateWaiters: Array<(gate: NativeGateEvent) => void> = [];
    const pendingGates: NativeGateEvent[] = [];
    const sink = new TurnEventSink((event) => {
      events.push(event);
      if (event.type !== 'gate') return;
      const waiter = gateWaiters.shift();
      if (waiter) waiter(event);
      else pendingGates.push(event);
    });
    const nextGate = (): Promise<NativeGateEvent> => {
      const gate = pendingGates.shift();
      return gate ? Promise.resolve(gate) : new Promise(resolve => gateWaiters.push(resolve));
    };
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
});
