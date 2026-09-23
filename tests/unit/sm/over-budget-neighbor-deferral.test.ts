/**
 * Over-budget neighbour deferral — an auto-enqueued neighbour whose addition would push the
 * active scope past the turn's token/node budget is a logged, deferred follow-up (reason
 * `'budget'`), never a route silently dropped with no queue entry, no deferred lead, and no log
 * line.
 *
 * @remarks
 * Regression coverage for `requiredNeighborIds` (src/ai/sm/smBase.ts): its per-neighbour budget
 * filter drops an over-budget neighbour from the auto-enqueue pool by design, but it used to be
 * the only place that neighbour was ever considered — nothing downstream ever saw it again. The
 * fix adds `budgetDeferredNeighborIds`, which the route loop treats exactly like a depth-border
 * deferral: a `DeferredQuestion`/`PendingLead` with `reason: 'budget'`, plus a `[Budget]` debug
 * log line.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('Over-budget neighbour deferral (src/ai/sm/smBase.ts requiredNeighborIds)', () => {
  const nodes: LineageNode[] = ['n0', 'n1', 'n2', 'n3', 'n4'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const edges: Array<[string, string]> = [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  function newEngine(logs: string[]): NavigationEngine {
    return new NavigationEngine(model, graph, (level, msg) => logs.push(`${level}:${msg}`), {});
  }

  /** Drives one hop with no explicit question, so any onward route is purely auto-enqueued. */
  function driveOneHop(engine: NavigationEngine, focusId: string, budget: ReturnType<typeof createTurnTokenBudget>) {
    return engine.submitFindings({
      focus_node_id: focusId, verdict: 'analyze',
      sections: [{ angle: 'business', text: focusId }], summary: focusId,
    }, budget);
  }

  it('B1: an in-border neighbour over the scope budget is deferred with reason "budget" and logged, never dropped with no trace', () => {
    const logs: string[] = [];
    const engine = newEngine(logs);
    engine.init({
      origin: 'n0', question: 'trace downstream', direction: 'downstream',
      depthIntent: { kind: 'default_start' },
    });
    const budget = createTurnTokenBudget({ explorationNodeCap: 4 });

    for (const focusId of ['n0', 'n1', 'n2']) {
      const ctx = engine.getHopContext() as { focus_node?: { id: string } };
      expect(ctx.focus_node?.id, `hop should be at ${focusId}`).toBe(focusId);
      const result = driveOneHop(engine, focusId, budget);
      expect('error' in result, `hop on ${focusId} must not reject: ${JSON.stringify(result)}`).toBe(false);
    }

    let ctx = engine.getHopContext() as { focus_node?: { id: string }; done?: boolean };
    expect(ctx.focus_node?.id, 'fourth hop is n3').toBe('n3');
    const result = driveOneHop(engine, 'n3', budget);
    expect('error' in result, `hop on n3 must not reject: ${JSON.stringify(result)}`).toBe(false);

    const deferred = engine.deferredQuestions;
    const n4Lead = deferred.find(d => d.nodeId === 'n4');
    expect(n4Lead !== undefined, `n4 must appear as a deferred follow-up, got: ${JSON.stringify(deferred)}`).toBe(true);
    expect(n4Lead?.reason, 'the deferral reason must name the budget, not the schema/depth border').toBe('budget');

    ctx = engine.getHopContext() as { focus_node?: { id: string }; done?: boolean };
    expect(ctx.done, 'no fifth hop is dispatched — n4 was deferred, not enqueued').toBe(true);

    expect(
      logs.some(l => l.includes('[Budget]') && l.includes('n4')),
      `expected a [Budget] debug log line naming n4, got:\n${logs.join('\n')}`,
    ).toBe(true);
  });

  it('B2: a persisted engine snapshot round-trips a "budget" pending lead', () => {
    const logs: string[] = [];
    const engine = newEngine(logs);
    engine.init({
      origin: 'n0', question: 'trace downstream', direction: 'downstream',
      depthIntent: { kind: 'default_start' },
    });
    const budget = createTurnTokenBudget({ explorationNodeCap: 4 });
    for (const focusId of ['n0', 'n1', 'n2', 'n3']) {
      engine.getHopContext();
      const r = driveOneHop(engine, focusId, budget);
      expect('error' in r, `hop on ${focusId} must not reject: ${JSON.stringify(r)}`).toBe(false);
    }

    const before = engine.pendingLeads.find(l => l.nodeId === 'n4');
    expect(before?.reason, 'precondition: the live engine holds a budget lead for n4').toBe('budget');

    const snapshot = engine.toJSON();
    const restoredLogs: string[] = [];
    const restored = NavigationEngine.fromJSON(
      snapshot, model, makeGraph(nodes, edges),
      (level, msg) => restoredLogs.push(`${level}:${msg}`), {},
    );

    const after = restored.pendingLeads.find(l => l.nodeId === 'n4');
    expect(after !== undefined, 'the restored engine must still carry the budget lead for n4').toBe(true);
    expect(after?.reason, 'the restored lead keeps its budget reason').toBe('budget');
    const restoredDeferred = restored.deferredQuestions.find(d => d.nodeId === 'n4');
    expect(restoredDeferred?.reason, 'the restored compat projection also reports budget').toBe('budget');
  });

  it('B3: an older-shape snapshot with no budget lead still loads', () => {
    const logs: string[] = [];
    const engine = newEngine(logs);
    engine.init({
      origin: 'n0', question: 'trace downstream', direction: 'downstream',
      depthIntent: { kind: 'default_start' },
    });
    const roomyBudget = createTurnTokenBudget({ explorationNodeCap: 150 });
    engine.getHopContext();
    driveOneHop(engine, 'n0', roomyBudget);

    expect(engine.pendingLeads.length, 'precondition: no lead of any kind exists yet').toBe(0);
    const snapshot = engine.toJSON();
    expect(() => NavigationEngine.fromJSON(
      snapshot, model, makeGraph(nodes, edges), (level, msg) => logs.push(`${level}:${msg}`), {},
    )).not.toThrow();
  });
});
