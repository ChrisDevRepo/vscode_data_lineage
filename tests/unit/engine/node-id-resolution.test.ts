/**
 * Canonical node resolution preserves full CI normalization and exact CS catalog identity,
 * including quoted identifiers and model-supplied Unicode padding.
 */
import { describe, expect, it } from 'vitest';
import { resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';

describe.each([false, true])('resolveModelNodeId with identifierCaseSensitive=%s', (caseSensitive) => {
  const canonical = caseSensitive ? '[Sales].[Order.Detail]' : '[sales].[order.detail]';
  const catalog = new Map<string, unknown>([[canonical, {}]]);

  it.each([
    '[Sales].[Order.Detail]',
    '"Sales"."Order.Detail"',
    '\t[Sales].[Order.Detail]\r\n',
    '\ufeff[Sales].[Order.Detail]\u200b\u200e',
  ])('resolves %s without changing catalog identity', (raw) => {
    expect(resolveModelNodeId(raw, catalog, caseSensitive)).toBe(canonical);
  });

  it.each(['[sales].[Order.Detail]', '[Sales].[order.detail]', '"SALES"."ORDER.DETAIL"'])
    ('applies the source policy to schema and object casing in %s', (raw) => {
      expect(resolveModelNodeId(raw, catalog, caseSensitive)).toBe(caseSensitive ? null : canonical);
    });

  it('resolves an unquoted mixed-case name under the source policy', () => {
    const id = caseSensitive ? '[Sales].[OrderDetails]' : '[sales].[orderdetails]';
    const simpleCatalog = new Map<string, unknown>([[id, {}]]);
    expect(resolveModelNodeId('Sales.OrderDetails', simpleCatalog, caseSensitive)).toBe(id);
    expect(resolveModelNodeId('sALES.oRDERdETAILS', simpleCatalog, caseSensitive)).toBe(caseSensitive ? null : id);
    expect(resolveModelNodeId('  [sALES].[oRDERdETAILS]  ', simpleCatalog, caseSensitive)).toBe(caseSensitive ? null : id);
  });

  it.each(['', ' \t\r\n', '\u200b\ufeff', '.', '[]', '[Sales.Order.Detail', '[Sales].[Missing]', 'Order.Detail'])
    ('returns null for empty, malformed or absent catalog name %s', (raw) => {
      expect(resolveModelNodeId(raw, catalog, caseSensitive)).toBeNull();
    });

  it('handles legacy nullish runtime input as an empty name', () => {
    expect(resolveModelNodeId(null as unknown as string, catalog, caseSensitive)).toBeNull();
    expect(resolveModelNodeId(undefined as unknown as string, catalog, caseSensitive)).toBeNull();
  });
});

describe('case-sensitive case twins', () => {
  const catalog = new Map<string, unknown>([
    ['[Sales].[Orders]', {}],
    ['[Sales].[orders]', {}],
    ['[sales].[Orders]', {}],
  ]);

  it.each([...catalog.keys()])('retains the exact twin %s', (id) => {
    expect(resolveModelNodeId(id, catalog, true)).toBe(id);
    expect(resolveModelNodeId(id.replace(/[\[\]]/g, ''), catalog, true)).toBe(id);
  });

  it('does not guess a twin from a third spelling', () => {
    expect(resolveModelNodeId('[SALES].[ORDERS]', catalog, true)).toBeNull();
  });
});

describe('legacy CI canonical maps', () => {
  it.each(['[Sales].[Orders]', '[sALES].[oRDERS]', 'sales.orders', '"SALES"."ORDERS"'])
    ('fully normalizes %s while retaining a mixed-case stored key', raw => {
    const catalog = new Map<string, unknown>([['[Sales].[Orders]', {}]]);
    expect(resolveModelNodeId(raw, catalog)).toBe('[Sales].[Orders]');
    expect(resolveModelNodeId(raw, catalog, false)).toBe('[Sales].[Orders]');
  });
});

it.each(['[', '"unterminated', '[dbo].[Missing', '[dbo].[Missing]]'])('keeps an unknown malformed identifier %s unresolved in CI and checked CS', raw => {
 const nodes = new Map([['[dbo].[Known]', {}], ['[dbo].[known]', {}]]);
 expect(resolveModelNodeId(raw, nodes)).toBeNull();
 expect(resolveModelNodeId(raw, nodes, true)).toBeNull();
});
