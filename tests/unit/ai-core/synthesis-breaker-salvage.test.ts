/**
 * Regression tests for the synthesis breaker's salvage disposition in `src/ai/agent/graph.ts`.
 *
 * @remarks
 * m18-close-azure-foundry run-T8S: synthesis assembled a complete `lineage_present_result` draft
 * (4 sections, 7 badges, 7029 chars) and was rejected a third time only on one narrow, already
 * scoped repair — `notes[].node_id` named an unlinkable id, hint "Fix notes only" — which tripped
 * `MAX_TOOL_SEMANTIC_FAILURES` and discarded the whole draft: `answer.md` 0 bytes. This pins the
 * fix: {@link canSalvageSynthesisDraft} (the governor stays untouched — `attemptStop`,
 * `toolAttempt.ts` — only synthesis's terminal handling changed, mirroring the active phase's
 * already-shipped `shouldSalvageActiveStop`) plus the run-level disposition in `synthesisNode`,
 * which renders the held draft through the existing repair-patch path (`deps.registry.invoke`,
 * the same dispatch surface every model tool call uses) instead of failing the turn.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import type { Logger } from '../../../src/utils/log';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import type { PresentResultInput } from '../../../src/ai/tools/presentResult';
import { canSalvageSynthesisDraft } from '../../../src/ai/agent/graph';
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

describe('canSalvageSynthesisDraft', () => {
  it.each([
    [null, false],
    [[], false],
    [['notes'], true],
    [['sections'], false],
    [['notes', 'sections'], false],
    [['highlight_groups'], false],
  ] as const)('authorization %j → salvage=%s', (repairFields, expected) => {
    expect(canSalvageSynthesisDraft(repairFields as never)).toBe(expected);
  });
});

/** Seeds a real single-node BFS graph — no routed neighbors, so the origin hop drains the agenda. */
function seedSingleNodeLineage(session: AiSession): void {
  const node = makeNode({ id: '[ai].[Origin]', schema: 'ai', name: 'Origin', type: 'view', bodyScript: 'CREATE VIEW [ai].[Origin] AS SELECT 1 AS X' });
  session.model = makeModel([node], [], ['ai']);
  session.graph = makeGraph([{ id: node.id, schema: node.schema, name: node.name, type: node.type }], []);
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

/**
 * Commits a minimal presentation artifact through the same public, turn-guarded write the real
 * `lineage_present_result` handler uses on acceptance — mirrors `active-hop-semantic-abandon`'s
 * own stub, reused here as the salvage patch's accepted outcome.
 */
function commitStubPresentation(session: AiSession, epoch: number): string {
  session.commitPresentResultSuccess(epoch, {
    name: 'Test Result',
    nodeIds: ['[ai].[Origin]'],
    aiMetadata: { summary: 'test', description: 'test' },
  } as unknown as PresentationArtifact);
  return JSON.stringify({ ok: true });
}

/**
 * Runs the shared salvage scenario: origin analyzed, then `MAX_TOOL_SEMANTIC_FAILURES`
 * present_result strikes, the last holding `notes` (as given) behind a notes-only repairable
 * rejection — the m18-close-azure-foundry/run-T8S shape. Shared by both cases below; only the
 * held notes and the logger differ.
 */
async function runSalvageScenario(notes: Array<{ node_id: string; text: string }>, logger?: Logger): Promise<{
  session: AiSession;
  outcome: string;
  model: ScriptedModelPort;
  script: unknown[];
  invocations: ReturnType<typeof scriptedRegistry>['invocations'];
}> {
  const session = new AiSession();
  seedSingleNodeLineage(session);
  const epoch = session.beginTurn();
  seedProposal(session, epoch);

  let presentCalls = 0;
  const { registry, invocations } = scriptedRegistry([
    { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
    { name: 'lineage_start_exploration', result: GATE_RESULT },
    {
      name: 'lineage_submit_findings',
      result: (): string => {
        const engine = session.stateMachine!;
        const result = engine.submitFindings({
          focus_node_id: engine.currentFocus!,
          sections: [{ angle: 'business', text: 'origin analyzed' }],
          summary: 'origin analyzed',
          verdict: 'analyze',
        });
        if (!('error' in result)) engine.getHopContext();
        return JSON.stringify(result);
      },
    },
    {
      name: 'lineage_present_result',
      result: (input: unknown): string => {
        const isSalvagePatch = typeof input === 'object' && input !== null
          && (input as Record<string, unknown>).is_update === true;
        if (isSalvagePatch) {
          // The engine's own repair, dispatched directly — never through another model round.
          return commitStubPresentation(session, epoch);
        }
        presentCalls += 1;
        if (presentCalls < MAX_TOOL_SEMANTIC_FAILURES) {
          return JSON.stringify({
            success: false,
            errors: [`sections.0: Unrecognized key: "},{" (attempt ${presentCalls})`],
            hint: 'Fix the listed fields and call lineage_present_result again with the corrected content.',
          });
        }
        // Third strike: a fully assembled draft, rejected only on one narrow, scoped field.
        session.presentResultRepairDraft.hold(
          {
            name: 'vwDiscountCalc Discount trace',
            summary: 'Discount is computed from SalesStaging and discount rules.',
            sections: [{ label: 'Sources', text: 'CustomerMaster supplies the tier used in the lookup.' }],
            highlight_groups: [{ label: 'Sources', color: 'source', node_ids: ['[ai].[Origin]'] }],
            notes,
          } as unknown as PresentResultInput,
          ['notes'],
        );
        return JSON.stringify({
          success: false,
          errors: ['notes[].node_id names IDs the result graph cannot link: `[ai].[vwraworders]`'],
          hint: 'Fix notes only. Resend only these fields: notes. You may repair the held draft by '
            + 'calling lineage_present_result with is_update:true and only these corrected fields: notes.',
        });
      },
    },
  ]);

  const script = [
    { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
    { toolCalls: [validCall('submit-origin', 'lineage_submit_findings', { summary: 'origin analyzed', verdict: 'analyze' })] },
    ...Array.from({ length: MAX_TOOL_SEMANTIC_FAILURES }, (_, i) => (
      { toolCalls: [validCall(`present-${i}`, 'lineage_present_result', { attempt: i })] }
    )),
  ];
  const model = new ScriptedModelPort(script);
  const turn = makeGateSink();
  const runtime = new AgentRuntime({
    threadId: 'synthesis-salvage',
    getSession: () => session,
    model: model as unknown as ModelPort,
    registry,
    sink: turn.sink,
    turnEpoch: epoch,
    maxRounds: 10,
    ...(logger ? { logger } : {}),
  });

  const running = runtime.run('/trace [ai].[Origin]');
  const gate = await turn.nextGate();
  expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
  const outcome = await running;
  return { session, outcome, model, script, invocations };
}

describe('synthesis breaker salvage (run level)', () => {
  it('renders the held draft instead of failing when the third strike is a notes-only repairable rejection', async () => {
    const { session, outcome, model, script, invocations } = await runSalvageScenario([
      { node_id: '[ai].[vwraworders]', text: 'unlinkable caption' },
    ]);

    // RED before the fix: the turn ended 'error' with a `semantic_failures` stop and the draft
    // discarded — see the run-T8S evidence this test pins. GREEN after the fix: the held draft is
    // salvaged and the turn completes.
    expect(outcome).toBe('ok');
    expect(session.presentResultCalledThisTurn).toBe(true);
    // The salvage patch dispatched once more than the model was ever asked for — through the
    // registry directly, never a fourth provider round.
    expect(model.requests.length).toBe(script.length);
    expect(invocations.filter(call => call.toolName === 'lineage_present_result').length)
      .toBe(MAX_TOOL_SEMANTIC_FAILURES + 1);
    const salvageCall = invocations.filter(call => call.toolName === 'lineage_present_result').at(-1)!;
    expect(salvageCall.input).toEqual({ is_update: true, notes: [] });
    // The held draft's usefulness is over either way — salvaged or not.
    expect(session.presentResultRepairDraft.hasRepairableDraft()).toBe(false);
  });

  // D-4 (m19-review-code, opus review): the salvage sends `notes: []` unconditionally, discarding
  // every held caption — including a valid one, like a risk callout — with nothing but a debug
  // log naming the decision. The offending note indexes `validatePresentResult` reports at
  // rejection time are not plumbed onto the held draft (`RepairDraftStore` carries only the
  // repair-field list, `['notes']`), so a precise "resend minus the offenders" repair is out of
  // this call site's reach without a plumbing change outside this fix's scope. This pins what IS
  // in scope: the decision is now named out loud as a full REJECT of `notes[]`, with the discarded
  // count, per `.claude/rules/ai-surface.md` — never a silent narrowing.
  it('logs the discarded note count and names the decision as a REJECT, not a silent narrowing', async () => {
    const debugLines: string[] = [];
    const logger = {
      debug: (msg: string): void => { debugLines.push(msg); },
      info: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
    } as unknown as Logger;

    // Two held notes — one genuinely unlinkable, one a valid caption — both get discarded by the
    // blanket `notes: []` salvage; the log must now say so.
    await runSalvageScenario([
      { node_id: '[ai].[vwraworders]', text: 'unlinkable caption' },
      { node_id: '[ai].[Origin]', text: 'a valid caption discarded alongside it' },
    ], logger);

    const salvageLog = debugLines.find(line => line.includes('synthesis breaker tripped'));
    expect(salvageLog, debugLines.join('\n')).toBeDefined();
    expect(salvageLog).toContain('discarding all 2 held note(s)');
    expect(salvageLog).toContain('REJECT of notes[], not a per-note repair');
  });
});
