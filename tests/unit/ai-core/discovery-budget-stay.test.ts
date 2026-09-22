/**
 * BUDGET-STAY-DISCOVERY: an oversized `lineage_get_scope_bundle` stays in discovery.
 *
 * The envelope is a rejection (never charged) the model recovers from with a narrower read; the
 * existing SM-offer pill is the opt-in. Only `/trace` (with or without a named column) opens
 * SM-entry immediately via entryRouting; a free-text `column_trace` verdict runs discovery first.
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
import { captureRejectedScopeOffer, emitDiscoveryBudgetNotice, readOverBudgetNotice } from '../../../src/ai/agent/discoveryCapture';
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
  it('reads origin from scope_proposal and keeps the projected walkCount', () => {
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

describe('readOverBudgetNotice', () => {
  it('reads the rejection from any catalog tool, not only scope bundles', () => {
    const notice = readOverBudgetNotice('lineage_get_screen_state', overBudgetEnvelope());
    expect(notice?.toolName).toBe('lineage_get_screen_state');
    expect(notice?.nodes).toBe(48);
    expect(notice?.hint).toContain('discovery budget');
  });

  it('falls back to the default hint when the envelope omitted it', () => {
    const admission = checkScopeBudget(DEFAULT_TURN_TOKEN_BUDGET, 11, 0);
    if (admission.ok) throw new Error('test fixture must overflow');
    const notice = readOverBudgetNotice('lineage_get_object_detail', JSON.stringify({ ...admission, scope_proposal: undefined }));
    expect(notice?.nodes).toBe(11);
    expect(notice?.hint).toContain('a detailed analysis');
  });

  it('returns null for non-budget envelopes and malformed JSON', () => {
    expect(readOverBudgetNotice('lineage_get_scope_bundle', JSON.stringify({ error: 'not_found' }))).toBeNull();
    expect(readOverBudgetNotice('lineage_get_scope_bundle', 'not json')).toBeNull();
  });
});

describe('emitDiscoveryBudgetNotice', () => {
  it('emits one recoverable inline notice per turn, deduped across rejections', () => {
    const { sink, events } = collectingSink();
    emitDiscoveryBudgetNotice(sink, 'lineage_get_scope_bundle', overBudgetEnvelope());
    emitDiscoveryBudgetNotice(sink, 'lineage_get_screen_state', overBudgetEnvelope());
    const notices = events.filter(event => event.type === 'error');
    expect(notices).toHaveLength(1);
    const first = notices[0];
    if (first.type !== 'error') throw new Error('unreachable');
    expect(first.recoverable).not.toBe(false);
    expect(first.message).toContain('Discovery budget reached');
    expect(first.message).toContain('lineage_get_scope_bundle');
  });

  it('marks nodes only when the envelope carried a count and stays silent for other results', () => {
    const { sink, events } = collectingSink();
    emitDiscoveryBudgetNotice(sink, 'lineage_search_objects', JSON.stringify({ matches: [] }));
    expect(events).toHaveLength(0);
    emitDiscoveryBudgetNotice(sink, 'lineage_get_scope_bundle', JSON.stringify({
      reason: 'over_discovery_budget',
      hint: 'Scope exceeds the discovery budget.',
    }));
    const notices = events.filter(event => event.type === 'error');
    expect(notices).toHaveLength(1);
    expect(notices[0].type === 'error' ? notices[0].message : '').not.toContain('projected nodes');
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
      // The budget envelope is a rejection, not held evidence: the recovery the layer teaches is a
      // narrower per-object read, which lands the observation a text-only summary needs.
      {
        toolCalls: [validCall('detail-1', 'lineage_get_object_detail', { id: ORIGIN })],
      },
      { text: SUMMARY },
    ]);
    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_get_scope_bundle', result: overBudgetEnvelope() },
      { name: 'lineage_get_object_detail', result: JSON.stringify({ id: ORIGIN, definition: 'CREATE VIEW ai.FactSalesReport AS SELECT 1;' }) },
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

    expect(invocations.map(call => call.toolName)).toEqual(['lineage_get_scope_bundle', 'lineage_get_object_detail']);
    expect(events.some(event => event.type === 'gate'), 'oversized discovery must not open SM-entry').toBe(false);
    expect(session.phase.kind).toBe('idle');
    expect(session.pendingExploration).toBeNull();
    expect(session.smOfferAvailable()).toBe(true);
    expect(session.lastDiscoveryOrigin).toBe(ORIGIN);
    expect(session.lastDiscoveryAnswer).toBe(SUMMARY);
    expect(events.filter(event => event.type === 'text').map(event => event.type === 'text' ? event.delta : '')).toContain(SUMMARY);
    const notices = events.filter(event => event.type === 'error');
    expect(notices, 'the budget rejection must reach the user, not only the model').toHaveLength(1);
    expect(notices[0].type === 'error' ? notices[0].message : '').toContain('Discovery budget reached');
  });

  it.each([
    ['plain origin', ORIGIN, { origin: ORIGIN, analysisMode: 'bb' as const, classification: 'business' as const }],
    ['a named column', `${ORIGIN}.[Amount]`, { origin: ORIGIN, analysisMode: 'ct' as const, classification: 'business' as const, targetColumns: ['Amount'] }],
  ])('/trace with %s still opens SM-entry immediately', async (_title, commandTail, startArgs) => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('start-1', 'lineage_start_exploration', startArgs)] },
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

    const running = runtime.run(`/trace ${commandTail}`);
    const gate = await nextGate();
    expect(gate.gate).toBe('confirm_sm_start');
    runtime.resumeGate(gate.gateId, { kind: 'cancel' });
    await expect(running).resolves.toBe('ok');
  });

  it('a free-text column_trace verdict runs discovery first and offers instead of gating', async () => {
    // The detector verdict observed live: column_trace with a string-encoded object name.
    class ColumnTraceVerdictPort extends ScriptedModelPort {
      public override generateStructured<T>(): Promise<T> {
        return Promise.resolve({ entry: 'column_trace', targetColumns: `["${ORIGIN}"]` } as T);
      }
    }
    const session = new AiSession();
    const epoch = session.beginTurn();
    const model = new ColumnTraceVerdictPort([
      {
        toolCalls: [validCall('scope-1', 'lineage_get_scope_bundle', {
          origin: ORIGIN,
          upstream_depth: 'all',
          downstream_depth: 0,
        })],
      },
      {
        toolCalls: [validCall('detail-1', 'lineage_get_object_detail', { id: ORIGIN })],
      },
      { text: SUMMARY },
    ]);
    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_get_scope_bundle', result: overBudgetEnvelope() },
      { name: 'lineage_get_object_detail', result: JSON.stringify({ id: ORIGIN, definition: 'CREATE VIEW ai.FactSalesReport AS SELECT 1;' }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { sink, events } = collectingSink();
    const runtime = new AgentRuntime({
      threadId: 'budget-stay-free-text-column-trace',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink,
      turnEpoch: epoch,
      maxRounds: 4,
    });

    await expect(runtime.run(`review the obj. ${ORIGIN} the all way up what sources and explain business logic.`)).resolves.toBe('ok');

    expect(model.requests[0]?.phase).toBe('discover');
    expect(model.requests[0]?.tools.map(tool => tool.name)).not.toContain('lineage_start_exploration');
    expect(invocations.map(call => call.toolName)).toEqual(['lineage_get_scope_bundle', 'lineage_get_object_detail']);
    expect(events.some(event => event.type === 'gate'), 'free text never opens the approval gate directly').toBe(false);
    expect(session.pendingExploration).toBeNull();
    expect(session.smOfferAvailable()).toBe(true);
  });

});
