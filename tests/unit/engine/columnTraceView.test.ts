/**
 * Column trace view: metadata display names, row shapes and value states, edge classification, legs
 * routed through the analysing hop, the directed column thread, and a row for every requested
 * column.
 */

import { describe, it, expect } from 'vitest';
import {
  buildColumnThreadIndex,
  buildColumnTraceView,
  columnRowKey,
  columnThread,
  resolveColumnLineState,
  type ColumnTraceViewInput,
  type ColumnTraceViewObject,
  COLUMN_AI_ANNOTATION_BAND,
} from '../../../src/engine/columnTraceView';
import type { ColumnAspectEdge } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/shared/types';
import { normalizeColName } from '../../../src/utils/sql';

type View = ReturnType<typeof buildColumnTraceView>;

function mkObj(
  id: string,
  objectType = 'table',
  label?: string,
): ColumnTraceViewObject {
  return { id, label: label ?? id, schema: 'dbo', objectType };
}

function mkObjects(
  ...objs: ColumnTraceViewObject[]
): Map<string, ColumnTraceViewObject> {
  const map = new Map<string, ColumnTraceViewObject>();
  for (const o of objs) map.set(o.id.toLowerCase(), o);
  return map;
}

function rel(
  hopNode: string,
  fromNode: string,
  fromCol: string,
  toNode: string,
  toCol: string,
  extra: Partial<ColumnAspectEdge> = {},
): ColumnAspectEdge {
  return { hopNode, fromNode, fromCol, toNode, toCol, ...extra };
}

function build(
  relations: ColumnAspectEdge[],
  objects: Map<string, ColumnTraceViewObject>,
  extra: Partial<ColumnTraceViewInput> = {},
): View {
  return buildColumnTraceView({
    relations,
    objects,
    config: DEFAULT_CONFIG,
    ...extra,
  });
}

function findNode(view: View, id: string) {
  const node = view.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} not found`);
  return node;
}

function findRow(view: View, nodeId: string, colName: string) {
  const node = findNode(view, nodeId);
  const row = node.rows.find(
    (r) => r.name.toLowerCase() === colName.toLowerCase(),
  );
  if (!row) throw new Error(`row ${colName} not found on ${nodeId}`);
  return row;
}

const legsOf = (view: View) =>
  view.edges.map(
    (e) => `${e.source}.${e.sourceColumn}->${e.target}.${e.targetColumn}`,
  );

describe('columnTraceView', () => {
  it.each([
    [false, 'value'],
    [false, '[VALUE]'],
    [false, '"VaLuE"'],
    [true, 'Value'],
    [true, '[Value]'],
    [true, '"Value"'],
  ] as const)(
    'displays extracted metadata names rather than relation spellings (CS=%s, column=%s)',
    (cs, spelling) => {
      const objects = mkObjects(
        ...['dbo.s', 'dbo.t'].map((id) => ({
          ...mkObj(
            id,
            'table',
            id === 'dbo.s' ? 'SourceObject' : 'TargetObject',
          ),
          columnNames: new Map([[normalizeColName('Value', cs), 'Value']]),
          columnTypes: new Map([
            [normalizeColName('Value', cs), 'decimal(18,2)'],
          ]),
        })),
      );
      const relations = [rel('dbo.t', 'dbo.s', spelling, 'dbo.t', spelling)];
      const original = structuredClone(relations);
      const view = build(relations, objects, { identifierCaseSensitive: cs });
      expect(view.nodes.map((node) => node.label)).toEqual([
        'SourceObject',
        'TargetObject',
      ]);
      expect(
        view.nodes.map((node) =>
          node.rows.map((row) => [row.name, row.dataType]),
        ),
      ).toEqual([[['Value', 'decimal(18,2)']], [['Value', 'decimal(18,2)']]]);
      expect(
        view.edges.map((edge) => [edge.sourceColumn, edge.targetColumn]),
      ).toEqual([['Value', 'Value']]);
      expect(relations).toEqual(original);
    },
  );

  it.each([
    {
      shape: 'renamed',
      relations: [rel('dbo.t', 'dbo.s', 'Amt', 'dbo.t', 'Amount')],
      row: ['dbo.t', 'Amount'],
    },
    {
      shape: 'incoming',
      contributors: 2,
      relations: ['dbo.s', 'dbo.s2'].map((from) =>
        rel('dbo.t', from, 'A', 'dbo.t', 'X'),
      ),
      row: ['dbo.t', 'X'],
    },
    {
      shape: 'outgoing',
      contributors: 2,
      relations: [
        rel('dbo.s', 'dbo.s', 'A', 'dbo.t', 'X'),
        rel('dbo.s', 'dbo.s', 'A', 'dbo.t2', 'Y'),
      ],
      row: ['dbo.s', 'A'],
    },
    {
      shape: 'terminal',
      relations: [rel('dbo.s', 'dbo.s', 'A', 'dbo.t', 'A')],
      row: ['dbo.s', 'A'],
    },
  ])(
    'derives the $shape row shape from the relations',
    ({ shape, contributors, relations, row: [nodeId, column] }) => {
      const objects = mkObjects(
        ...['dbo.s', 'dbo.s2', 'dbo.t', 'dbo.t2'].map((id) => mkObj(id)),
      );
      const row = findRow(build(relations, objects), nodeId, column);
      expect(row.shape).toBe(shape);
      if (contributors !== undefined)
        expect(row.contributors).toBe(contributors);
    },
  );

  describe('resolveColumnLineState', () => {
    it.each([
      { transforms: ['pass_through'], state: 'passthrough' },
      {
        transforms: ['pass_through', 'filter', 'combine'],
        state: 'passthrough',
      },
      { transforms: ['compute'], state: 'transformation' },
      { transforms: ['aggregate', 'pass_through'], state: 'transformation' },
      { transforms: ['pass_through', 'compute'], state: 'transformation' },
      { transforms: undefined, state: 'unknown' },
      { transforms: [], state: 'unknown' },
      { transforms: ['filter', 'combine'], state: 'unknown' },
    ] as const)(
      'resolves $transforms to $state from value evidence',
      ({ transforms, state }) => {
        expect(resolveColumnLineState(transforms)).toBe(state);
      },
    );
  });

  it('carries the classification and note onto the edge', () => {
    const [edge] = build(
      [
        rel('dbo.t', 'dbo.s', 'A', 'dbo.t', 'B', {
          transforms: ['compute'],
          note: 'A * 2',
        }),
      ],
      mkObjects(mkObj('dbo.s'), mkObj('dbo.t')),
    ).edges;
    expect(edge.transforms).toEqual(['compute']);
    expect(edge.note).toBe('A * 2');
  });
});

/** Lane for the transform node's place in the chain. */
describe('buildColumnTraceView — routing through the analysing hop', () => {
  const objects = mkObjects(
    mkObj('dbo.s1'),
    mkObj('dbo.s2'),
    mkObj('dbo.p', 'procedure'),
    mkObj('dbo.t'),
  );

  const relations = [
    rel('dbo.p', 'dbo.s1', 'Qty', 'dbo.t', 'Total'),
    rel('dbo.p', 'dbo.s2', 'Price', 'dbo.t', 'Total'),
  ];

  it('draws each relation as two legs through the hop, sharing the outbound leg once', () => {
    const view = build(relations, objects);
    expect(legsOf(view)).toEqual([
      'dbo.s1.Qty->dbo.p.Qty',
      'dbo.p.Total->dbo.t.Total',
      'dbo.s2.Price->dbo.p.Price',
    ]);
    expect(new Set(view.edges.map((e) => e.id)).size).toBe(view.edges.length);
  });
});

/**
 * The AI badge and note draw above and below the card through `NodeToolbar`, outside the box Dagre
 * measures. At the default separation of 30 their ~32px band does not fit, and one node's note
 * lands on the next node's badge — so the band is carried by the vertical separation instead.
 */
describe('columnTraceView AI annotation band', () => {
  const objects = mkObjects(mkObj('dbo.s1'), mkObj('dbo.s2'), mkObj('dbo.t'));
  const relations = [
    rel('dbo.t', 'dbo.s1', 'Amount', 'dbo.t', 'Amount'),
    rel('dbo.t', 'dbo.s2', 'Qty', 'dbo.t', 'Qty'),
  ];

  /** Vertical space between the two rank siblings, measured edge to edge. */
  function siblingGap(view: View): number {
    const [upper, lower] = [
      findNode(view, 'dbo.s1'),
      findNode(view, 'dbo.s2'),
    ].sort((a, b) => a.position.y - b.position.y);
    return lower.position.y - (upper.position.y + upper.height);
  }

  it('adds the band to the rank-sibling gap under LR', () => {
    expect(
      siblingGap(build(relations, objects, { layoutDirection: 'LR' })),
    ).toBe(DEFAULT_CONFIG.layout.nodeSeparation + COLUMN_AI_ANNOTATION_BAND);
  });
});

/**
 * Lane for the column thread a click pins: the clicked column's trace cone — what it is derived
 * from and what is derived from it — never a sibling input that merely shares an output with it.
 */
describe('columnThread — directed trace cone', () => {
  // SalesStaging.OrderQty -> vwConsolidatedSales.Qty and PriceMaster.ListPrice ->
  // vwPriceList.UnitPrice, both feeding FactSalesReport.TotalRevenue through the
  // spBuildSalesReport hop (ports Qty, UnitPrice, TotalRevenue).
  const index = buildColumnThreadIndex(
    build(
      [
        rel(
          'ai.vwConsolidatedSales',
          'ai.SalesStaging',
          'OrderQty',
          'ai.vwConsolidatedSales',
          'Qty',
        ),
        rel(
          'ai.vwPriceList',
          'ai.PriceMaster',
          'ListPrice',
          'ai.vwPriceList',
          'UnitPrice',
        ),
        rel(
          'ai.spBuildSalesReport',
          'ai.vwConsolidatedSales',
          'Qty',
          'ai.FactSalesReport',
          'TotalRevenue',
        ),
        rel(
          'ai.spBuildSalesReport',
          'ai.vwPriceList',
          'UnitPrice',
          'ai.FactSalesReport',
          'TotalRevenue',
        ),
      ],
      mkObjects(
        mkObj('ai.SalesStaging'),
        mkObj('ai.vwConsolidatedSales', 'view'),
        mkObj('ai.PriceMaster'),
        mkObj('ai.vwPriceList', 'view'),
        mkObj('ai.spBuildSalesReport', 'procedure'),
        mkObj('ai.FactSalesReport'),
      ),
    ),
  );
  const keys = (...pairs: [string, string][]) =>
    new Set(pairs.map(([node, col]) => columnRowKey(node, col)));
  const qtyChain: [string, string][] = [
    ['ai.SalesStaging', 'OrderQty'],
    ['ai.vwConsolidatedSales', 'Qty'],
    ['ai.spBuildSalesReport', 'Qty'],
  ];
  const revenue: [string, string][] = [
    ['ai.spBuildSalesReport', 'TotalRevenue'],
    ['ai.FactSalesReport', 'TotalRevenue'],
  ];

  it('follows a column up to its sources and down to its consumers without turning around at a fan-in', () => {
    // Excludes the sibling input chain vwPriceList.UnitPrice <- PriceMaster.ListPrice.
    expect(
      columnThread(index, columnRowKey('ai.vwConsolidatedSales', 'Qty')),
    ).toEqual(keys(...qtyChain, ...revenue));
  });

  it('lights every input of a column clicked at the fan-in', () => {
    expect(
      columnThread(index, columnRowKey('ai.FactSalesReport', 'TotalRevenue')),
    ).toEqual(
      keys(
        ...qtyChain,
        ['ai.PriceMaster', 'ListPrice'],
        ['ai.vwPriceList', 'UnitPrice'],
        ['ai.spBuildSalesReport', 'UnitPrice'],
        ...revenue,
      ),
    );
  });
});

describe('buildColumnTraceView — requested columns independent of relations', () => {
  it.each([false, true])(
    'keeps zero-edge requested rows with metadata names and isolated threads (CS=%s)',
    (cs) => {
      const origin = 'dbo.t';
      const objects = mkObjects({
        ...mkObj(origin),
        columnNames: new Map([
          [normalizeColName('Value', cs), 'Value'],
          [normalizeColName('value', cs), cs ? 'value' : 'Value'],
        ]),
      });
      const requested = {
        node: origin,
        columns: ['[Value]', cs ? '"value"' : '"VALUE"'],
      };
      const before = structuredClone(requested);
      const view = build([], objects, {
        identifierCaseSensitive: cs,
        requested,
      });
      expect(findNode(view, origin).rows.map((row) => row.name)).toEqual(
        cs ? ['Value', 'value'] : ['Value'],
      );
      expect(view.edges).toEqual([]);
      expect(view.portBridges).toEqual([]);
      const key = columnRowKey(origin, 'Value', cs);
      expect(columnThread(buildColumnThreadIndex(view), key)).toEqual(
        new Set([key]),
      );
      expect(requested).toEqual(before);
    },
  );
});
