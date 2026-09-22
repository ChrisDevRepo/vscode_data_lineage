/**
 * A column-border endpoint the AI prunes in the same hop that also commits a column edge naming
 * it is REFUSED, not withheld: staged same-submit endpoints count as declared before the prune
 * verdict (`smBase.ts` staged shield), so the contradiction never commits. The node stays
 * reachable and its edge is delivered normally.
 *
 * This supersedes the earlier withhold-on-prune contract (the T8S false-terminal MUST miss:
 * accepting the prune removed the sole consumer and the synthesis then correctly reported "no
 * downstream consumers"). `ct-border-endpoint-disposition.test.ts` covers the sink shape (a node
 * with no state at all).
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
    // spmove both declares the write into `archive` — staging a column edge naming it — and
    // prunes `archive` as a neighbor, in the same submission. The staged endpoint counts as
    // declared before the prune verdict, so the contradiction is refused outright.
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
    }) as any;
    expect('error' in outcome, `spmove hop with same-submit prune contradiction is refused: ${JSON.stringify(outcome)}`).toBe(true);
    expect(/orphan/i.test((outcome as any).hint ?? ''), 'the refusal reuses the existing prune_would_orphan hint').toBe(true);

    // The refused submit commits nothing: resubmit without the prune and the edge lands normally.
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
    });
    expect('error' in outcome, `clean resubmit commits: ${JSON.stringify(outcome)}`).toBe(false);

    const snapshot = engine.toJSON();
    expect(!snapshot.removedSet.includes(ARCHIVE), 'archive is never removed').toBe(true);

    const committed = snapshot.columnAspect?.edges ?? [];
    expect(committed.some(e => e.to_node === ARCHIVE), 'the column edge into archive is committed').toBe(true);

    // Render membership needs routing (the model's recovery move on the refusal hint above);
    // the engine guarantee under test is narrower and exact: the contradiction is refused, the
    // node is never removed, and the staged edge survives in the checkpoint for the run that
    // routes it. A never-routed node is not a render member — that admission gap is
    // pre-existing and untouched by this fix.
    const result = engine.getResult();
    expect(result.fullNodes.some(n => n.id === ARCHIVE), 'unrouted archive is not a render member').toBe(false);
  });
});
