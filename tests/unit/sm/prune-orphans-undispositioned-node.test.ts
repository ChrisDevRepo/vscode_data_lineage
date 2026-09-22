/**
 * A prune may not silently drop an in-scope node no hop has judged yet.
 *
 * `getResult` keeps only what stays reachable from the origin inside the approved scope. A node
 * that leaves through that bound carries no prune of its own and no detail slot, so nothing in the
 * delivered answer records that it was removed or why — the drop is invisible to the reader and to
 * the AI that caused it. The don't-orphan guard used to protect only `committedConnectedIds`
 * (analyzed, agenda-queued, or declared by a route/`column_flow`), which is a strict subset of the
 * approved scope: everything the initial BFS admitted but no hop has reached yet was free to be
 * cut off by an unrelated neighbour prune.
 *
 * The protected set is now the whole in-scope population **less** the nodes `getResult` discards on
 * its own as undispositioned sinks. Reading the render's own predicate is what makes the guard and
 * the drop one verdict instead of two: a prune is refused exactly when it would take a node the
 * answer would otherwise show, and accepted when the render was going to drop the node anyway.
 *
 * (1) is the positive half — an unreached supplier behind the prune candidate refuses the prune and
 * is named. (2) is the negative half, and the reason the trim exists: a write-only sink is not
 * evidence, the render already drops it, and protecting it would refuse prunes to preserve nodes
 * that never reach the answer. Nothing here reads prose or judges content; orphaning is topology.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/** A submission outcome, read structurally so a rejection and a commit are told apart by shape. */
type Outcome = { ok?: unknown; error?: string; hint?: string };

function view(id: string): LineageNode {
  return makeNode({ id, schema: 'dbo', name: id, type: 'view' });
}

describe('prune-orphans-undispositioned-node: the guard protects everything the render would keep', () => {
  it('(1) refuses a neighbour prune that would cut off an in-scope supplier no hop has reached, and names it', () => {
    // origin <- mid <- branch <- tail, all four inside an explicit depth-3 upstream scope.
    // `tail` supplies `branch`, so the render keeps it; no hop has reached it, so the old
    // committed-only protected set did not contain it.
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
      view('mid'), view('branch'), view('tail'),
    ];
    const edges: Array<[string, string]> = [['mid', 'origin'], ['branch', 'mid'], ['tail', 'branch']];
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 3 },
    });

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin reads from mid' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'mid', question: 'what supplies mid?' }],
    }) as Outcome;
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const beforePrune = engine.toJSON();
    expect(beforePrune.scopeNodeIds.includes('tail'), 'tail is inside the approved scope').toBe(true);
    expect(
      beforePrune.nodeStates.some((s) => s.nodeId === 'tail'),
      'tail carries no verdict — it is exactly the never-dispositioned class the drop used to swallow',
    ).toBe(false);
    expect(
      beforePrune.agenda.some((e) => e.nodeId === 'tail'),
      'tail is not agenda-queued either, so the committed-only protected set never held it',
    ).toBe(false);

    const focus2 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(focus2.focus_node?.id, 'second focus is mid').toBe('mid');
    const hop2 = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'branch looks off the answer path' }],
      summary: 'mid',
      verdict: 'analyze',
      prune_neighbors: ['branch'],
    }) as Outcome;

    expect('error' in hop2, `pruning branch is refused — it is tail's only path to origin: ${JSON.stringify(hop2)}`).toBe(true);
    expect(hop2.hint ?? '', 'the refusal names the node that would be cut off, so the AI can prune it too or keep the candidate').toContain('tail');
    expect(/orphan/i.test(hop2.hint ?? ''), 'the refusal is stated as an orphaning refusal').toBe(true);

    const after = engine.toJSON();
    expect(after.removedSet.includes('branch'), 'the refused prune leaves branch unremoved').toBe(false);
    expect(after.scopeNodeIds.includes('tail'), 'tail stays in scope — nothing was dropped').toBe(true);
  });

  it('(2) still allows a prune whose only casualty is a write-only sink the render discards anyway', () => {
    // origin -> mid -> branch -> auditSink, traced downstream. `auditSink` is written to and
    // supplies nothing, so `undispositionedSinkIds` peels it out of the render whether or not this
    // prune happens — refusing the prune to preserve it would make the guard and the render
    // disagree about the same node.
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
      view('mid'), view('branch'),
      makeNode({ id: 'auditSink', schema: 'dbo', name: 'auditSink', type: 'table' }),
    ];
    const edges: Array<[string, string]> = [['origin', 'mid'], ['mid', 'branch'], ['branch', 'auditSink']];
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 3 },
    });

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin feeds mid' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'mid', question: 'what does mid feed?' }],
    }) as Outcome;
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    expect(engine.toJSON().scopeNodeIds.includes('auditSink'), 'the sink is in scope, so the guard does see it').toBe(true);

    const focus2 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(focus2.focus_node?.id, 'second focus is mid').toBe('mid');
    const hop2 = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'branch only writes an audit trail' }],
      summary: 'mid',
      verdict: 'analyze',
      prune_neighbors: ['branch'],
    }) as Outcome;

    expect('ok' in hop2, `pruning branch commits — its only casualty is a sink the render drops: ${JSON.stringify(hop2)}`).toBe(true);
    expect(engine.toJSON().removedSet.includes('branch'), 'branch is removed').toBe(true);
  });
});
