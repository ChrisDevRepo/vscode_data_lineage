import { describe, it, expect } from 'vitest';
import { buildTableTraceColumns, groupCtFlowsByNeighbor, type CtTooltipFlow } from '../../../src/components/CustomNode';

describe('ai preview rendering', () => {
  const flows: CtTooltipFlow[] = [
    { neighborNode: '[ai].[vwPriceList]', direction: 'in', fromCol: 'UnitPrice', toCol: 'TotalRevenue' },
    { neighborNode: '[ai].[vwConsolidatedSales]', direction: 'in', fromCol: 'Qty', toCol: 'TotalRevenue' },
    { neighborNode: '[ai].[vwPriceList]', direction: 'in', fromCol: 'UnitPrice', toCol: 'TotalRevenue' }, // duplicate
  ];

  it('table tooltip columns are unique and sorted without arrow semantics', () => {
    expect(buildTableTraceColumns(flows)).toEqual(['Qty', 'TotalRevenue', 'UnitPrice']);
  });

  it('flows are grouped by neighbor and deduplicated within a group', () => {
    const grouped = groupCtFlowsByNeighbor(flows);
    expect(grouped.length).toBe(2);
    expect(grouped[0]?.neighborNode).toBe('[ai].[vwConsolidatedSales]');
    expect(grouped[1]?.neighborNode).toBe('[ai].[vwPriceList]');
    expect(grouped[1]?.rows.length).toBe(1);
  });
});
