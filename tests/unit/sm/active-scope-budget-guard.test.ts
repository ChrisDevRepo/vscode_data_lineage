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
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { afterEach, describe, it } from 'vitest';

afterEach(() => {
  setExplorationNodeCap(DEFAULT_EXPLORATION_NODE_CAP);
  setExplorationTokenBudget(DEFAULT_EXPLORATION_TOKEN_BUDGET);
});

describe('checkActiveScopeAdmission (pure)', () => {
  it('admits a projection under both caps', () => {
    setExplorationNodeCap(10);
    setExplorationTokenBudget(1000);
    const res = checkActiveScopeAdmission(10, 4000);
    assert(res.ok, 'at-cap projection admits (caps are inclusive)');
  });

  it('rejects over the node cap with counts and limits', () => {
    setExplorationNodeCap(10);
    setExplorationTokenBudget(1000);
    const res = checkActiveScopeAdmission(11, 0);
    assert(!res.ok, 'over-node projection rejects');
    if (!res.ok) {
      assert(res.reason === 'over_active_scope_budget', 'stable reason code');
      assert(res.counts.nodes === 11 && res.limits.node_cap === 10, 'counts/limits surfaced');
    }
  });

  it('rejects over the token budget using the chars/4 estimate', () => {
    setExplorationNodeCap(100);
    setExplorationTokenBudget(1000);
    const res = checkActiveScopeAdmission(1, 4001);
    assert(!res.ok, '4001 chars estimates to 1001 tokens > 1000 budget');
    if (!res.ok) assert(res.counts.tokens === 1001, 'token estimate is ceil(chars/4)');
  });

  it('setters clamp to their minimums', () => {
    setExplorationNodeCap(0);
    setExplorationTokenBudget(1);
    assert(!checkActiveScopeAdmission(2, 0).ok, 'node cap clamped to 1, so 2 rejects');
    assert(checkActiveScopeAdmission(1, 4000).ok, 'token budget clamped to 1000, so 1000 tokens admit');
  });
});

describe('NavigationEngine active-phase admission', () => {
  const chainNodes: LineageNode[] = [
    makeNode({ id: 'n0', schema: 'dbo', name: 'n0', type: 'view' }),
    makeNode({ id: 'n1', schema: 'dbo', name: 'n1', type: 'view' }),
    makeNode({ id: 'n2', schema: 'dbo', name: 'n2', type: 'view' }),
    makeNode({ id: 'n3', schema: 'dbo', name: 'n3', type: 'view' }),
  ];
  const chainEdges: Array<[string, string]> = [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']];
  const chainModel: DatabaseModel = makeModel(chainNodes, chainEdges, ['dbo']);
  const chainGraph = makeGraph(chainNodes, chainEdges);

  it('an over-cap route commit is held and rejected before scope mutates; a pruned amend completes', () => {
    // Approved seed at depth 1 is {n0, n1}; cap 2 means any growth rejects.
    setExplorationNodeCap(2);
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });

    const first = engine.getHopContext() as { focus_node?: { id: string } };
    assert(first.focus_node?.id === 'n0', 'first focus is the origin');
    const ok = engine.submitFindings({
      focus_node_id: 'n0',
      sections: [{ angle: 'business' as const, text: 'origin analysis' }],
      summary: 'n0',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'n1', question: 'trace' }],
    }) as { ok?: boolean };
    assert(ok.ok === true, 'route to an in-scope node commits without tripping the guard');

    const second = engine.getHopContext() as { focus_node?: { id: string } };
    assert(second.focus_node?.id === 'n1', 'second focus is n1');
    const rejected = engine.submitFindings({
      focus_node_id: 'n1',
      sections: [{ angle: 'business' as const, text: 'n1 analysis prose' }],
      summary: 'n1',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'n2', question: 'grow beyond the cap' }],
    }) as { error?: string; hint?: string; detail?: Record<string, unknown> };
    assert(rejected.error === 'over_active_scope_budget', 'growth beyond the cap rejects with the stable code');
    assert(typeof rejected.hint === 'string' && rejected.hint.includes('held'), 'hint tells the model its analysis is held');
    assert(rejected.detail?.node_cap === 2, 'detail carries the effective cap');

    // Amend with the growth pruned: sections may be empty — the held draft restores the prose.
    const amended = engine.submitFindings({
      focus_node_id: 'n1',
      sections: [],
      summary: '',
      verdict: 'analyze',
      route_requests: [],
    }) as { ok?: boolean };
    assert(amended.ok === true, 'pruned amend commits against the held draft');

    // Completion is driven by the hop pull: the queue drains inside getHopContext, which flips status.
    const drained = engine.getHopContext() as { done?: boolean };
    assert(drained.done === true, 'no further hops remain — the rejected route never entered the queue');
    assert(engine.status === 'complete', 'engine completes without the over-budget node');
    const slotIds = new Set(engine.getResult().detail_slots.map((s) => s.nodeId));
    assert(slotIds.has('n1') && !slotIds.has('n2'), 'n1 analyzed with held prose; n2 never entered scope');
  });
});
