/**
 * Canonical node resolution preserves full CI normalization and exact CS catalog identity,
 * including quoted identifiers and model-supplied Unicode padding.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { createSavedReferenceResolver, resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(loadParseRules);

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

describe.each([false, true])('legacy saved references for remote objects (CS=%s)', cs => {
  const remote = (bodyScript: string) => buildModel(
    [{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript }],
    [], undefined, 'Local', true, undefined, cs,
  );

  it('keeps the local procedure and does not map a collapsed old remote id onto either current twin', () => {
    const model = remote('SELECT * FROM "Remote"."dbo"."a]]b"; SELECT * FROM "Remote"."dbo"."a]b";');
    const legacy = createSavedReferenceResolver(model);
    const reader = model.nodes.find(node => node.type === 'procedure')!;
    expect(model.nodes.filter(node => node.externalType === 'db')).toHaveLength(2);
    expect(legacy.nodeId(reader.id)).toBe(reader.id);
    expect(legacy.nodeId(cs ? '[Remote].[dbo].[a]]b]' : '[remote].[dbo].[a]b]')).toBeNull();
    expect(legacy.schema(reader.schema)).toBe(reader.schema);
    expect(legacy.schema('missing-schema')).toBeNull();
  });

  it('does not map repeated-quote legacy remote bytes onto the current twin', () => {
    const model = remote('SELECT ID FROM [Remote].[dbo].[a""""b]; SELECT ID FROM [Remote].[dbo].[a"b];');
    const legacy = createSavedReferenceResolver(model);
    expect(model.nodes.filter(node => node.externalType === 'db')).toHaveLength(2);
    expect(legacy.nodeId(cs ? '[Remote].[dbo].[a"b]' : '[remote].[dbo].[a"b]')).toBeNull();
  });
});
