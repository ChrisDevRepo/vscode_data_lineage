/**
 * BUDGET-STAY-DISCOVERY: an oversized `lineage_get_scope_bundle` stays in discovery.
 *
 * The envelope is an observation the model summarizes; the existing SM-offer pill is the opt-in.
 * `/trace` and column-trace still open SM-entry immediately via entryRouting.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import {
  checkScopeBudget,
  DEFAULT_TURN_TOKEN_BUDGET,
} from '../../../src/ai/support/tokenBudget';
import { captureRejectedScopeOffer } from '../../../src/ai/agent/discoveryCapture';
import {
  ScriptedModelPort,
  scriptedRegistry,
  validCall,
} from './helpers/scriptedModelPort';

const ORIGIN = '[ai].[FactSalesReport]';
const SUMMARY = 'FactSalesReport is a large neighbourhood. A detailed analysis would be needed.';

const GATE_RESULT = JSON.stringify({
  error: 'action_required',
  gate: 'confirm_sm_start',
  classes: [],
  nodeIds: [],
  detail: 'review revision 1',
  proposalRevision: 1,
});

function overBudgetEnvelope(): string {
  const admission = checkScopeBudget(DEFAULT_TURN_TOKEN_BUDGET, 48, 0);
  if (admission.ok) throw new Error('test fixture must overflow the default discovery cap');
  return JSON.stringify({
    ...admission,
    scope_proposal: { origin: ORIGIN, direction: 'bidirectional', depth: 3 },
  });
}

function collectingSink(): { sink: TurnEventSink; events: TurnEvent[] } {
  const events: TurnEvent[] = [];
  return { sink: new TurnEventSink((event) => { events.push(event); }), events };
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

describe('captureRejectedScopeOffer', () => {
  it('reads origin from scope_proposal and floors walkCount at 2', () => {
    const seed = captureRejectedScopeOffer(
      'lineage_get_scope_bundle',
      { origin: ORIGIN },
      overBudgetEnvelope(),
    );
    expect(seed?.origin).toBe(ORIGIN);
    expect(seed?.walkCount).toBe(48);
  });

  it('falls back to the tool-call origin when the envelope omitted scope_proposal', () => {
    const admission = checkScopeBudget(DEFAULT_TURN_TOKEN_BUDGET, 11, 0);
    if (admission.ok) throw new Error('test fixture must overflow');
    const seed = captureRejectedScopeOffer(
      'lineage_get_scope_bundle',
      { origin: ORIGIN },
      JSON.stringify(admission),
    );
    expect(seed?.origin).toBe(ORIGIN);
    expect(seed?.walkCount).toBe(11);
  });

  it('ignores a non-scope tool even when the envelope reason matches', () => {
    expect(captureRejectedScopeOffer('lineage_get_screen_state', { origin: ORIGIN }, overBudgetEnvelope())).toBeNull();
  });
});

describe('oversized discovery stays in chat', () => {
  it('finishes discovery with a summary and seeds the existing SM-offer from the rejected origin', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const model = new ScriptedModelPort([
      {
        toolCalls: [validCall('scope-1', 'lineage_get_scope_bundle', {
          origin: ORIGIN,
          upstream_depth: 'all',
          downstream_depth: 'all',
        })],
      },
      { text: SUMMARY },
    ]);
    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_get_scope_bundle', result: overBudgetEnvelope() },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { sink, events } = collectingSink();
    const runtime = new AgentRuntime({
      threadId: 'budget-stay-discovery',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink,
      turnEpoch: epoch,
      maxRounds: 4,
    });

    await expect(runtime.run(`/search What feeds ${ORIGIN}?`)).resolves.toBe('ok');

    expect(invocations.map(call => call.toolName)).toEqual(['lineage_get_scope_bundle']);
    expect(events.some(event => event.type === 'gate'), 'oversized discovery must not open SM-entry').toBe(false);
    expect(session.phase.kind).toBe('idle');
    expect(session.pendingExploration).toBeNull();
    expect(session.smOfferAvailable()).toBe(true);
    expect(session.lastDiscoveryOrigin).toBe(ORIGIN);
    expect(session.lastDiscoveryAnswer).toBe(SUMMARY);
    expect(events.filter(event => event.type === 'text').map(event => event.type === 'text' ? event.delta : '')).toContain(SUMMARY);
  });

  it('/trace still opens SM-entry immediately', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const model = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'business',
        })],
      },
    ]);
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { sink, nextGate } = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'budget-stay-slash-trace',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink,
      turnEpoch: epoch,
      maxRounds: 2,
    });

    const running = runtime.run(`/trace ${ORIGIN}`);
    const gate = await nextGate();
    expect(gate.gate).toBe('confirm_sm_start');
    runtime.resumeGate(gate.gateId, { kind: 'cancel' });
    await expect(running).resolves.toBe('ok');
  });

  it('column-trace still opens SM-entry immediately', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const model = new ScriptedModelPort([
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: ORIGIN,
          analysisMode: 'ct',
          classification: 'business',
          targetColumns: ['Amount'],
        })],
      },
    ]);
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { sink, nextGate } = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'budget-stay-column-trace',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink,
      turnEpoch: epoch,
      maxRounds: 2,
    });

    const running = runtime.run(`/trace ${ORIGIN}.[Amount]`);
    const gate = await nextGate();
    expect(gate.gate).toBe('confirm_sm_start');
    runtime.resumeGate(gate.gateId, { kind: 'cancel' });
    await expect(running).resolves.toBe('ok');
  });
});
