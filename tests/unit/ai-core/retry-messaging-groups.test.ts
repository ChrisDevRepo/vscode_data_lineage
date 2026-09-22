/**
 * Package 4 — retry messaging. `REJECTION_SHORT_LABELS` used to hold 3 entries covering none of
 * the six rejection codes an observed production run actually hit, so a raw machine code (e.g.
 * `out_col_not_tracked`) printed straight into the chat retry line. `classifyRejectionCode`
 * (`src/ai/tools/toolProvider.ts`) is now the ONE classification both the chat-facing
 * `Retry N — <group>` line (`src/ai/agent/graph.ts`) and the debug-facing `[Reject] group=…` line
 * read, so the two can never disagree and an unmapped code can never leak.
 *
 * @remarks
 * Five groups by design — no "scope limit" group. The chat/debug retry machinery only reacts to a
 * CHARGEABLE rejection (`semanticFailures` increasing); `over_discovery_budget` and
 * `over_active_scope_budget` are non-chargeable (`NON_CHARGEABLE_REJECTION_CODES`,
 * `src/ai/agent/toolAttempt.ts`) so they never reach it, and `result_too_large` never becomes a
 * member of `rejections[]` at all. The last test below pins that a non-chargeable rejection still
 * loops the hop to completion but never announces a retry.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission } from '../../../src/ai/sm/smTypes';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { buildAiToolRegistry, classifyRejectionCode, type RejectionChatGroup } from '../../../src/ai/tools/toolProvider';
import { Logger } from '../../../src/utils/log';
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

/** Seeds a real BFS graph: a single origin with no neighbours — one hop is the whole exploration. */
function seedSingleNodeLineage(session: AiSession): void {
  const nodes = [
    makeNode({ id: '[ai].[Origin]', schema: 'ai', name: 'Origin', type: 'view', bodyScript: 'CREATE VIEW [ai].[Origin] AS SELECT 1 AS X' }),
  ];
  session.model = makeModel(nodes, [], ['ai']);
  session.graph = makeGraph(nodes.map(n => ({ id: n.id, schema: n.schema, name: n.name, type: n.type })), []);
}

function seedProposal(session: AiSession, epoch: number): void {
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
      hopCount: 1,
      scopeCount: 1,
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
          hops: 1,
          scope: 1,
          byType: { view: { hops: 1, scope: 1, nodeNames: [], omitted: 0 } },
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

/** Submits through the REAL engine, mirroring `submitFindings.ts`'s own post-commit dequeue. */
function submitAndAdvance(engine: NavigationEngine, finding: HopSubmission) {
  const result = engine.submitFindings(finding);
  if (!('error' in result)) engine.getHopContext();
  return result;
}

/** Commits a minimal presentation artifact through the same turn-guarded write the real handler uses. */
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

/**
 * Runs a one-hop exploration (a single origin node, no neighbours) whose first `submit_findings`
 * call is rejected with `code`, then accepted on the repair attempt. Exercises the real active-hop
 * retry path (`emitRepairProgress` in `graph.ts`) end to end.
 */
async function runOneHopRetry(code: string, hint: string) {
  const session = new AiSession();
  seedSingleNodeLineage(session);
  const epoch = session.beginTurn();
  seedProposal(session, epoch);

  let submitCalls = 0;
  const { registry } = scriptedRegistry([
    { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
    { name: 'lineage_start_exploration', result: GATE_RESULT },
    {
      name: 'lineage_submit_findings',
      result: (): string => {
        submitCalls += 1;
        const engine = session.stateMachine as NavigationEngine;
        if (submitCalls === 1) return JSON.stringify({ error: code, hint });
        return JSON.stringify(submitAndAdvance(engine, {
          focus_node_id: engine.currentFocus!,
          sections: [{ angle: 'business', text: 'origin analyzed' }],
          summary: 'origin analyzed',
          verdict: 'analyze',
        }));
      },
    },
    { name: 'lineage_present_result', result: () => commitStubPresentation(session, epoch) },
  ]);

  const script = [
    { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
    { toolCalls: [validCall('submit-reject', 'lineage_submit_findings', { attempt: 0 })] },
    { toolCalls: [validCall('submit-origin', 'lineage_submit_findings', { summary: 'origin analyzed', verdict: 'analyze' })] },
    { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
  ];
  const model = new ScriptedModelPort(script);
  const turn = makeGateSink();
  const runtime = new AgentRuntime({
    threadId: `retry-group-${code}`,
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
  return { outcome, events: turn.events, runtime };
}

/** Captures every channel line by level, standing in for the VS Code `LogOutputChannel`. */
function capturingChannel(): { channel: Parameters<typeof Logger.create>[0]; lines: Record<'info' | 'debug' | 'warn' | 'error', string[]> } {
  const lines: Record<'info' | 'debug' | 'warn' | 'error', string[]> = { info: [], debug: [], warn: [], error: [] };
  const channel = {
    info: (line: string) => lines.info.push(line),
    debug: (line: string) => lines.debug.push(line),
    warn: (line: string) => lines.warn.push(line),
    error: (line: string) => lines.error.push(line),
  } as unknown as Parameters<typeof Logger.create>[0];
  return { channel, lines };
}

describe('classifyRejectionCode — Package 4 group membership', () => {
  const GROUP_MEMBERS: Readonly<Record<Exclude<RejectionChatGroup, 'correction'>, readonly string[]>> = {
    column_mapping: [
      'out_col_not_tracked',
      'bad_out_col',
      'bad_contributor_col',
      'self_loop_column',
      'pruned_contributor',
      'column_chain_incomplete',
    ],
    source_selection: [
      REJECTION_CODES.pruneWouldOrphanNoted,
      'missing_required_route',
      'route_validation_failed',
      'prune_route_conflict',
      'prune_origin_forbidden',
    ],
    answer_format: [
      'validation',
      REJECTION_CODES.invalidInput,
      REJECTION_CODES.ctFieldRequired,
      REJECTION_CODES.ctFieldForbiddenInBb,
      REJECTION_CODES.bbFieldUnknown,
      REJECTION_CODES.missingField,
      'field_length_exceeded',
      'empty_structured_output',
      'missing_required_tool_call',
      'classification_lock_violation',
    ],
  };

  for (const [group, codes] of Object.entries(GROUP_MEMBERS)) {
    it(`classifies every ${group} code from the plan's Package 4 table`, () => {
      for (const code of codes) {
        expect(classifyRejectionCode(code), code).toBe(group);
      }
    });
  }

  it('falls every rejectionCodes.ts code through to the correction fallback, except the ones explicitly mapped', () => {
    // The single-owner shared module carries seven codes with a non-fallback group: the CT/BB
    // envelope-shape guards (`answer_format`, asserted above) and the orphan-prune and
    // origin-prune guards (`source_selection`). Every other exported code is a session/state marker, a transport
    // artifact, a budget guard, or a control-flow marker — none says anything about the model's
    // semantic accuracy, so none may borrow one of the four named groups.
    const explicitlyMapped: ReadonlySet<string> = new Set([
      REJECTION_CODES.pruneWouldOrphanNoted,
      REJECTION_CODES.pruneOriginForbidden,
      REJECTION_CODES.bbFieldUnknown,
      REJECTION_CODES.invalidInput,
      REJECTION_CODES.ctFieldRequired,
      REJECTION_CODES.ctFieldForbiddenInBb,
      REJECTION_CODES.missingField,
    ]);
    for (const code of Object.values(REJECTION_CODES)) {
      if (explicitlyMapped.has(code)) continue;
      expect(classifyRejectionCode(code), code).toBe('correction');
    }
  });

  it('never leaks a brand-new, never-seen code — it always resolves to correction', () => {
    expect(classifyRejectionCode('a_guard_nobody_has_written_yet')).toBe('correction');
    expect(classifyRejectionCode('')).toBe('correction');
  });
});

describe('[Reject] debug line — group id present, duplicated reason= dropped', () => {
  it('logs tool=, group=, and code= for a real engine rejection, and never a bare reason=', async () => {
    // A fresh session with no live exploration authorizes no active-phase tool — the phase guard
    // (`off_policy`) fires before the handler is ever reached. It is an unmapped code, so the group
    // must read `correction`, and the debug line must still show the real code, never a raw
    // duplicate of it under a `reason=` key.
    const session = new AiSession();
    const { channel, lines } = capturingChannel();
    const registry = buildAiToolRegistry(() => session, channel, () => undefined);

    const raw = await registry.invoke('lineage_submit_findings', {});
    const parsed = JSON.parse(raw as string) as { error: string };
    expect(parsed.error, 'off_policy is the phase guard firing ahead of the handler').toBe('off_policy');

    const rejectLine = lines.debug.find(line => line.includes('[Reject]'));
    expect(rejectLine, `saw ${JSON.stringify(lines.debug)}`).toBeDefined();
    expect(rejectLine).toContain('tool=lineage_submit_findings');
    expect(rejectLine).toContain(`group=${classifyRejectionCode(parsed.error)}`);
    expect(rejectLine).toContain('group=correction');
    expect(rejectLine).toContain(`code=${parsed.error}`);
    expect(rejectLine, 'reason= duplicated code= verbatim on every observed rejection — dropped').not.toContain('reason=');
  });
});

describe('chat retry line — group text, never a raw code', () => {
  it('prints the two-word group for a mapped code', async () => {
    const { outcome, events, runtime } = await runOneHopRetry('out_col_not_tracked', 'name a tracked column');
    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');
    expect(statusLabels(events)).toContain('Hop 1/1 — analysing Origin (Retry 1 — column mapping)');
    expect(textDeltas(events).join('')).not.toContain('out_col_not_tracked');
  });

  it('prints the correction fallback for an unmapped code, and the raw code never reaches chat', async () => {
    const unmappedCode = 'a_future_guard_package_4_never_saw';
    const { outcome, events, runtime } = await runOneHopRetry(unmappedCode, 'stand-in for a rejection no group owns yet');
    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');
    expect(statusLabels(events)).toContain('Hop 1/1 — analysing Origin (Retry 1 — correction)');
    // The decisive assertion: the raw code is in NEITHER the transient status channel NOR any
    // permanent text delta — this is the exact leak Package 4 exists to close.
    expect(statusLabels(events).some(label => label.includes(unmappedCode))).toBe(false);
    expect(textDeltas(events).some(delta => delta.includes(unmappedCode))).toBe(false);
  });

  it('emits no retry line at all for a non-chargeable code (over_discovery_budget), though the hop still recovers', async () => {
    const { outcome, events, runtime } = await runOneHopRetry(REJECTION_CODES.overDiscoveryBudget, 'over the discovery budget');
    expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe('ok');
    // The hop still had to loop past the rejected call to reach its accepted submit — proven by
    // the single, un-suffixed header appearing exactly once (no second entry, no retry bracket).
    const hop1 = statusLabels(events).filter(label => label.startsWith('Hop 1/'));
    expect(hop1).toEqual(['Hop 1/1 — analysing Origin']);
    expect(statusLabels(events).some(label => label.includes('(Retry'))).toBe(false);
  });
});
