import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import { modelAssistantMessage, modelUserMessage, type ModelPort } from '../../../src/ai/model/modelPort';
import { buildActiveContinuationAnchor } from '../../../src/ai/prompting/hostPrompts';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';
import { ScriptedModelPort, scriptedRegistry, validCall } from './helpers/scriptedModelPort';

/**
 * The active loop is blinkered from its first hop: the replayed participant history and the
 * entry/gate exchange never reach the model once the gate is approved. Hop 1 starts from the same
 * continuation anchor every committed hop reseeds.
 */

const HISTORY_SENTINEL = 'EARLIER_TURN_ANSWER_SENTINEL';

const GATE_RESULT = JSON.stringify({
  error: 'action_required',
  gate: 'confirm_sm_start',
  classes: [],
  nodeIds: [],
  detail: 'review revision 1',
  proposalRevision: 1,
});

function seedLineage(session: AiSession): void {
  const nodes = [
    makeNode({
      id: '[ai].[FactSalesReport]',
      schema: 'ai',
      name: 'FactSalesReport',
      type: 'view',
      bodyScript: 'CREATE VIEW [ai].[FactSalesReport] AS SELECT d.DateKey FROM [ai].[DimCalendar] d',
    }),
    makeNode({ id: '[ai].[DimCalendar]', schema: 'ai', name: 'DimCalendar', type: 'table' }),
  ];
  const edges: Array<[string, string]> = [['[ai].[DimCalendar]', '[ai].[FactSalesReport]']];
  session.model = makeModel(nodes, edges, ['ai']);
  session.graph = makeGraph(
    nodes.map(node => ({ id: node.id, schema: node.schema, name: node.name, type: node.type })),
    edges,
  );
}

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
            view: { hops: 1, scope: 1, nodeNames: ['FactSalesReport'], omitted: 0 },
            table: { hops: 0, scope: 1, nodeNames: ['DimCalendar'], omitted: 0 },
          },
        },
      },
      scopeNotes: [],
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
    },
  }, epoch);
}

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

describe('active loop history wipe', () => {
  it('starts hop 1 from the continuation anchor with no replayed participant history', async () => {
    const session = new AiSession();
    seedLineage(session);
    const epoch = session.beginTurn();
    seedProposal(session, epoch);

    const port = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: '[ai].[FactSalesReport]',
          analysisMode: 'bb',
          classification: 'business',
        })],
      },
      // Hop 1: a text-only answer is enough — the assertion is on what the model was sent.
      { text: 'hop one prose' },
    ]);
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
      { name: 'lineage_submit_findings', result: JSON.stringify({ ok: true }) },
    ]);
    const turn = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'wipe-turn',
      getSession: () => session,
      model: port as unknown as ModelPort,
      registry,
      sink: turn.sink,
      turnEpoch: epoch,
      maxRounds: 3,
      priorMessages: [
        modelUserMessage('what feeds dbo.Orders?'),
        modelAssistantMessage(HISTORY_SENTINEL),
      ],
    });

    const running = runtime.run('/trace [ai].[FactSalesReport]');
    const gate = await turn.nextGate();
    expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
    await running;

    // Request 0 is the exploration entry; it legitimately carries the conversation.
    expect(port.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(port.requests[0].messages)).toContain(HISTORY_SENTINEL);

    // Request 1 is hop 1 of the active loop: anchor plus the hop message, nothing replayed.
    const hopOne = port.requests[1];
    expect(hopOne.phase).toBe('active');
    expect(JSON.stringify(hopOne.messages)).not.toContain(HISTORY_SENTINEL);
    expect(JSON.stringify(hopOne.messages)).not.toContain('Gate approved');
    expect(hopOne.messages[0]).toEqual(modelUserMessage(buildActiveContinuationAnchor()));
    expect(hopOne.messages).toHaveLength(2);
  });
});
