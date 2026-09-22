/**
 * BUDGET-REROUTE-DISCOVERY: an oversized `lineage_get_scope_bundle` cuts discovery short.
 *
 * The guard trips on either metric (node cap or token budget), graph dispatch treats that result as
 * a reroute terminal, and the turn leaves discovery for SM entry — where `lineage_start_exploration`
 * opens the consent gate. The model never gets another discovery attempt to answer inline from the
 * rejection, so no summary-then-offer contract can be ignored.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { EntryDetectionSchema } from '../../../src/ai/agent/state';
import {
  checkScopeBudget,
  DEFAULT_TURN_TOKEN_BUDGET,
} from '../../../src/ai/support/tokenBudget';
import { detectOverBudgetFromResult, emitDiscoveryBudgetNotice, readOverBudgetNotice } from '../../../src/ai/agent/discoveryCapture';
import {
  ScriptedModelPort,
  scriptedRegistry,
  validCall,
} from './helpers/scriptedModelPort';

const ORIGIN = '[ai].[FactSalesReport]';

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

describe('detectOverBudgetFromResult', () => {
  it('reroutes an oversized scope bundle', () => {
    expect(detectOverBudgetFromResult('lineage_get_scope_bundle', overBudgetEnvelope())).toBe(true);
  });

  it('never reroutes another catalog surface carrying the same shared envelope', () => {
    // `checkScopeBudget` is shared: an oversized stored-run recall must stay a narrowing hint, not
    // become a fresh exploration approval gate.
    expect(detectOverBudgetFromResult('lineage_get_screen_state', overBudgetEnvelope())).toBe(false);
  });

  it('returns false for non-budget envelopes and malformed JSON', () => {
    expect(detectOverBudgetFromResult('lineage_get_scope_bundle', JSON.stringify({ error: 'not_found' }))).toBe(false);
    expect(detectOverBudgetFromResult('lineage_get_scope_bundle', 'not json')).toBe(false);
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
    const notice = readOverBudgetNotice('lineage_get_object_detail', JSON.stringify({ ...admission, hint: undefined }));
    expect(notice?.nodes).toBe(11);
    expect(notice?.hint).toContain('Narrow the request');
  });

  it('returns null for non-budget envelopes and malformed JSON', () => {
    expect(readOverBudgetNotice('lineage_get_object_detail', JSON.stringify({ error: 'not_found' }))).toBeNull();
    expect(readOverBudgetNotice('lineage_get_object_detail', 'not json')).toBeNull();
  });
});

describe('emitDiscoveryBudgetNotice', () => {
  it('stays silent for a scope bundle — the reroute and its approval gate are the signal', () => {
    const { sink, events } = collectingSink();
    emitDiscoveryBudgetNotice(sink, 'lineage_get_scope_bundle', overBudgetEnvelope());
    expect(events).toHaveLength(0);
  });

  it('emits one recoverable inline notice per turn on the surfaces that stay inline', () => {
    const { sink, events } = collectingSink();
    emitDiscoveryBudgetNotice(sink, 'lineage_get_screen_state', overBudgetEnvelope());
    emitDiscoveryBudgetNotice(sink, 'lineage_get_object_detail', overBudgetEnvelope());
    const notices = events.filter(event => event.type === 'error');
    expect(notices).toHaveLength(1);
    const first = notices[0];
    if (first.type !== 'error') throw new Error('unreachable');
    expect(first.recoverable).not.toBe(false);
    expect(first.message).toContain('Discovery budget reached');
    expect(first.message).toContain('lineage_get_screen_state');
  });

  it('marks nodes only when the envelope carried a count and stays silent for other results', () => {
    const { sink, events } = collectingSink();
    emitDiscoveryBudgetNotice(sink, 'lineage_search_objects', JSON.stringify({ matches: [] }));
    expect(events).toHaveLength(0);
    emitDiscoveryBudgetNotice(sink, 'lineage_get_screen_state', JSON.stringify({
      reason: 'over_discovery_budget',
      hint: 'Scope exceeds the discovery budget.',
    }));
    const notices = events.filter(event => event.type === 'error');
    expect(notices).toHaveLength(1);
    expect(notices[0].type === 'error' ? notices[0].message : '').not.toContain('projected nodes');
  });
});

describe('oversized discovery cuts to the approval process', () => {
  it('reroutes to SM entry and opens the consent gate instead of answering inline', async () => {
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
      // SM entry: the reroute handed the turn here, and the only valid action is the start call
      // that opens the gate.
      {
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: ORIGIN,
          analysisMode: 'bb' as const,
          classification: 'business' as const,
        })],
      },
    ]);
    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_get_scope_bundle', result: overBudgetEnvelope() },
      { name: 'lineage_get_object_detail', result: JSON.stringify({ id: ORIGIN, definition: 'CREATE VIEW ai.FactSalesReport AS SELECT 1;' }) },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { sink, events, nextGate } = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'budget-reroute-discovery',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink,
      turnEpoch: epoch,
      maxRounds: 4,
    });

    const running = runtime.run(`/search What feeds ${ORIGIN}?`);
    const gate = await nextGate();
    expect(gate.gate, 'the over-budget cut opens the exploration approval gate').toBe('confirm_sm_start');
    runtime.resumeGate(gate.gateId, { kind: 'cancel' });
    await expect(running).resolves.toBe('ok');

    expect(invocations.map(call => call.toolName)).toEqual(['lineage_get_scope_bundle', 'lineage_start_exploration']);
    expect(model.requests[0]?.phase).toBe('discover');
    expect(model.requests[1]?.phase).toBe('sm_entry');
    expect(
      events.filter(event => event.type === 'error'),
      'the reroute speaks through the gate — no inline budget notice on this path',
    ).toHaveLength(0);
    expect(session.smOfferAvailable(), 'a cut discovery never records a walk for the offer pill').toBe(false);
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
      threadId: 'budget-reroute-slash-trace',
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

  it('a free-text column_trace verdict runs discovery first, then cuts on the guard', async () => {
    // The detector verdict observed live: column_trace with a string-encoded object name, decoded
    // here through the same schema the real detector call is validated by. The semantic verdict
    // never selects the stage — discovery runs, and only the guard routes to SM.
    class ColumnTraceVerdictPort extends ScriptedModelPort {
      public override generateStructured<T>(): Promise<T> {
        return Promise.resolve(EntryDetectionSchema.parse({
          entry: 'column_trace',
          targetColumns: `["${ORIGIN}"]`,
        }) as T);
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
        toolCalls: [validCall('start-1', 'lineage_start_exploration', {
          origin: ORIGIN,
          analysisMode: 'ct' as const,
          classification: 'business' as const,
          targetColumns: [ORIGIN],
        })],
      },
    ]);
    const { registry, invocations } = scriptedRegistry([
      { name: 'lineage_get_scope_bundle', result: overBudgetEnvelope() },
      { name: 'lineage_start_exploration', result: GATE_RESULT },
    ]);
    const { sink, nextGate } = makeGateSink();
    const runtime = new AgentRuntime({
      threadId: 'budget-reroute-free-text-column-trace',
      getSession: () => session,
      model: model as unknown as ModelPort,
      registry,
      sink,
      turnEpoch: epoch,
      maxRounds: 4,
    });

    const running = runtime.run(`review the obj. ${ORIGIN} the all way up what sources and explain business logic.`);
    const gate = await nextGate();
    expect(gate.gate).toBe('confirm_sm_start');
    runtime.resumeGate(gate.gateId, { kind: 'cancel' });
    await expect(running).resolves.toBe('ok');

    expect(model.requests[0]?.phase).toBe('discover');
    expect(model.requests[0]?.tools.map(tool => tool.name)).not.toContain('lineage_start_exploration');
    expect(invocations.map(call => call.toolName)).toEqual(['lineage_get_scope_bundle', 'lineage_start_exploration']);
  });
});
