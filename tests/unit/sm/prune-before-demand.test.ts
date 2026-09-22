/**
 * PRUNE-BEFORE-DEMAND (TASKLIST.md §2, open since m10; historical scan P2 6 hits, m10-head T7
 * `host.log:186-221`, `vwexternalorders` self-pruned, then `spImportOrders` committed
 * `Quantity<-it`, engine logged `Normalize` then `skip removed`): a node a committed
 * `column_flow` edge names as a value supplier is already removed, and the resulting demand used
 * to be dropped at debug level with no reject and no restore (`enqueueHop`'s visited/removed skip
 * — `reopensColumnChain` refuses to reopen a removed node on purpose, only a body can answer).
 *
 * @remarks
 * `AI declares, backend guards` (memory `ai-declares-backend-guards.md`) was already implemented
 * for the mirror direction — a NEIGHBOR pruning an already-declared node is refused
 * (`declaredPruneIds`, tested by `ct-declared-route-prune-guard.test.ts` /
 * `ct-column-flow-declared-prune-guard.test.ts`). The untested direction is the one
 * `ColumnTracer.validateColumnFlow` never checked: whether an `upstream_columns` contributor is
 * ALREADY in `removedSet` before the edge naming it stages. Confirmed in code at HEAD (line
 * numbers drifted from m10, mechanism unchanged): nothing between "commit an edge naming node X"
 * and "X stays removed by invariant" ever compares the two, so the edge commits, the demand
 * exists, and X can never be dispatched to answer it.
 *
 * Two mechanisms put X in `removedSet` before it is named, both closed by the same fix at the
 * same owner:
 * (a) a NEIGHBOR pruned X earlier via `prune_neighbors`, before anything declared it.
 * (b) X pruned ITSELF earlier, at its own ordinary dispatch, for a reason unrelated to the column
 * later named on it. Re-read against the live capture the scan cites
 * (`test-results/e2e/m10-head-azure-foundry/run-T7`): spImportOrders (hop 12, generation 19)
 * commits `upstream_columns: [{node: vwExternalOrders, col: Quantity}]` FIRST — vwExternalOrders
 * is already `ctDeclaredRouteIds` before its own dispatch, the normal CT order. Its own hop 13
 * then fails schema validation three times in a row (`invalid_tool_input`, host.log:199-208); the
 * breaker (`[Breaker] reason=semantic_failures providerCalls=3`) auto-abandons it through the same
 * `verdict:'prune'` commit path a model-authored prune uses (`[Self-Prune] hop=13`,
 * host.log:210) — engine-initiated, not an AI judgment call. saporders' hop 14 (generation 23)
 * then routes vwExternalOrders again; `routeCarryFor`'s own-provenance-wins normalization
 * (`smBase.ts`) restates the still-open `Quantity` demand from the hop-12 edge
 * (`[Normalize] route carry ... from=none to=[Quantity]`, host.log:220) and the enqueue silently
 * drops it (`[Disposition] enqueue skip ... already removed`, host.log:221) — the exact defect
 * this item names. Test `(b)` below reproduces the same removedSet outcome (a synthetic-prune and
 * a model-authored prune commit through the identical code path), which is what the fix guards.
 *
 * What is NOT a gap, confirmed by investigation and by two protected suites this fix must not
 * regress (`prune-sections-conflict.test.ts` `(d2)`, `ct-retention-differential.test.ts`
 * `C11`/`C12`): a node self-pruning at the SAME ordinary dispatch where it was already named as a
 * supplier (the routing/naming precedes its own dispatch, which is the normal CT hop order) is by
 * design, not a bug — `submitFindings` explicitly exempts `verdict:'prune'` from accounting for
 * active columns ("a self-pruned focus... is leaving the graph, not continuing through it"), and
 * the decision is recorded (`markNodeState`, `submitted_prune`, with its active columns attached),
 * not silently dropped. An earlier version of this fix added a `ctDeclaredRouteIds`-based refusal
 * to the focus's own `verdict:'prune'` path to close what looked like a symmetrical gap to
 * `declaredPruneIds` — reverted after it broke exactly those two protected suites: it blocked
 * ordinary, AI-judged pruning of any previously-routed node, which is not what this item describes
 * or what the codebase's own exemption comment permits. Test `(d)` below pins that non-regression
 * directly in this suite.
 *
 * Fix: `pruned_contributor`, a content-kind rejection in `ColumnTracer.validateColumnFlow` — same
 * envelope family as `absent_contributor` — fires at declare time whenever an `upstream_columns`
 * entry names a node already in `removedSet`, regardless of which mechanism removed it. Additive
 * only: the new parameter defaults to empty (every pre-existing direct call keeps validating
 * exactly as before) and the check runs inside the existing `if (this.tracer && finding.column_flow)`
 * gate, so BB is provably unaffected (test `(c)`).
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/**
 * origin --(upstream)--> { source (view, supplies Total), longGone (dead end) }.
 * `longGone` is a TABLE (non-bodied) — like `neverRouted` in the sibling declared-route-prune-guard
 * suite — so it is never agenda-preloaded and a plain `prune_neighbors` at hop1 admits it normally
 * (nothing has declared it yet). A non-bodied node is exactly as valid an `upstream_columns`
 * supplier as a bodied one (e.g. a procedure reading straight off a raw table).
 */
function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'source', schema: 'ct', name: 'source', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'longGone', schema: 'ct', name: 'longGone', type: 'table', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [
    ['source', 'origin'],
    ['longGone', 'origin'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

/**
 * origin --(upstream)--> { source (view, supplies Total), decoy (view, bodied, gets its own hop
 * and self-prunes for reasons unrelated to Total) }. `source` names `decoy` as its Total supplier
 * only AFTER decoy's own unrelated self-prune has already happened.
 */
function buildSelfPruneWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'source', schema: 'ct', name: 'source', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'decoy', schema: 'ct', name: 'decoy', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  // Agenda order follows graph edge-insertion order, not `route_requests` array order — decoy's
  // edge is listed first so it is dispatched (and self-prunes) before source names it.
  const edges: Array<[string, string]> = [
    ['decoy', 'origin'],
    ['source', 'origin'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

/** source is upstream of longGone instead, so longGone is reached as source's own supplier. */
function buildChainWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'source', schema: 'ct', name: 'source', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'longGone', schema: 'ct', name: 'longGone', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [
    ['source', 'origin'],
    ['longGone', 'source'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

describe('PRUNE-BEFORE-DEMAND', () => {
  it('(a) CT: a column_flow entry naming a node a NEIGHBOR already pruned is rejected, not silently dropped', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    engine.getHopContext();
    // longGone is pruned here, before anything has declared it — same shape as the sibling
    // suite's `neverRouted`, and correctly admitted.
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin reads Total from source' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'source', col: 'Total' }] }],
      route_requests: [{ nodeId: 'source', question: 'what supplies Total?' }],
      prune_neighbors: ['longGone'],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const afterHop1 = engine.toJSON();
    expect(afterHop1.removedSet.includes('longGone'), 'longGone is pruned normally — nothing declared it yet').toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'second focus is source').toBe(true);
    // source now names the already-removed longGone as its Total supplier.
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source reads Total from longGone' }],
      summary: 'source supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'longGone', col: 'Total' }] }],
    }) as { ok?: unknown; error?: string; hint?: string };

    expect('error' in hop2, `naming a pruned node as a supplier is rejected: ${JSON.stringify(hop2)}`).toBe(true);
    expect(hop2.error).toBe('pruned_contributor');
    expect(/already pruned|removed node stays removed/i.test(hop2.hint ?? ''), 'the hint names the pruned-supplier fact').toBe(true);

    const state = engine.toJSON();
    expect(state.removedSet.includes('longGone'), 'longGone stays removed — the rejection does not resurrect it').toBe(true);
    expect(state.agenda.some((e) => e.nodeId === 'longGone'), 'longGone is not reopened onto the agenda').toBe(false);
  });

  it('(b) CT: a column_flow entry naming a node that SELF-pruned earlier (unrelated to this column) is rejected the same way', () => {
    const { model, graph } = buildSelfPruneWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    engine.getHopContext();
    // origin routes decoy BEFORE source (agenda is FIFO), naming neither as a Total supplier yet
    // (column_flow terminates here) — decoy is reached as a plain, column-unrelated route.
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin joins decoy and reads Total from source' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      route_requests: [
        { nodeId: 'decoy', question: 'is this a join/filter source?', columns: 'none' },
        { nodeId: 'source', question: 'what supplies Total?', columns: ['Total'] },
      ],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    // decoy is dispatched first (FIFO) and self-prunes for reasons unrelated to Total — legitimate,
    // matches (d)'s non-regression: nothing has named decoy as a supplier yet.
    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'decoy', 'decoy is dispatched first').toBe(true);
    const decoyPrune = engine.submitFindings({
      focus_node_id: 'decoy',
      sections: [{ angle: 'business' as const, text: 'decoy is a dead-end filter, contributes nothing' }],
      summary: 'decoy prunes itself',
      verdict: 'prune',
    }) as { ok?: unknown; error?: string };
    expect('ok' in decoyPrune, `decoy self-prunes cleanly: ${JSON.stringify(decoyPrune)}`).toBe(true);
    expect(engine.toJSON().removedSet.includes('decoy'), 'decoy is self-pruned before source names it').toBe(true);

    const focus3 = engine.getHopContext();
    expect('focus_node' in focus3 && focus3.focus_node?.id === 'source', 'source is dispatched next').toBe(true);

    // source now names the already-self-pruned decoy as its Total supplier.
    const hop = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source reads Total from decoy' }],
      summary: 'source supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'decoy', col: 'Total' }] }],
    }) as { ok?: unknown; error?: string; hint?: string };

    expect('error' in hop, `naming a self-pruned node as a supplier is rejected: ${JSON.stringify(hop)}`).toBe(true);
    expect(hop.error).toBe('pruned_contributor');
    expect(/already pruned|removed node stays removed/i.test(hop.hint ?? ''), 'the hint names the pruned-supplier fact').toBe(true);
  });

  it('(c) BB parity: BB has no column_flow, so the pruned-contributor check never runs — an equivalent prune-then-route sequence commits exactly as before', () => {
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
      sections: [{ angle: 'business' as const, text: 'origin routes source' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'source', question: 'route it' }],
      prune_neighbors: ['longGone'],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `BB hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);
    expect(engine.toJSON().removedSet.includes('longGone'), 'BB behavior is unchanged: longGone is pruned').toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'BB second focus is source').toBe(true);
    // BB carries no column_flow field at all — nothing can name longGone as a "supplier".
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source' }],
      summary: 'source',
      verdict: 'analyze',
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop2, `BB: no column aspect, no pruned-contributor check, commits as before: ${JSON.stringify(hop2)}`).toBe(true);
    // Only the column_flow half of the declaration is CT-only; `source` was routed, and an
    // accepted route declares its target in both modes.
    expect(engine.toJSON().ctDeclaredRouteIds, 'the route declaration is mode-independent').toEqual(['source']);
  });

  it('(d) non-regression: a node already declared as a supplier may still prune ITSELF at its own ordinary dispatch — refutes a self-prune refusal as the fix', () => {
    const { model, graph } = buildChainWorld();
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
      sections: [{ angle: 'business' as const, text: 'origin reads Total from source' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'source', col: 'Total' }] }],
      route_requests: [{ nodeId: 'source', question: 'what supplies Total?' }],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'second focus is source').toBe(true);
    // source declares longGone as its Total supplier — longGone is now committed (ctDeclaredRouteIds).
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source reads Total from longGone' }],
      summary: 'source supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'longGone', col: 'Total' }] }],
      route_requests: [{ nodeId: 'longGone', question: 'what supplies Total?' }],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop2, `hop2 commits: ${JSON.stringify(hop2)}`).toBe(true);
    expect(engine.toJSON().ctDeclaredRouteIds?.includes('longGone'), 'longGone is a declared supplier').toBe(true);

    const focus3 = engine.getHopContext();
    expect('focus_node' in focus3 && focus3.focus_node?.id === 'longGone', 'third focus is longGone').toBe(true);
    // longGone's OWN, ordinary (first) dispatch prunes itself, having just been declared — this is
    // legitimate CT pruning (verdict:'prune' is exempt from column accounting) and MUST commit.
    const hop3 = engine.submitFindings({
      focus_node_id: 'longGone',
      sections: [{ angle: 'business' as const, text: 'longGone contributes nothing after all' }],
      summary: 'longGone prunes itself',
      verdict: 'prune',
    }) as { ok?: unknown; error?: string };

    expect('ok' in hop3, `a declared node self-prunes at its own ordinary dispatch: ${JSON.stringify(hop3)}`).toBe(true);
    expect(engine.toJSON().removedSet.includes('longGone'), 'the self-prune commits — the decision is recorded, not silently lost').toBe(true);
  });
});
