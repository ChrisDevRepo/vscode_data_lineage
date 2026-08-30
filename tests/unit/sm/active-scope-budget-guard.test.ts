/**
 * Active-phase scope admission guard: the hop loop's counterpart to the discovery budget.
 *
 * Pure cases drive `checkActiveScopeAdmission` directly; the engine case proves the wiring —
 * an over-cap route commit is held (hold-and-amend, same contract as route/CT rejections) and
 * rejected with `over_active_scope_budget` BEFORE any scope mutation, so the model can resend
 * a pruned submission that reuses its held prose.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import {
  DEFAULT_EXPLORATION_NODE_CAP,
  DEFAULT_EXPLORATION_TOKEN_BUDGET,
  checkActiveScopeAdmission,
  setExplorationNodeCap,
  setExplorationTokenBudget,
} from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it, afterEach } from 'vitest';

afterEach(() => {
  setExplorationNodeCap(DEFAULT_EXPLORATION_NODE_CAP);
  setExplorationTokenBudget(DEFAULT_EXPLORATION_TOKEN_BUDGET);
});

describe('checkActiveScopeAdmission (pure)', () => {
  it('admits a projection under both caps', () => {
    setExplorationNodeCap(10);
    setExplorationTokenBudget(1000);
    const res = checkActiveScopeAdmission(10, 4000);
    expect(res.ok, 'at-cap projection admits (caps are inclusive)').toBe(true);
  });

  it('rejects over the node cap with counts and limits', () => {
    setExplorationNodeCap(10);
    setExplorationTokenBudget(1000);
    const res = checkActiveScopeAdmission(11, 0);
    expect(!res.ok, 'over-node projection rejects').toBe(true);
    if (!res.ok) {
      expect(res.reason === 'over_active_scope_budget', 'stable reason code').toBe(true);
      expect(res.counts.nodes === 11 && res.limits.node_cap === 10, 'counts/limits surfaced').toBe(true);
    }
  });

  it('rejects over the token budget using the chars/4 estimate', () => {
    setExplorationNodeCap(100);
    setExplorationTokenBudget(1000);
    const res = checkActiveScopeAdmission(1, 4001);
    expect(!res.ok, '4001 chars estimates to 1001 tokens > 1000 budget').toBe(true);
    if (!res.ok) expect(res.counts.tokens === 1001, 'token estimate is ceil(chars/4)').toBe(true);
  });

  it('setters clamp to their minimums', () => {
    setExplorationNodeCap(0);
    setExplorationTokenBudget(1);
    expect(!checkActiveScopeAdmission(2, 0).ok, 'node cap clamped to 1, so 2 rejects').toBe(true);
    expect(checkActiveScopeAdmission(1, 4000).ok, 'token budget clamped to 1000, so 1000 tokens admit').toBe(true);
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
    setExplorationNodeCap(4);
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
      }) as { ok?: boolean };
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
    }) as { error?: string; hint?: string; detail?: Record<string, unknown> };
    expect(rejected.error === 'over_active_scope_budget', 'growth beyond the cap rejects with the stable code').toBe(true);
    expect(typeof rejected.hint === 'string' && rejected.hint.includes('held'), 'hint tells the model its analysis is held').toBe(true);
    expect(rejected.detail?.node_cap === 4, 'detail carries the effective cap').toBe(true);

    // Amend with the growth pruned: sections may be empty — the held draft restores the prose.
    const amended = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [],
      summary: '',
      verdict: 'analyze',
      route_requests: [],
    }) as { ok?: boolean };
    expect(amended.ok === true, 'pruned amend commits against the held draft').toBe(true);

    // Completion is driven by the hop pull: the queue drains inside getHopContext, which flips status.
    const drained = engine.getHopContext() as { done?: boolean };
    expect(drained.done === true, 'no further hops remain — the rejected route never entered the queue').toBe(true);
    expect(engine.status === 'complete', 'engine completes without the over-budget node').toBe(true);
    const slotIds = new Set(engine.getResult().detail_slots.map((s) => s.nodeId));
    expect(slotIds.has('n3') && !slotIds.has('n4'), 'n3 analyzed with held prose; n4 never entered scope').toBe(true);
  });
});
