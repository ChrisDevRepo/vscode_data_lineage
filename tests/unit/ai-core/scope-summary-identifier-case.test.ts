/** Approval summaries preserve checked CS identities while retaining CI name normalization. */
import { describe, expect, it } from 'vitest';
import { renderFullPlanMd, renderScopeCardMd, renderScopeSummaryMd, schemaFiltersRemovedByOrigin, nodeFiltersRemovedByOrigin } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { sampleSummary } from '../helpers/scopeSummaryFixture';
import type { NavigationInitParams } from '../../../src/ai/sm/smTypes';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { quoteIdentifier } from '../../../src/utils/sql';

/** A GUI filter that excludes nothing; a test adds only the keys it exercises. */
const NO_FILTER = { schemas: [], types: [], hideIsolated: false, focusSchemas: [], showExternalRefs: false, externalRefTypes: [] };
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
    expect(summary.selectedSchemas).toEqual(['Sa]les']);
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

  it.each([false, true])('preserves effective filters without editorial removal rows (CS=%s)', cs => {
    const summary = sampleSummary({
      identifierCaseSensitive: cs,
      origin: cs ? '[Sales].[Orders]' : '[sales].[orders]',
      activeFilters: { schemas: ['sales'], types: [], nodeIds: [], passNodeIds: [] },
    });
    const md = renderScopeCardMd({
      summary, revision: 1, classification: 'technical',
      init: { ...init, excludeSchemas: ['Sales'], excludeNodeIds: ['sales.orders'] },
    });
    expect(md).not.toMatch(/Filter removed|\(asked:/);
    expect(md).toContain('**Schemas:** All except `sales`');
    expect(md).not.toContain('**Excluded:**');
    expect(schemaFiltersRemovedByOrigin(['Sales'], summary.activeFilters.schemas, cs)).toEqual(cs ? ['Sales'] : []);
    expect(nodeFiltersRemovedByOrigin(['sales.orders'], summary.origin, summary.activeFilters.nodeIds, cs)).toEqual(cs ? [] : ['sales.orders']);
  });

  it.each([false, true])('show full plan states effective filters without editorial removal rows (CS=%s)', cs => {
    const md = renderFullPlanMd(removedFilterProposal(cs));
    expect(md.startsWith('### Exploration plan')).toBe(true);
    expect(md).not.toMatch(/Filter removed|\(asked:/);
    expect(md).toContain('- Schemas: All except `sales`');
  });

  it('show full plan keeps an omitted case policy case-insensitive', () => {
    const summary = sampleSummary({
      origin: '[sales].[orders]',
      activeFilters: { schemas: ['sales'], types: [], nodeIds: [], passNodeIds: [] },
    });
    const md = renderFullPlanMd({
      summary, revision: 1, classification: 'technical',
      init: { ...init, excludeSchemas: ['Sales'], excludeNodeIds: ['sales.orders'] },
    });
    expect(md).not.toMatch(/Filter removed|\(asked:/);
    expect(schemaFiltersRemovedByOrigin(['Sales'], summary.activeFilters.schemas, undefined)).toEqual([]);
    expect(nodeFiltersRemovedByOrigin(['sales.orders'], summary.origin, summary.activeFilters.nodeIds, undefined)).toEqual(['sales.orders']);
  });

  it('puts a discovery summary ahead of the plan only', () => {
    const proposal = { ...removedFilterProposal(true), discoverySummary: 'Orders feed the mart.' };
    const md = renderFullPlanMd(proposal);
    expect(md.startsWith('Orders feed the mart.\n\n### Exploration plan')).toBe(true);
    expect(renderScopeCardMd(proposal).includes('Orders feed the mart.')).toBe(false);
  });

  it('renders card object names verbatim inside code spans, without Markdown escapes', () => {
    const summary = sampleSummary({
      bySchema: { Finance: { hops: 3, scope: 3, byType: { procedure: leaf(['usp_Load_Order_Lines', 'a*b[c]', 'odd`name']) } } },
    });
    const md = renderScopeCardMd({ summary, revision: 1, classification: 'technical', init });
    expect(md).toContain('`usp_Load_Order_Lines`');
    expect(md).toContain('`a*b[c]`');
    expect(md).toContain('`` odd`name ``');
    expect(md).not.toContain('\\');
  });
});

describe('approval card and full plan exclusions', () => {
  const procedures = Array.from({ length: 22 }, (_, i) => ({ schema: 'etl', name: `uspGet${String(i).padStart(2, '0')}` }));
  const ruleIds = [...procedures.map(p => `[etl].[${p.name}]`), '[stg].[vSalesPerson_Archive]'];
  const summary = sampleSummary({
    bySchema: {
      dbo: { hops: 22, scope: 22, byType: { procedure: leaf(Array.from({ length: 22 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`)) } },
      mart: { hops: 0, scope: 2, byType: { table: leaf(['FactOrders', 'DimDate']) } },
    },
    activeFilters: { schemas: ['tmp', 'bak', 'old'], types: [], nodeIds: [...ruleIds, '[mart].[ProductModelOld]'], passNodeIds: [] },
    exclusions: {
      rules: [
        { pattern: '%uspGet%', count: 22, byType: { procedure: procedures } },
        { pattern: '%_Archive', count: 1, byType: { view: [{ schema: 'stg', name: 'vSalesPerson_Archive' }] } },
      ],
      named: { count: 1, byType: { table: [{ schema: 'mart', name: 'ProductModelOld' }] } },
    },
  });
  const proposal = { summary, revision: 1, classification: 'technical' as const, init };

  it('states exclusions on the card as counts and excluded types, never an excluded object name', () => {
    const md = renderScopeCardMd({ ...proposal, summary: { ...summary, activeFilters: { ...summary.activeFilters, types: ['function'] } } });
    expect(md).toContain('- **Excluded:** 2 filter rules; types `function`; 1 object by name');
    expect(md).not.toContain('uspGet');
    expect(md).not.toContain('ProductModelOld');
    expect(md).not.toContain('`tmp`');
  });

  it('states the schema selection from its shorter side', () => {
    expect(renderScopeCardMd(proposal)).toContain('- **Schemas:** `dbo`, `mart`');
    expect(renderFullPlanMd(proposal)).toContain('- Schemas: `dbo`, `mart`');
    const mostlySelected = { ...proposal, summary: { ...summary, selectedSchemas: ['dbo', 'etl', 'mart', 'stg'], activeFilters: { ...summary.activeFilters, schemas: ['log'] } } };
    expect(renderScopeCardMd(mostlySelected)).toContain('- **Schemas:** All except `log`');
    expect(renderFullPlanMd(mostlySelected)).toContain('- Schemas: All except `log`');
  });

  it('states the word All when no schema is excluded', () => {
    const all = { ...proposal, summary: { ...summary, selectedSchemas: ['dbo', 'mart'], activeFilters: { ...summary.activeFilters, schemas: [] } } };
    expect(renderScopeCardMd(all)).toContain('- **Schemas:** All\n');
    expect(renderFullPlanMd(all)).toContain('- Schemas: All\n');
  });

  it('states a schema list past ten names as a count on the card and in full in the plan', () => {
    const selectedSchemas = Array.from({ length: 11 }, (_, i) => `s${String(i).padStart(2, '0')}`);
    const excluded = Array.from({ length: 12 }, (_, i) => `x${String(i).padStart(2, '0')}`);
    const many = { ...proposal, summary: { ...summary, selectedSchemas, activeFilters: { ...summary.activeFilters, schemas: excluded } } };
    const card = renderScopeCardMd(many);
    expect(card).toContain('- **Schemas:** 11 of 23 selected');
    expect(card).not.toContain('`s00`');
    expect(renderFullPlanMd(many)).toContain(`- Schemas: ${selectedSchemas.map(schema => `\`${schema}\``).join(', ')}`);
  });

  it('caps object names per type at ten on the card and twenty in the plan, and lists only types in scope', () => {
    const md = renderScopeCardMd(proposal);
    expect(md).toContain('  - Procedures (22): `p01`, `p02`, `p03`, `p04`, `p05`, `p06`, `p07`, `p08`, `p09`, `p10` _+12 more_');
    expect(md).toContain('  - Tables (2): `FactOrders`, `DimDate`');
    expect(md).not.toMatch(/Views|Functions/);
    const plan = renderFullPlanMd(proposal);
    expect(plan).toContain('  - Procedures (22 nodes): p01, p02, p03, p04, p05, p06, p07, p08, p09, p10, p11,');
    expect(plan).toContain('p19, p20 _(+2 more)_');
    expect(renderScopeSummaryMd(summary)).toContain('p20, p21, p22');
  });

  it('names excluded objects in the full plan, grouped by rule then type, capped per type', () => {
    const md = renderFullPlanMd(proposal);
    expect(md).toContain('- Excluded by rule `%uspGet%` — 22 objects');
    expect(md).toContain('  - Procedures (22): `uspGet00`');
    expect(md).toContain('`uspGet19` _+2 more_');
    expect(md).not.toContain('uspGet20');
    expect(md).toContain('- Excluded by rule `%_Archive` — 1 object\n  - View (1): `vSalesPerson_Archive`');
    expect(md).toContain('- Excluded by name — 1 object\n  - Table (1): `ProductModelOld`');
  });

  it('keeps every excluded id in the model-facing summary', () => {
    const md = renderScopeSummaryMd(summary);
    for (const id of summary.activeFilters.nodeIds) expect(md).toContain(`\`${id}\``);
    expect(md).toContain('- Schemas excluded: `tmp`, `bak`, `old`');
  });

  it('attributes each excluded object to the first matching rule, or to named', () => {
    const qualified = (name: string) => `[etl].[${name}]`;
    const objects = ['Main', 'uspGet_Archive', 'uspGetBillOfMaterials', 'Legacy'].map(name => ({ fullName: qualified(name), type: 'view' as const }));
    const model = buildModel(objects, [{ sourceName: qualified('Main'), targetName: qualified('Legacy') }], objects, undefined, true, undefined, false);
    const engine = new NavigationEngine(model, buildGraphologyGraph(model), () => {}, {
      activeFilter: { ...NO_FILTER, exclusionPatterns: ['%uspGet%', '%_Archive', '%nomatch%'] },
    });
    expect(engine.init({
      ...init, origin: qualified('Main'), direction: 'upstream', analysisMode: 'bb',
      excludeNodeIds: [...engine.getGuiExcludedNodeIds(), qualified('Legacy')],
    })).toMatchObject({ ok: true });
    const { exclusions } = engine.getScopeSummary();
    expect(exclusions?.rules.map(rule => [rule.pattern, rule.count])).toEqual([['%uspGet%', 2]]);
    expect(exclusions?.rules[0].byType.view.map(object => object.name)).toEqual(['uspGet_Archive', 'uspGetBillOfMaterials']);
    expect(exclusions?.named).toEqual({ count: 1, byType: { view: [{ schema: 'etl', name: 'Legacy' }] } });
  });

  it('counts under a rule only the objects the schema and type filters leave selected', () => {
    const objects = [
      { fullName: '[etl].[Main]', type: 'view' as const },
      { fullName: '[etl].[uspGetOrders]', type: 'view' as const },
      { fullName: '[bak].[uspGetOrders]', type: 'view' as const },
      { fullName: '[etl].[uspGetTotals]', type: 'function' as const },
    ];
    const model = buildModel(objects, [], objects, undefined, true, undefined, false);
    const engine = new NavigationEngine(model, buildGraphologyGraph(model), () => {}, {
      activeFilter: { ...NO_FILTER, exclusionPatterns: ['%uspGet%'] },
    });
    expect(engine.init({
      ...init, origin: '[etl].[Main]', direction: 'upstream', analysisMode: 'bb',
      excludeNodeIds: engine.getGuiExcludedNodeIds(), excludeSchemas: ['bak'], excludeTypes: ['function'],
    })).toMatchObject({ ok: true });
    const { exclusions } = engine.getScopeSummary();
    expect(exclusions?.rules).toEqual([{ pattern: '%uspGet%', count: 1, byType: { view: [{ schema: 'etl', name: 'uspGetOrders' }] } }]);
  });
});

/** The locked card fixture: schema `Sales` against active `sales`, object `sales.orders` against the origin. */
function removedFilterProposal(cs: boolean) {
  return {
    summary: sampleSummary({
      identifierCaseSensitive: cs,
      origin: cs ? '[Sales].[Orders]' : '[sales].[orders]',
      activeFilters: { schemas: ['sales'], types: [], nodeIds: [], passNodeIds: [] },
    }),
    revision: 1 as const,
    classification: 'technical' as const,
    init: { ...init, excludeSchemas: ['Sales'], excludeNodeIds: ['sales.orders'] },
  };
}
