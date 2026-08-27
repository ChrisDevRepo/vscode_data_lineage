import { describe, it, expect } from 'vitest';
import { buildColumnTraceView, type ColumnTraceRelation, type ColumnTraceViewObject } from '../../../src/engine/columnTraceView';

describe('ai preview rendering', () => {
  const objects = new Map<string, ColumnTraceViewObject>([
    ['[ai].[vwpricelist]', { id: '[ai].[vwPriceList]', label: 'vwPriceList', schema: 'ai', objectType: 'view' }],
    ['[ai].[vwconsolidatedsales]', { id: '[ai].[vwConsolidatedSales]', label: 'vwConsolidatedSales', schema: 'ai', objectType: 'view' }],
    ['[ai].[factsalesreport]', { id: '[ai].[FactSalesReport]', label: 'FactSalesReport', schema: 'ai', objectType: 'table' }],
  ]);

  const relations: ColumnTraceRelation[] = [
    { hopNode: '[ai].[FactSalesReport]', fromNode: '[ai].[vwPriceList]', fromCol: 'UnitPrice', toNode: '[ai].[FactSalesReport]', toCol: 'TotalRevenue' },
    { hopNode: '[ai].[FactSalesReport]', fromNode: '[ai].[vwConsolidatedSales]', fromCol: 'Qty', toNode: '[ai].[FactSalesReport]', toCol: 'TotalRevenue' },
    { hopNode: '[ai].[FactSalesReport]', fromNode: '[ai].[vwPriceList]', fromCol: 'UnitPrice', toNode: '[ai].[FactSalesReport]', toCol: 'TotalRevenue' },
  ];

  it('a repeated relation does not repeat the row it lands on', () => {
    const view = buildColumnTraceView({ relations, objects });
    const target = view.nodes.find(n => n.id === '[ai].[FactSalesReport]');
    expect(target?.rows.map(r => r.name)).toEqual(['TotalRevenue']);
  });

  it('a repeated relation does not draw a second edge', () => {
    const view = buildColumnTraceView({ relations, objects });
    expect(view.edges.length).toBe(2);
    expect(new Set(view.edges.map(e => e.id)).size).toBe(2);
  });

  it('two distinct upstream columns feeding one output read as a fan-in of two', () => {
    const view = buildColumnTraceView({ relations, objects });
    const row = view.nodes.find(n => n.id === '[ai].[FactSalesReport]')?.rows[0];
    expect(row?.shape).toBe('fan-in');
    expect(row?.contributors).toBe(2);
  });
});
