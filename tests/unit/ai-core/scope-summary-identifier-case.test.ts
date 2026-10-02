/** Approval summaries preserve checked CS identities while retaining CI name normalization. */
import { describe, expect, it } from 'vitest';
import { renderScopeCardMd, renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { sampleSummary } from '../helpers/scopeSummaryFixture';
import type { NavigationInitParams } from '../../../src/ai/sm/smTypes';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { quoteIdentifier } from '../../../src/utils/sql';

const leaf = (nodeNames: string[]) => ({ hops: nodeNames.length, scope: nodeNames.length, nodeNames, omitted: 0 });
const init: NavigationInitParams = {
  question: 'Explain order lineage', origin: '[Sales].[Orders]',
  depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
};

describe('scope summary identifier comparison', () => {
  it.each([false, true])('marks only matching object identities as pass (CS=%s)', cs => {
    const summary = sampleSummary({
      identifierCaseSensitive: cs,
      bySchema: { Sales: { hops: 2, scope: 2, byType: { view: leaf(['Orders', 'orders']) } } },
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [cs ? '[Sales].[Orders]' : '[sales].[orders]'] },
    });
    const md = renderScopeSummaryMd(summary);
    expect(md).toContain('Orders _(pass)_');
    expect(md.includes('orders _(pass)_')).toBe(!cs);
  });

  it('round-trips pass identities containing escaped delimiters and dots', () => {
    const summary = sampleSummary({
      identifierCaseSensitive: true,
      bySchema: { 'Sa]les': { hops: 1, scope: 1, byType: { view: leaf(['Order.Items']) } } },
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [normalizeName(`${quoteIdentifier('Sa]les')}.${quoteIdentifier('Order.Items')}`, true)] },
    });
    expect(renderScopeSummaryMd(summary)).toContain('Order.Items _(pass)_');
  });

  it.each([false, true])('quotes metadata names through the engine summary producer (CS=%s)', cs => {
    const qualified = (name: string) => `${quoteIdentifier('Sa]les')}.${quoteIdentifier(name)}`;
    const objects = ['Main', 'Order.Items', 'Excluded'].map(name => ({ fullName: qualified(name), type: 'view' as const }));
    const model = buildModel(objects, [{ sourceName: qualified('Main'), targetName: qualified('Order.Items') }], objects, undefined, true, undefined, cs);
    const engine = new NavigationEngine(model, buildGraphologyGraph(model), () => {}, {});
    expect(engine.init({ ...init, origin: qualified('Main'), direction: 'upstream', analysisMode: 'bb', passNodeIds: [qualified('Order.Items')], excludeNodeIds: [qualified('Excluded')] })).toMatchObject({ ok: true });
    const summary = engine.getScopeSummary();
    expect(summary.activeFilters.passNodeIds).toEqual([qualified('Order.Items')]);
    expect(summary.activeFilters.nodeIds).toEqual([qualified('Excluded')]);
    expect(renderScopeSummaryMd(summary)).toContain('Order.Items _(pass)_');
  });

  it.each([false, true])('qualifies ambiguous names with the same source policy (CS=%s)', cs => {
    const summary = sampleSummary({
      identifierCaseSensitive: cs,
      bySchema: {
        Sales: { hops: 2, scope: 2, byType: { view: leaf(['Orders', 'orders']) } },
        Archive: { hops: 1, scope: 1, byType: { view: leaf(['Orders']) } },
      },
      ambiguousObjectNames: { view: [cs ? 'Orders' : 'orders'] },
    });
    const md = renderScopeCardMd({ summary, revision: 1, classification: 'technical', init });
    expect(md).toContain('`Sales.Orders`');
    expect(md).toContain('`Archive.Orders`');
    expect(md.includes('`Sales.orders`')).toBe(!cs);
    if (cs) expect(md).toContain('`orders`');
  });

  it.each([false, true])('reports only actually removed schema and object filters (CS=%s)', cs => {
    const summary = sampleSummary({
      identifierCaseSensitive: cs,
      origin: cs ? '[Sales].[Orders]' : '[sales].[orders]',
      activeFilters: { schemas: ['sales'], types: [], nodeIds: [], passNodeIds: [] },
    });
    const md = renderScopeCardMd({
      summary, revision: 1, classification: 'technical',
      init: { ...init, excludeSchemas: ['Sales'], excludeNodeIds: ['sales.orders'] },
    });
    expect(md.includes('Filter removed:** schema `Sales`')).toBe(cs);
    expect(md.includes('Filter removed:** object `sales.orders`')).toBe(!cs);
  });
});
