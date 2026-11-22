/**
 * Canonical node resolution preserves full CI normalization and exact CS catalog identity,
 * including quoted identifiers and model-supplied Unicode padding.
 */
import { describe, expect, it } from 'vitest';
import { createSavedReferenceResolver, resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';

const nodeMap = new Map<string, unknown>([
  ['[ai].[saporders]', {}],
  ['[ai].[factsalesreport]', {}],
]);

describe('resolveModelNodeId', () => {
  it.each([
    ['an id padded with a zero-width space', '[ai].[saporders]\u200b', '[ai].[saporders]'],
    ['ids carrying other Unicode format characters', '\ufeff[ai].[saporders]\u200e', '[ai].[saporders]'],
    ['ordinary padding and case differences', '  [AI].[SAPOrders]  ', '[ai].[saporders]'],
    ['an id that is only invisible characters', '\u200b\u200b', null],
    ['a genuinely unknown id', '[ai].[missing]', null],
  ])('resolves %s', (_label, raw, expected) => {
    expect(resolveModelNodeId(raw, nodeMap)).toBe(expected);
  });
});

describe.each([false, true])('resolveModelNodeId with identifierCaseSensitive=%s', (caseSensitive) => {
  const canonical = caseSensitive ? '[Sales].[Order.Detail]' : '[sales].[order.detail]';
  const catalog = new Map<string, unknown>([[canonical, {}]]);

  it.each(['[Sales].[Order.Detail]', '"Sales"."Order.Detail"', '\t[Sales].[Order.Detail]\r\n', '\ufeff[Sales].[Order.Detail]\u200b\u200e'])
    ('resolves %s without changing catalog identity', (raw) => {
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
  const catalog = new Map<string, unknown>(['[Sales].[Orders]', '[Sales].[orders]', '[sales].[Orders]'].map(id => [id, {}]));

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

describe('createSavedReferenceResolver', () => {
  const types = { table: 1, view: 0, procedure: 0, function: 0, external: 0 };
  const model = {
    schemas: [{ name: 'dbo', nodeCount: 2, types }, { name: 'Sa]]les', nodeCount: 1, types }],
    nodes: [
      ['[dbo].[a]]b]', 'dbo', '[dbo].[a]]b]'],
      ['[sa]]les].[o""p]', 'Sa]]les', '"Sa]]les"."O""p"'],
      ['[dbo].[plain]', 'dbo', 'dbo.plain'],
      ['[__external__].[rem]', '', 'Srv.Db.dbo.Rem'],
      ['[__ext__].[sha]', '', '[__ext__].[sha]', 'file', 'https://example.test/Aa.csv'],
      ['[ext""db].[dbo].[a]]b]', '', '[Ext""Db].[dbo].[a]]b]', 'db'],
    ].map(([id, schema, fullName, externalType, externalUrl]) => ({
      id, schema, fullName, ...(externalType && { externalType }), ...(externalUrl && { externalUrl }),
    })) as never,
  };
  it.each([
    [undefined, '[dbo].[a]b]', '[dbo].[a]]b]', 'Sa]les', 'Sa]]les'],
    [undefined, '[__ext__].[6b68923e]', '[__ext__].[sha]', 'missing', null],
    [undefined, '[ext"db].[dbo].[a]b]', '[ext""db].[dbo].[a]]b]', 'DBO', 'dbo'],
    [undefined, '[__external__].[rem]', '[__external__].[rem]', 'dbo', 'dbo'],
    [2 as const, '[dbo].[a]b]', null, 'Sa]les', null],
    [2 as const, '[dbo].[a]]b]', '[dbo].[a]]b]', 'Sa]]les', 'Sa]]les'],
  ])('v=%s resolves %s -> %s and schema %s -> %s', (ver, rawNode, expNode, rawSchema, expSchema) => {
    const r = createSavedReferenceResolver(model, ver);
    expect([r.nodeId(rawNode), r.schema(rawSchema)]).toEqual([expNode, expSchema]);
  });
  it('returns null on ambiguous CS legacy aliases while resolving unique CS canonical ids', () => {
    const csNodes = [
      { id: '[dbo].[a""b]', schema: 'dbo', fullName: '[dbo].[a""b]' },
      { id: '[dbo].[a"b]', schema: 'dbo', fullName: '[dbo].[a"b]' },
    ] as never;
    const cs = createSavedReferenceResolver({ identifierCaseSensitive: true, schemas: [], nodes: csNodes });
    expect([cs.nodeId('[dbo].[a"b]'), cs.nodeId('[dbo].[a""b]'), cs.nodeId('[dbo].[missing]')]).toEqual([null, '[dbo].[a""b]', null]);
  });
});
