/**
 * Downstream CT hop where the focus derives/renames its tracked column at the next node —
 * `[ai].[SalesStaging].OrderAmount` feeds `[ai].[vwDiscountCalc].Discount`, a view with no
 * OrderAmount column of its own (m58-smoke-downstream live evidence,
 * test-results/e2e/m58-smoke-downstream/2026-09-21T18-29-25-098Z-azure-foundry/run-1/host.log
 * lines 70-95). The tracer was upstream-shaped: `out_col` had to already be an active column
 * (`untracked_out_col`), and completeness only accounted for `out_col` (`column_chain_incomplete`
 * on `upstream_columns: []`) — no valid `column_flow` shape existed for a downstream
 * rename/derivation, and the model had no move.
 *
 * Downstream orientation (`columnTracer.ts` `validateColumnFlow`/`unaccountedActiveColumns`):
 * the active/tracked column lives on the PREVIOUS node and is named inside `upstream_columns`;
 * `out_col` is the focus's own (possibly renamed/derived) column, which becomes the next active
 * column for whatever dispatches downstream of the focus.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('CT downstream trace crosses a derived/renamed column', () => {
  const salesStaging: LineageNode = makeNode({
    id: 'salesstaging', schema: 'ai', name: 'SalesStaging', type: 'view',
    columns: [{ name: 'OrderAmount', type: 'money', nullable: 'NOT NULL', extra: '' }],
  });
  const vwDiscountCalc: LineageNode = makeNode({
    id: 'vwdiscountcalc', schema: 'ai', name: 'vwDiscountCalc', type: 'view',
    // No OrderAmount column — the view only exposes its derived result.
    columns: [{ name: 'Discount', type: 'money', nullable: 'NULL', extra: '' }],
  });
  const vwConsumer: LineageNode = makeNode({
    id: 'vwconsumer', schema: 'ai', name: 'vwConsumer', type: 'view',
    columns: [{ name: 'Discount', type: 'money', nullable: 'NULL', extra: '' }],
  });
  const nodes = [salesStaging, vwDiscountCalc, vwConsumer];
  const edges: Array<[string, string]> = [['salesstaging', 'vwdiscountcalc'], ['vwdiscountcalc', 'vwconsumer']];
  const model = makeModel(nodes, edges, ['ai']);
  const graph = makeGraph(nodes, edges);

  /** Drives the CT walk to the vwDiscountCalc hop, the origin's OrderAmount already committed. */
  function driveToFocus(): NavigationEngine {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: 'salesstaging',
      question: 'Trace the OrderAmount column of SalesStaging downstream',
      direction: 'downstream',
      analysisMode: 'ct',
      targetColumns: ['OrderAmount'],
    });
    engine.getHopContext();
    const origin = engine.submitFindings({
      focus_node_id: 'salesstaging',
      sections: [{ angle: 'business' as const, text: 'OrderAmount is a stored column' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{ out_col: 'OrderAmount', upstream_columns: [] }],
      route_requests: [{ nodeId: 'vwdiscountcalc', question: 'follow OrderAmount downstream', columns: ['OrderAmount'] }],
    });
    expect('error' in origin ? origin : null, `origin hop is accepted (${'error' in origin ? origin.error : ''})`).toBeNull();
    const hop = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    expect(!hop.done && hop.focus_node?.id, 'vwDiscountCalc dispatches next').toBe('vwdiscountcalc');
    expect(engine.columnAspect?.active_columns, 'active column at vwDiscountCalc is still the source-side name').toEqual(['OrderAmount']);
    return engine;
  }

  it('a downstream derivation is accepted, staged prev.tracked -> focus.derived, completeness passes, and the next consumer receives the derived column as active', () => {
    const engine = driveToFocus();
    const result = engine.submitFindings({
      focus_node_id: 'vwdiscountcalc',
      sections: [{ angle: 'business' as const, text: 'Discount = BaseAmt * DiscountPct, BaseAmt = OrderAmount' }],
      summary: 'Discount derives from OrderAmount',
      verdict: 'analyze',
      column_flow: [{
        out_col: 'Discount',
        upstream_columns: [{ node: 'salesstaging', col: 'OrderAmount', transforms: ['pass_through', 'compute'] }],
      }],
      route_requests: [{ nodeId: 'vwconsumer', question: 'follow Discount downstream', columns: ['Discount'] }],
    });
    expect('error' in result ? result : null, `downstream derivation is accepted (${'error' in result ? result.error : ''})`).toBeNull();

    const edges = engine.columnAspect?.edges ?? [];
    const staged = edges.find(e => e.hop_node === 'vwdiscountcalc');
    expect(!!staged, 'the derivation edge is staged').toBe(true);
    expect(staged?.from_node, 'edge from_node is the tracked previous node').toBe('salesstaging');
    expect(staged?.from_col, 'edge from_col is the tracked previous column').toBe('OrderAmount');
    expect(staged?.to_node, 'edge to_node defaults to the focus').toBe('vwdiscountcalc');
    expect(staged?.to_col, 'edge to_col is the derived column').toBe('Discount');

    const next = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    expect(!next.done && next.focus_node?.id, 'the downstream consumer dispatches next').toBe('vwconsumer');
    expect(engine.columnAspect?.active_columns, 'the downstream consumer receives the derived column as active').toEqual(['Discount']);
  });

  it('out_col alone (no upstream_columns ref) still leaves the tracked column unaccounted downstream — the model must name it', () => {
    const engine = driveToFocus();
    const result = engine.submitFindings({
      focus_node_id: 'vwdiscountcalc',
      sections: [{ angle: 'business' as const, text: 'no reference to OrderAmount' }],
      summary: 'incomplete',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Discount', upstream_columns: [] }],
    });
    expect('error' in result && result.error, 'a downstream entry that never names the tracked column is still column_chain_incomplete').toBe('column_chain_incomplete');
  });

  it('constraint parity: a non-terminal downstream entry whose upstream_columns never names an active column is rejected, not silently accepted', () => {
    const engine = driveToFocus();
    const result = engine.submitFindings({
      focus_node_id: 'vwdiscountcalc',
      sections: [{ angle: 'business' as const, text: 'Discount comes from a filter column, not the tracked one' }],
      summary: 'wrong contributor',
      verdict: 'analyze',
      column_flow: [{
        out_col: 'Discount',
        upstream_columns: [{ node: 'salesstaging', col: 'SomeUntrackedColumn' }],
      }],
    });
    expect('error' in result && result.error, 'downstream out_col parity: no ref names an active column → rejected, same code family as the upstream out_col-not-tracked case').toBe('out_col_not_tracked');
    if ('error' in result) {
      const detail = JSON.stringify('detail' in result ? result.detail : '');
      expect(detail.includes('OrderAmount'), 'the rejection lists the active columns the entry needed to name').toBe(true);
    }
  });
});

describe('ColumnTracer.determineActiveColumnsForCandidate — downstream spine follows to_col/to_node', () => {
  it('downstream direction recovers the WRITTEN column at its writes_to target; upstream direction is untouched', () => {
    const tracer = new ColumnTracer(['OrderAmount']);
    // The exact edge shape validateColumnFlow stages for a writer that redirects onto a different
    // downstream node via writes_to.
    tracer.edges.push({
      hop: 1, hop_node: 'vwdiscountcalc', from_node: 'salesstaging', from_col: 'OrderAmount',
      to_node: 'facttable', to_col: 'DiscountAmt',
    });

    const downstreamSpine = tracer.determineActiveColumnsForCandidate('facttable', [], new Set(), undefined, 'downstream');
    expect(downstreamSpine, 'downstream: the write TARGET recovers the written column (to_col)').toEqual(['DiscountAmt']);

    const upstreamOnWriteTarget = tracer.determineActiveColumnsForCandidate('facttable', ['fallback'], new Set(), undefined, 'upstream');
    expect(upstreamOnWriteTarget, 'upstream (default): the write target is never keyed by from_node, so entryColumns falls through unchanged').toEqual(['fallback']);

    const upstreamOnSupplier = tracer.determineActiveColumnsForCandidate('salesstaging', [], new Set(), undefined, 'upstream');
    expect(upstreamOnSupplier, 'upstream: still keys off from_node/from_col, byte-identical to today').toEqual(['OrderAmount']);

    const upstreamOnSupplierDefaultParam = tracer.determineActiveColumnsForCandidate('salesstaging', [], undefined, undefined, 'upstream');
    expect(upstreamOnSupplierDefaultParam, 'omitting traceDirection keeps the pre-existing upstream default').toEqual(['OrderAmount']);
  });
});
