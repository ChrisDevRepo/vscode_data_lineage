/**
 * Spec 03 approval card: "Nothing is walked before the user approves the proposal card." and
 * "A refine that changes nothing, or answers an outdated card, is refused; a click on an outdated
 * card never approves." The session is the one owner of the card: each shown card carries a
 * proposal identity that is never reused, and only the card the session still holds can approve.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import {
  TurnEventSink,
  type TurnEvent,
} from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { assertActiveTurnLease } from '../../../src/ai/session/turnLease';
import { applyModelToSession } from '../../../src/bridge/messageHandlers';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import type { IToolRegistry } from '../../../src/ai/tools/registry';
import { ScriptedModelPort, validCall } from '../../harness/scriptedModelPort';
import {
  makeGraph,
  makeIndexedModel,
  makeNode,
} from '../helpers/modelFixtures';

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  commands: { executeCommand: vi.fn(async () => undefined) },
}));

const ORIGIN = '[hop].[origin]';
const BRANCH = '[hop].[branch]';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const depth = (levels: number) => ({
  upstream: { levels, exactness: 'exact' },
  downstream: { levels: 0, exactness: 'exact' },
});

function world() {
  const column = [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }];
  const nodes = [
    makeNode({
      id: ORIGIN,
      schema: 'hop',
      name: 'origin',
      type: 'view',
      columns: column,
      bodyScript: `SELECT Value FROM ${BRANCH};`,
    }),
    makeNode({
      id: BRANCH,
      schema: 'hop',
      name: 'branch',
      type: 'view',
      columns: column,
      bodyScript: 'SELECT 1 AS Value;',
    }),
  ];
  const session = new AiSession();
  session.model = makeIndexedModel(nodes, [[BRANCH, ORIGIN]]);
  session.graph = makeGraph(nodes, [[BRANCH, ORIGIN]]);
  const registry = buildAiToolRegistry(
    () => session,
    quiet as never,
    () => undefined,
  );
  return { session, registry };
}

type World = ReturnType<typeof world>;

/** One user turn in which the model proposes (or refines) the plan and the card is shown. */
async function showCard(
  { session, registry }: World,
  input: Record<string, unknown>,
): Promise<string> {
  session.beginTurn();
  session.currentRoundId += 1;
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const raw = String(await registry.invoke('lineage_start_exploration', input));
  expect(JSON.parse(raw).code).toBe('action_required');
  session.takeControlSignal();
  // The card a user sees is the session's held proposal; its identity is what the buttons carry.
  session.enterGate(session.turnEpoch);
  return session.pendingExploration!.proposalId!;
}

const propose = (w: World) =>
  showCard(w, {
    origin: ORIGIN,
    analysisMode: 'bb',
    classification: 'technical',
    depth: depth(1),
  });
const refine = (w: World, levels: number) =>
  showCard(w, {
    proposalRevision: w.session.pendingExploration!.revision,
    depth: depth(levels),
  });

/** Tries to approve the card with `id`; returns whether an engine was built from a proposal. */
function approve(session: AiSession, id: string): boolean {
  let built = false;
  session.activatePendingExploration(id, session.turnEpoch, () => {
    built = true;
    return { code: 'test_stop' } as never;
  });
  return built;
}

const holds = (session: AiSession, id: string): boolean =>
  session.holdsProposal(id);

describe('approval card — the session owns the proposal', () => {
  it.each(['pending', 'active', 'completed'] as const)(
    'loading another model retires the prior approval card and active turn lease (stage=%s)',
    async (stage) => {
      const w = world();
      const shown = await propose(w);
      const lease = {
        sessionId: w.session.id,
        epoch: w.session.turnEpoch,
        signal: new AbortController().signal,
      };
      if (stage !== 'pending') {
        const engine = new NavigationEngine(
          w.session.model!,
          w.session.graph!,
          () => {},
          {},
        );
        expect(
          w.session.activatePendingExploration(
            shown,
            lease.epoch,
            (proposal) => {
              const initialized = engine.init(proposal.init);
              return 'code' in initialized ? initialized : engine;
            },
          ).kind,
        ).toBe('accepted');
        if (stage === 'completed') {
          engine.classification = 'technical';
          expect(engine.getHopContext().focus_node?.id).toBe(ORIGIN);
          expect(
            engine.submitFindings({
              focus_node_id: ORIGIN,
              summary: 'Origin reads branch.',
              sections: [
                { angle: 'technical', text: 'Value comes from branch.' },
              ],
              questions: [{ nodeId: BRANCH, question: 'Explain Value.' }],
            }),
          ).toHaveProperty('ok', true);
          expect(engine.getHopContext().focus_node?.id).toBe(BRANCH);
          expect(
            engine.submitFindings({
              focus_node_id: BRANCH,
              summary: 'Branch supplies Value.',
              sections: [
                { angle: 'technical', text: 'Value is the literal 1.' },
              ],
            }),
          ).toHaveProperty('ok', true);
          engine.getHopContext();
          expect(engine.status).toBe('complete');
          w.session.storeSmResult(engine.getResult(), lease.epoch);
          w.session.enterCompleted(lease.epoch);
          expect(w.session.resultGraph).not.toBeNull();
        }
      }
      // The identity survives the reload, but the SQL and approved dependency scope change.
      const replacement = makeIndexedModel(
        [
          makeNode({
            id: ORIGIN,
            schema: 'hop',
            name: 'origin',
            type: 'view',
            bodyScript: 'SELECT 2 AS Value;',
          }),
        ],
        [],
      );

      applyModelToSession(w.session, replacement, false);

      expect.soft(holds(w.session, shown)).toBe(false);
      expect.soft(approve(w.session, shown)).toBe(false);
      expect
        .soft(() => assertActiveTurnLease(lease, w.session.turnEpoch))
        .toThrow();
      expect(w.session.stateMachine).toBeNull();
      expect(w.session.resultGraph).toBeNull();
      expect(w.session.phase.kind).toBe('idle');
      expect(w.session.model).toBe(replacement);
    },
  );

  it('a card left over from a cancelled proposal never approves the next proposal', async () => {
    const w = world();
    const cancelled = await propose(w);
    w.session.cancelPendingExploration(w.session.turnEpoch);
    const next = await propose(w);

    expect(approve(w.session, cancelled)).toBe(false);
    expect(next).not.toBe(cancelled);
    expect(approve(w.session, next)).toBe(true);
  });

  it('a card superseded by a refinement never approves', async () => {
    const w = world();
    const first = await propose(w);
    const refined = await refine(w, 2);

    expect(holds(w.session, first)).toBe(false);
    expect(holds(w.session, refined)).toBe(true);
    expect(approve(w.session, first)).toBe(false);
  });

  it('cancel clears the proposal, so no card it showed is held or approvable', async () => {
    const w = world();
    const shown = await propose(w);
    w.session.cancelPendingExploration(w.session.turnEpoch);

    expect(w.session.pendingExploration).toBeNull();
    expect(w.session.phase.kind).toBe('idle');
    expect(holds(w.session, shown)).toBe(false);
    expect(approve(w.session, shown)).toBe(false);
  });

  it('the card identity is never reused across cancel, refine, a new chat or a new proposal', async () => {
    const w = world();
    const seen = [await propose(w)];
    seen.push(await refine(w, 2));
    w.session.cancelPendingExploration(w.session.turnEpoch);
    seen.push(await propose(w));
    w.session.beginNativeChatSession();
    seen.push(await propose(w));
    seen.push(await refine(w, 2));

    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a card restored after a host reload never matches a card the new session shows', async () => {
    const before = world();
    const restored = await propose(before);
    const after = world();
    const shown = await propose(after);

    expect(shown).not.toBe(restored);
    expect(holds(after.session, restored)).toBe(false);
    expect(approve(after.session, restored)).toBe(false);
  });
});

describe('approval card — turns resolve only the held card', () => {
  function runTurn(
    w: World,
    script: ConstructorParameters<typeof ScriptedModelPort>,
    options: { abortAfterTool?: string } = {},
  ) {
    const events: TurnEvent[] = [];
    const controller = new AbortController();
    const registry: IToolRegistry<string> = options.abortAfterTool
      ? new Proxy(w.registry, {
          get(target, key, receiver) {
            if (key !== 'invoke') return Reflect.get(target, key, receiver);
            return async (name: string, payload: unknown, callId?: string) => {
              const result = await target.invoke(name, payload, callId);
              if (name === options.abortAfterTool) controller.abort();
              return result;
            };
          },
        })
      : w.registry;
    const turnEpoch = w.session.beginTurn();
    const model = new ScriptedModelPort(...script);
    const runtime = new AgentRuntime({
      threadId: `gate-owner-${turnEpoch}`,
      getSession: () => w.session,
      model,
      registry,
      sink: new TurnEventSink((event) => events.push(event)),
      signal: controller.signal,
      turnEpoch,
      maxRounds: 10,
    });
    const text = () =>
      events
        .flatMap((event) => (event.type === 'text' ? [event.delta] : []))
        .join('');
    return { runtime, events, text, model };
  }

  it('an Approve turn for a card the session no longer holds walks nothing and leaves the held card pending', async () => {
    const w = world();
    const stale = await propose(w);
    const held = await refine(w, 2);
    const turn = runTurn(w, [[]]);

    await turn.runtime.run('Approve & Proceed', {
      kind: 'approve',
      proposalId: stale,
    });

    expect(turn.model.modelCalls + turn.model.structuredCallCount).toBe(0);
    expect(w.session.stateMachine).toBeNull();
    expect(w.session.phase.kind).toBe('awaiting_gate');
    expect(holds(w.session, held)).toBe(true);
    expect(turn.text()).toMatch(/no longer pending/);
  });

  it('a Cancel turn for the held card clears the proposal', async () => {
    const w = world();
    const held = await propose(w);
    const turn = runTurn(w, [[]]);

    await turn.runtime.run('Cancel', { kind: 'cancel', proposalId: held });

    expect(w.session.pendingExploration).toBeNull();
    expect(holds(w.session, held)).toBe(false);
    expect(turn.text()).toBe('Exploration cancelled.');
  });

  it('a scope change stopped after the model replaced the plan leaves no proposal anyone can approve', async () => {
    const w = world();
    const shown = await propose(w);
    const turn = runTurn(
      w,
      [
        [
          {
            toolCalls: [
              validCall('refine-1', 'lineage_start_exploration', {
                proposalRevision: 1,
                depth: depth(2),
              }),
            ],
          },
        ],
        [],
        [{ action: 'change' }],
      ],
      { abortAfterTool: 'lineage_start_exploration' },
    );

    const outcome = await turn.runtime.run('go one level further upstream');

    expect(outcome).toBe('cancelled');
    expect(turn.events.some((event) => event.type === 'gate')).toBe(false);
    expect(w.session.pendingExploration).toBeNull();
    expect(w.session.phase.kind).not.toBe('awaiting_gate');
    expect(approve(w.session, shown)).toBe(false);
  });
});
