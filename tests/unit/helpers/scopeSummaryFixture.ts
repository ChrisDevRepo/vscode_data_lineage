/** A proposed scope with every card line populated, for approval-card tests. */
import type { ScopeSummary } from '../../../src/ai/sm/smTypes';

/** Builds the sample scope, with `overrides` replacing whole fields. */
export function sampleSummary(overrides: Partial<ScopeSummary> = {}): ScopeSummary {
  const leaf = (names: string[]) => ({ hops: names.length, scope: names.length, nodeNames: names, omitted: 0 });
  return {
    hopCount: 9,
    scopeCount: 14,
    origin: '[dbo].[Orders]',
    originLabel: 'dbo.Orders',
    missionBrief: 'Explain how order totals are derived.',
    depth: 3,
    depthIntent: { upstream: { levels: 3, exactness: 'exact' }, downstream: { levels: 2, exactness: 'approximate' } },
    direction: 'bidirectional',
    analysisMode: 'ct',
    columnAspectActive: true,
    targetColumns: ['Total', 'Tax', 'Discount', 'Freight', 'Currency'],
    estimatedDdlChars: 4000,
    estimatedDdlTokens: 1000,
    bySchema: {
      dbo: { hops: 4, scope: 6, byType: { procedure: leaf(['LoadOrders', 'PriceOrders']) } },
      stg: { hops: 3, scope: 4, byType: { view: leaf(['vOrders']) } },
      mart: { hops: 1, scope: 2, byType: { table: leaf(['FactOrders']) } },
      audit: { hops: 1, scope: 2, byType: { table: leaf(['OrderLog']) } },
    },
    activeFilters: { schemas: ['tmp', 'bak'], types: ['external'], nodeIds: ['[x].[a]', '[x].[b]', '[x].[c]', '[x].[d]'], passNodeIds: [] },
    scopeNotes: ['ignore test data'],
    ...overrides,
  };
}
