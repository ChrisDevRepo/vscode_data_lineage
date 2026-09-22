/**
 * Active-phase scope admission guard: the hop loop's counterpart to the discovery budget.
 *
 * Pure cases drive `checkActiveScopeAdmission` directly; the engine case proves the wiring —
 * an over-cap route commit is held (hold-and-amend, same contract as route/CT rejections) and
 * rejected with `over_active_scope_budget` BEFORE any scope mutation, so the model can resend
 * a pruned submission that reuses its held prose.
 *
 * Each case builds the caps it exercises as one immutable per-turn budget and passes it to the
 * call, so no case can observe another's caps.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import {
  checkActiveScopeAdmission,
  createTurnTokenBudget,
} from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('checkActiveScopeAdmission (pure)', () => {
  it('admits a projection under both caps', () => {
    const budget = createTurnTokenBudget({ explorationNodeCap: 10, explorationTokenBudget: 1000 });
    const res = checkActiveScopeAdmission(budget, 10, 4000);
    expect(res.ok, 'at-cap projection admits (caps are inclusive)').toBe(true);
  });

  it('rejects over the node cap with counts and limits', () => {
    const budget = createTurnTokenBudget({ explorationNodeCap: 10, explorationTokenBudget: 1000 });
    const res = checkActiveScopeAdmission(budget, 11, 0);
    expect(!res.ok, 'over-node projection rejects').toBe(true);
    if (!res.ok) {
      expect(res.reason === 'over_active_scope_budget', 'stable reason code').toBe(true);
      expect(res.counts.nodes === 11 && res.limits.node_cap === 10, 'counts/limits surfaced').toBe(true);
    }
  });

  it('rejects over the token budget using the chars/4 estimate', () => {
    const budget = createTurnTokenBudget({ explorationNodeCap: 100, explorationTokenBudget: 1000 });
    const res = checkActiveScopeAdmission(budget, 1, 4001);
    expect(!res.ok, '4001 chars estimates to 1001 tokens > 1000 budget').toBe(true);
    if (!res.ok) expect(res.counts.tokens === 1001, 'token estimate is ceil(chars/4)').toBe(true);
  });

  it('the budget clamps to its minimums', () => {
    const budget = createTurnTokenBudget({ explorationNodeCap: 0, explorationTokenBudget: 1 });
    expect(!checkActiveScopeAdmission(budget, 2, 0).ok, 'node cap clamped to 1, so 2 rejects').toBe(true);
    expect(checkActiveScopeAdmission(budget, 1, 4000).ok, 'token budget clamped to 1000, so 1000 tokens admit').toBe(true);
  });
});

describe('NavigationEngine active-phase admission', () => {
  // Six nodes so the default seed (DEFAULT_SM_START_DEPTH = 3) covers {n0..n3} and leaves n4
  // genuinely outside it. The depth intent is deliberately `default_start`: this test is about
  // the node-cap admission guard, so the depth border must stay non-binding or it would refuse
  // the route first and the guard under test would never run.
  const chainNodes: LineageNode[] = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const chainEdges: Array<[string, string]> = [
    ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'],
  ];
  const chainModel: DatabaseModel = makeModel(chainNodes, chainEdges, ['dbo']);
  const chainGraph = makeGraph(chainNodes, chainEdges);

  it('an over-cap route commit is held and rejected before scope mutates; a pruned amend completes', () => {
    // Default seed is {n0, n1, n2, n3}; cap 4 means any growth past it rejects.
    const capFour = createTurnTokenBudget({ explorationNodeCap: 4 });
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'default_start' } });

    // Walk the in-scope prefix; none of these routes grow the scope, so none trip the guard.
    for (const [focus, next] of [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']] as const) {
      const ctx = engine.getHopContext() as { focus_node?: { id: string } };
      expect(ctx.focus_node?.id === focus, `focus is ${focus}`).toBe(true);
      const ok = engine.submitFindings({
        focus_node_id: focus,
        sections: [{ angle: 'business' as const, text: `${focus} analysis` }],
        summary: focus,
        verdict: 'analyze',
        route_requests: [{ nodeId: next, question: 'trace' }],
      }, capFour) as { ok?: boolean };
      expect(ok.ok === true, `route to in-scope ${next} commits without tripping the guard`).toBe(true);
    }

    const atBorder = engine.getHopContext() as { focus_node?: { id: string } };
    expect(atBorder.focus_node?.id === 'n3', 'final in-scope focus is n3').toBe(true);
    const rejected = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [{ angle: 'business' as const, text: 'n3 analysis prose' }],
      summary: 'n3',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'n4', question: 'grow beyond the cap' }],
    }, capFour) as { error?: string; hint?: string; detail?: Record<string, unknown> };
    expect(rejected.error === 'over_active_scope_budget', 'growth beyond the cap rejects with the stable code').toBe(true);
    expect(typeof rejected.hint === 'string' && rejected.hint.includes('held'), 'hint tells the model its analysis is held').toBe(true);
    expect(rejected.detail?.node_cap === 4, 'detail carries the effective cap').toBe(true);

    // exactly one route is staged, which is the shape that cost an earlier run its
    // T8 answer. Every set-choosing repair is inapplicable here — the model judged its one route
    // essential, kept it, and resubmitted byte-identical three times until the breaker. The hint
    // must name the repair that exists at this shape, and only that one.
    const singleHint = rejected.hint ?? '';
    expect(/route_requests:\[\]/.test(singleHint), 'with one staged route the hint names the repair that always exists — resend with route_requests:[]').toBe(true);
    expect(/no smaller set of routes exists/.test(singleHint), 'the hint says why choosing a subset is not open, so the model does not re-derive it by resubmitting').toBe(true);
    expect(/keeping only the routes essential/.test(singleHint), 'the set-choosing repair is not offered where no set exists — following it produces the identical resubmission').toBe(false);
    expect(/1 new route would/.test(singleHint), 'one route reads as one route').toBe(true);

    // Amend with the growth pruned: sections may be empty — the held draft restores the prose.
    const amended = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [],
      summary: '',
      verdict: 'analyze',
      route_requests: [],
    }, capFour) as { ok?: boolean };
    expect(amended.ok === true, 'pruned amend commits against the held draft').toBe(true);

    // Completion is driven by the hop pull: the queue drains inside getHopContext, which flips status.
    const drained = engine.getHopContext() as { done?: boolean };
    expect(drained.done === true, 'no further hops remain — the rejected route never entered the queue').toBe(true);
    expect(engine.status === 'complete', 'engine completes without the over-budget node').toBe(true);
    const slotIds = new Set(engine.getResult().detail_slots.map((s) => s.nodeId));
    expect(slotIds.has('n3') && !slotIds.has('n4'), 'n3 analyzed with held prose; n4 never entered scope').toBe(true);
  });

  it('an admitted growth records [Admit] with the counts it admitted under', () => {
    // The reject path recorded the budget it broke; the admit path recorded nothing, so a run that
    // never grew the scope and a run that grew it comfortably read identically in host.log. The
    // line carries the same kv shape as [Reject] so evidence_review.facts_host_log buckets it.
    const fanNodes: LineageNode[] = ['f0', 'f1', 'f2', 'f3', 'f4'].map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view' }));
    const fanEdges: Array<[string, string]> = [['f0', 'f1'], ['f1', 'f2'], ['f2', 'f3'], ['f3', 'f4']];
    const capFifty = createTurnTokenBudget({ explorationNodeCap: 50 });
    const logs: string[] = [];
    const engine = new NavigationEngine(makeModel(fanNodes, fanEdges, ['dbo']), makeGraph(fanNodes, fanEdges), (_l, m) => logs.push(m), {});
    engine.init({ origin: 'f0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'default_start' } });
    for (const [focus, next] of [['f0', 'f1'], ['f1', 'f2'], ['f2', 'f3']] as const) {
      engine.getHopContext();
      engine.submitFindings({
        focus_node_id: focus,
        sections: [{ angle: 'business' as const, text: `${focus} analysis` }],
        summary: focus,
        verdict: 'analyze',
        route_requests: [{ nodeId: next, question: 'trace' }],
      }, capFifty);
    }
    engine.getHopContext();
    logs.length = 0;
    const ok = engine.submitFindings({
      focus_node_id: 'f3',
      sections: [{ angle: 'business' as const, text: 'f3 grows the scope by one, well under the cap' }],
      summary: 'f3',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'f4', question: 'grow inside the cap' }],
    }, capFifty) as { ok?: boolean };
    expect(ok.ok === true, 'growth under the cap commits').toBe(true);
    const admit = logs.find(m => m.includes('[Admit] guard=active_scope_budget'));
    expect(admit !== undefined, 'the admitted growth is recorded, not only the rejected one').toBe(true);
    expect(admit?.includes('routes=+1'), 'the record names how much scope was admitted').toBe(true);
    expect(/nodes=\d+\/50/.test(admit ?? ''), 'the record names the budget it was admitted under').toBe(true);
  });

  it('with more than one staged route the hint keeps the set-choosing repairs and adds the empty-route escape', () => {
    // The other half of the budget branch. A fan-out origin stages two out-of-cap routes at once, so
    // pruning to a subset is genuinely open and stays offered — the fix narrows the wording only
    // where the subset does not exist.
    // The fan sits past the default seed (DEFAULT_SM_START_DEPTH = 3 covers f0..f3), so both
    // branches are genuine scope growth — a fan at the origin would already be seeded and grow
    // nothing.
    const fanNodes: LineageNode[] = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view' }));
    const fanEdges: Array<[string, string]> = [['f0', 'f1'], ['f1', 'f2'], ['f2', 'f3'], ['f3', 'f4'], ['f3', 'f5']];
    const capFour = createTurnTokenBudget({ explorationNodeCap: 4 });
    const engine = new NavigationEngine(makeModel(fanNodes, fanEdges, ['dbo']), makeGraph(fanNodes, fanEdges), () => {}, {});
    engine.init({ origin: 'f0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'default_start' } });
    for (const [focus, next] of [['f0', 'f1'], ['f1', 'f2'], ['f2', 'f3']] as const) {
      engine.getHopContext();
      expect((engine.submitFindings({
        focus_node_id: focus,
        sections: [{ angle: 'business' as const, text: `${focus} analysis` }],
        summary: focus,
        verdict: 'analyze',
        route_requests: [{ nodeId: next, question: 'trace' }],
      }, capFour) as { ok?: boolean }).ok === true, `in-scope route to ${next} commits`).toBe(true);
    }
    engine.getHopContext();
    const rejected = engine.submitFindings({
      focus_node_id: 'f3',
      sections: [{ angle: 'business' as const, text: 'f3 fans out' }],
      summary: 'f3',
      verdict: 'analyze',
      route_requests: [
        { nodeId: 'f4', question: 'grow beyond the cap' },
        { nodeId: 'f5', question: 'grow beyond the cap' },
      ],
    }, capFour) as { error?: string; hint?: string; detail?: Record<string, unknown> };
    expect(rejected.error === 'over_active_scope_budget', 'two staged routes past the cap reject with the stable code').toBe(true);
    const manyHint = rejected.hint ?? '';
    expect(/keeping only the routes essential/.test(manyHint), 'choosing a subset is open here, so it stays the first repair offered').toBe(true);
    expect(/route_requests:\[\]/.test(manyHint), 'the repair that always exists is named here too, not only where it is the last one left').toBe(true);
    expect(/no smaller set of routes exists/.test(manyHint), 'a smaller set does exist here, so the hint does not claim otherwise').toBe(false);
  });
});
