/**
 * A `column_flow` entry that names a node for a traced column is the same declaration as an
 * accepted `route_request` — `AI declares, backend guards` (memory
 * `ai-declares-backend-guards.md`, PM 2026-09-09): once the AI maps a column to a neighbour, the
 * backend keeps that node prune-protected for the rest of the run, whatever field carried the
 * name.
 *
 * @remarks
 * `submitFindings` (`smBase.ts:2367-2382`) already synthesizes an implicit `route_requests` entry
 * for every `column_flow[].upstream_columns[].node` the model did not explicitly route, and that
 * implicit route — once *accepted* by the border/depth admission check — lands in
 * `ctDeclaredRouteIds` the same as an authored one (`smBase.ts:2877`), so the sibling guard
 * (`ct-declared-route-prune-guard.test.ts`) already covers the common `upstream_columns` case.
 *
 * `column_flow[].writes_to.node` is the gap: it is never fed into that synthesis loop
 * (`smBase.ts:2368-2381` iterates `entry.upstream_columns` only), yet `ColumnTracer.
 * validateColumnFlow` stages a real edge to it (`to_node: toNodeForEdge`, `columnTracer.ts:301-312`)
 * and the completeness guard treats the column as accounted for. A node named only via
 * `writes_to` is therefore declared and evidenced in the trace but carries no route outcome at
 * all — accepted, deferred, or excluded — so it never reaches `ctDeclaredRouteIds` and a later
 * `prune_neighbors` on it is wrongly accepted.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/**
 * origin --(upstream)--> source (table, routed normally via the upstream_columns synthesis).
 * `sink` is a separate, topologically isolated table (no edges to or from anything) named only as
 * the `writes_to.node` of origin's traced-column entry — never in `route_requests`, never in
 * `upstream_columns`. Isolated so the generic don't-orphan BFS (`firstDisconnectedAfterPrune`)
 * has nothing to catch it on: only the declaration-membership check this fix adds can refuse its
 * prune.
 */
function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'source', schema: 'ct', name: 'source', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'sink', schema: 'ct', name: 'sink', type: 'table', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [
    ['source', 'origin'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

describe('CT column_flow-declared prune guard', () => {
  it('(1) CT: a node named only in column_flow.writes_to for a traced column is refused when a later hop prunes it, and stays unremoved for the rest of the run', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin reads Total from source and writes it to sink' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      // `sink` is declared here only as the writes_to target — never route_requests, never
      // upstream_columns. `source` is the upstream contributor, routed via the pre-existing
      // implicit-synthesis path.
      column_flow: [{
        out_col: 'Total',
        writes_to: { node: 'sink', col: 'Total' },
        upstream_columns: [{ node: 'source', col: 'Total' }],
      }],
    }) as any;
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const afterHop1 = engine.toJSON();
    expect(!afterHop1.removedSet.includes('sink'), 'sink is not removed by hop1').toBe(true);
    expect(!afterHop1.agenda.some((e) => e.nodeId === 'sink'), 'sink never gets an agenda entry — it was never routed').toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'second focus is source').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source supplies Total directly' }],
      summary: 'source supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      prune_neighbors: ['sink'],
    }) as any;

    expect('error' in hop2, `the prune of the writes_to-declared node sink is refused: ${JSON.stringify(hop2)}`).toBe(true);
    expect(/orphan/i.test(hop2.hint ?? ''), 'the refusal reuses the existing prune_would_orphan hint').toBe(true);

    const state = engine.toJSON();
    expect(!state.removedSet.includes('sink'), 'the refused prune leaves sink unremoved').toBe(true);

    // `sink` was never routed or scope-admitted (no route_requests, no accepted route through the
    // writes_to surface — that admission gap is a separate, pre-existing concern this fix does not
    // touch). The guarantee under test is narrower and exact: the refused prune leaves it
    // unremoved for the rest of the run, driven here to completion.
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: 'noop' }],
        summary: 'noop',
        verdict: 'passthrough',
      });
    }
    expect(!engine.toJSON().removedSet.includes('sink'), 'sink stays unremoved through the rest of the run').toBe(true);
  });

  it('(2) BB parity: the same topology is unaffected — BB carries no column_flow field, and the equivalent prune commits as before', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'BB counterpart', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'BB init succeeds').toBe(true);

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin reads Total from source' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: [
        { nodeId: 'source', question: 'route it' },
      ],
    }) as any;
    expect('ok' in hop1, `BB hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'BB second focus is source').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source' }],
      summary: 'source',
      verdict: 'analyze',
      prune_neighbors: ['sink'],
    }) as any;

    expect('ok' in hop2, 'BB: sink was never declared by any CT-only mechanism — no protection leaks into BB').toBe(true);
    const state = engine.toJSON();
    expect(state.removedSet.includes('sink'), 'BB behavior is unchanged: sink is pruned').toBe(true);
    expect(state.ctDeclaredRouteIds, 'BB snapshot does not persist a CT-only declaration set').toBeUndefined();
  });
});
