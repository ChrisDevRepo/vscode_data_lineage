/**
 * A column-border endpoint the AI explicitly prunes, in the same hop that also commits a column
 * edge naming it, stays withheld from the delivered chain.
 *
 * `ct-border-endpoint-disposition.test.ts` covers the sink shape (a node with no state at all).
 * This is the other shape `undispositionedSinkIds`'s border extension missed: a `reachable`
 * render-set node can never carry `action='prune'` (a prune removes it from `reachable` itself,
 * via `removedSet`), so an existing node state there is always a retention verdict — the border
 * set does not route through that removal, so the same `bb_prune_neighbor` verdict that pulled a
 * node out of the render can still sit on a node a column edge names, and treating "has a state"
 * as blanket proof of retention let a pruned write sink stay on the delivered chain.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const ORIGIN = '[x].[vworders]';
const SPMOVE = '[x].[spmove]';
const ARCHIVE = '[x].[archive]';
const TRACED = 'Amt';

describe('CT — a column-border endpoint the AI prunes is withheld, not delivered on trust', () => {
  it('writes_to and prune_neighbors naming the same node in one hop withholds it from the delivered chain', () => {
    const col = { name: TRACED, type: 'int', nullable: 'NULL' as const, extra: '' };
    const nodes = [
      makeNode({ id: ORIGIN, schema: 'x', name: 'vworders', type: 'view', columns: [col] }),
      makeNode({ id: SPMOVE, schema: 'x', name: 'spmove', type: 'procedure', columns: [col] }),
      makeNode({ id: ARCHIVE, schema: 'x', name: 'archive', type: 'table', columns: [col] }),
    ];
    const edgePairs: Array<[string, string]> = [[ORIGIN, SPMOVE], [SPMOVE, ARCHIVE]];
    const model = makeModel(nodes, edgePairs, ['x']);
    const graph = makeGraph(nodes, edgePairs);

    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: ORIGIN,
      question: `trace ${TRACED} downstream`,
      direction: 'downstream',
      analysisMode: 'ct',
      targetColumns: [TRACED],
      depthIntent: { kind: 'explicit', levels: 1 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    let ctx = engine.getHopContext() as { focus_node?: { id: string } };
    expect(ctx.focus_node?.id, 'first hop dispatches the origin').toBe(ORIGIN);
    let outcome = engine.submitFindings({
      focus_node_id: ORIGIN,
      sections: [{ angle: 'business', text: 'origin carries Amt' }],
      summary: 'origin carries Amt',
      verdict: 'analyze',
      column_flow: [{ out_col: TRACED, upstream_columns: [] }],
      route_requests: engine.requiredNeighborIds(ORIGIN).map(id => ({
        nodeId: id,
        question: `What does ${id} decide about the rows the origin admits?`,
      })),
    });
    expect('error' in outcome, `origin hop accepted: ${JSON.stringify(outcome)}`).toBe(false);

    ctx = engine.getHopContext() as { focus_node?: { id: string } };
    expect(ctx.focus_node?.id, 'second hop dispatches spmove').toBe(SPMOVE);
    // spmove both declares the write into `archive` — committing a column edge naming it — and
    // prunes `archive` as a neighbor, in the same submission. `ctDeclaredRouteIds` only gains this
    // edge's endpoints after this call commits, so the same-hop combination is not refused as
    // pruning a declared node.
    outcome = engine.submitFindings({
      focus_node_id: SPMOVE,
      sections: [{ angle: 'business', text: 'spmove writes Amt into archive' }],
      summary: 'spmove writes Amt into archive',
      verdict: 'analyze',
      column_flow: [{
        out_col: TRACED,
        upstream_columns: [{ node: ORIGIN, col: TRACED }],
        writes_to: { node: ARCHIVE, col: TRACED },
      }],
      prune_neighbors: [ARCHIVE],
    });
    expect('error' in outcome, `spmove hop accepted: ${JSON.stringify(outcome)}`).toBe(false);

    const snapshot = engine.toJSON();
    const archiveState = snapshot.nodeStates.find(s => s.nodeId === ARCHIVE);
    expect(archiveState?.action, 'archive carries an explicit prune verdict, not an absent state').toBe('prune');
    expect(archiveState?.source).toBe('ai');

    const committed = snapshot.columnAspect?.edges ?? [];
    expect(committed.some(e => e.to_node === ARCHIVE), 'the column edge into archive is still committed').toBe(true);

    const result = engine.getResult();
    expect(result.fullNodes.some(n => n.id === ARCHIVE), 'archive is not a render member').toBe(false);
    const delivered = result.columnAspect?.edges ?? [];
    expect(
      delivered.some(e => e.to_node === ARCHIVE),
      'a pruned column-border endpoint is withheld from the delivered chain',
    ).toBe(false);

    // Delivery is a projection, never a mutation: a resumed checkpoint still carries the full edge.
    expect(
      engine.toJSON().columnAspect?.edges.some(e => e.to_node === ARCHIVE),
      'the committed edge survives in the checkpoint',
    ).toBe(true);
  });
});
