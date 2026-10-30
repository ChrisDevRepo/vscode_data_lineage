/** Tests for the pure column-trace-view derivation: relation normalisation, row/shape derivation, relation-to-state resolution, deterministic ordering, and handle id uniqueness. */

import { describe, it, expect } from 'vitest';
import {
  buildColumnThreadIndex,
  buildColumnTraceView,
  columnHandleId,
  columnRowKey,
  columnThread,
  resolveRowLineStates,
  resolveColumnLineState,
  COLUMN_NODE_BORDER_WIDTH,
  COLUMN_NODE_HEADER_HEIGHT,
  COLUMN_ROW_HEIGHT,
  type ColumnLineState,
  type ColumnTraceRelation,
  type ColumnTraceViewEdge,
  type ColumnTraceViewInput,
  type ColumnTraceViewObject,
  COLUMN_NODE_WIDTH,
  COLUMN_TRANSFORM_NODE_WIDTH,
  COLUMN_TRANSFORM_NODE_HEIGHT,
  COLUMN_AI_ANNOTATION_BAND,
} from '../../../src/engine/columnTraceView';
import {
  DEFAULT_CONFIG,
  type ExtensionConfig,
} from '../../../src/engine/types';
import { normalizeColName, quoteIdentifier } from '../../../src/utils/sql';

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

function findNode(view: ReturnType<typeof buildColumnTraceView>, id: string) {
  const node = view.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} not found`);
  return node;
}

function findRow(
  view: ReturnType<typeof buildColumnTraceView>,
  nodeId: string,
  colName: string,
) {
  const node = findNode(view, nodeId);
  const row = node.rows.find(
    (r) => r.name.toLowerCase() === colName.toLowerCase(),
  );
  if (!row) throw new Error(`row ${colName} not found on ${nodeId}`);
  return row;
}

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
      const relations: ColumnTraceRelation[] = [
        {
          hopNode: 'dbo.t',
          fromNode: 'dbo.s',
          fromCol: spelling,
          toNode: 'dbo.t',
          toCol: spelling,
        },
      ];
      const original = structuredClone(relations);
      const view = buildColumnTraceView({
        relations,
        objects,
        identifierCaseSensitive: cs,
        config: DEFAULT_CONFIG,
      });
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

  it('keeps exact metadata display names and types for checked CS column twins', () => {
    const objects = mkObjects(
      ...['dbo.s', 'dbo.t'].map((id) => ({
        ...mkObj(id),
        columnNames: new Map([
          ['Value', 'Value'],
          ['value', 'value'],
        ]),
        columnTypes: new Map([
          ['Value', 'int'],
          ['value', 'money'],
        ]),
      })),
    );
    const relations: ColumnTraceRelation[] = ['[Value]', '"value"'].map(
      (column) => ({
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: column,
        toNode: 'dbo.t',
        toCol: column,
      }),
    );
    const view = buildColumnTraceView({
      relations,
      objects,
      identifierCaseSensitive: true,
      config: DEFAULT_CONFIG,
    });
    expect(
      view.nodes.map((node) =>
        node.rows.map((row) => [row.name, row.dataType]),
      ),
    ).toEqual([
      [
        ['Value', 'int'],
        ['value', 'money'],
      ],
      [
        ['Value', 'int'],
        ['value', 'money'],
      ],
    ]);
    expect(
      view.edges.map((edge) => [edge.sourceColumn, edge.targetColumn]),
    ).toEqual([
      ['Value', 'Value'],
      ['value', 'value'],
    ]);
    expect(new Set(view.edges.map((edge) => edge.sourceHandle)).size).toBe(2);
  });

  it('retains recorded names on opaque procedure ports while endpoint rows use metadata', () => {
    const objects = mkObjects(
      { ...mkObj('dbo.s'), columnNames: new Map([['quantity', 'Quantity']]) },
      mkObj('dbo.p', 'procedure'),
      { ...mkObj('dbo.t'), columnNames: new Map([['total', 'Total']]) },
    );
    const view = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s',
          fromCol: 'quantity',
          toNode: 'dbo.t',
          toCol: '[TOTAL]',
        },
      ],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findNode(view, 'dbo.p').rows.map((row) => row.name)).toEqual([
      'quantity',
      '[TOTAL]',
    ]);
    expect(
      view.edges.map((edge) => [edge.sourceColumn, edge.targetColumn]),
    ).toEqual([
      ['Quantity', 'quantity'],
      ['[TOTAL]', 'Total'],
    ]);
    expect(view.portBridges).toEqual([
      { nodeId: 'dbo.p', fromColumn: 'quantity', toColumn: '[TOTAL]' },
    ]);
  });

  it('normalises the viaNode shape and the endpoint shape to the same rendering', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));

    const endpointShape: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'Amount',
        toNode: 'dbo.t',
        toCol: 'Amount',
      },
    ];
    const viaNodeShape: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.p',
        fromNode: 'dbo.s',
        fromCol: 'Amount',
        toNode: 'dbo.t',
        toCol: 'Amount',
      },
    ];

    const endpointView = buildColumnTraceView({
      relations: endpointShape,
      objects,
      config: DEFAULT_CONFIG,
    });
    const viaNodeView = buildColumnTraceView({
      relations: viaNodeShape,
      objects,
      config: DEFAULT_CONFIG,
    });

    expect(endpointView.nodes.map((n) => n.id).sort()).toEqual([
      'dbo.s',
      'dbo.t',
    ]);
    expect(viaNodeView.nodes.map((n) => n.id).sort()).toEqual([
      'dbo.s',
      'dbo.t',
    ]);

    expect(endpointView.edges).toHaveLength(1);
    expect(viaNodeView.edges).toHaveLength(1);
    const endpointEdge = endpointView.edges[0];
    const viaEdge = viaNodeView.edges[0];

    expect(viaEdge.source).toBe(endpointEdge.source);
    expect(viaEdge.target).toBe(endpointEdge.target);
    expect(viaEdge.sourceHandle).toBe(endpointEdge.sourceHandle);
    expect(viaEdge.targetHandle).toBe(endpointEdge.targetHandle);
    expect(viaEdge.state).toBe(endpointEdge.state);
  });

  it('marks a procedure as a transform node', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.p', 'procedure'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.p',
        fromNode: 'dbo.s',
        fromCol: 'Amount',
        toNode: 'dbo.p',
        toCol: 'Amount',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const procNode = findNode(view, 'dbo.p');

    expect(procNode.isTransformNode).toBe(true);
    expect(procNode.rows).toHaveLength(1);

    const tableNode = findNode(view, 'dbo.s');
    expect(tableNode.isTransformNode).toBe(false);
  });

  it('marks a function with declared columns as a column card, not a hub', () => {
    const tvf: ColumnTraceViewObject = {
      ...mkObj('dbo.tvf', 'function'),
      columnTypes: new Map([['amount', 'int']]),
    };
    const objects = mkObjects(mkObj('dbo.s'), tvf);
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.tvf',
        fromNode: 'dbo.s',
        fromCol: 'Amount',
        toNode: 'dbo.tvf',
        toCol: 'Amount',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const tvfNode = findNode(view, 'dbo.tvf');
    expect(tvfNode.isTransformNode).toBe(false);
    expect(tvfNode.width).toBe(COLUMN_NODE_WIDTH);
  });

  it('marks a function with no declared columns as a transform hub', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.fn', 'function'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.fn',
        fromNode: 'dbo.s',
        fromCol: 'Amount',
        toNode: 'dbo.fn',
        toCol: 'Amount',
      },
    ];

    const node = findNode(
      buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }),
      'dbo.fn',
    );
    expect(node.isTransformNode).toBe(true);
    expect(node.width).toBe(COLUMN_TRANSFORM_NODE_WIDTH);
  });

  it('derives renamed when endpoint column names differ', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'Amt',
        toNode: 'dbo.t',
        toCol: 'Amount',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const row = findRow(view, 'dbo.t', 'Amount');
    expect(row.shape).toBe('renamed');
  });

  it('derives incoming with the correct contributor count', () => {
    const objects = mkObjects(mkObj('dbo.s1'), mkObj('dbo.s2'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s1',
        fromCol: 'A',
        toNode: 'dbo.t',
        toCol: 'X',
      },
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s2',
        fromCol: 'A',
        toNode: 'dbo.t',
        toCol: 'X',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const row = findRow(view, 'dbo.t', 'X');
    expect(row.shape).toBe('incoming');
    expect(row.contributors).toBe(2);
  });

  it('derives outgoing when one upstream column feeds multiple targets', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t1'), mkObj('dbo.t2'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.s',
        fromNode: 'dbo.s',
        fromCol: 'A',
        toNode: 'dbo.t1',
        toCol: 'X',
      },
      {
        hopNode: 'dbo.s',
        fromNode: 'dbo.s',
        fromCol: 'A',
        toNode: 'dbo.t2',
        toCol: 'Y',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const row = findRow(view, 'dbo.s', 'A');
    expect(row.shape).toBe('outgoing');
    expect(row.contributors).toBe(2);
  });

  it('marks a column with no inbound relation as terminal', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.s',
        fromNode: 'dbo.s',
        fromCol: 'A',
        toNode: 'dbo.t',
        toCol: 'A',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const row = findRow(view, 'dbo.s', 'A');
    expect(row.shape).toBe('terminal');
  });

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

  it('orders rows in first-seen order, not alphabetical order', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'Zebra',
        toNode: 'dbo.t',
        toCol: 'Zebra',
      },
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'Apple',
        toNode: 'dbo.t',
        toCol: 'Apple',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const node = findNode(view, 'dbo.t');
    expect(node.rows.map((r) => r.name)).toEqual(['Zebra', 'Apple']);
  });

  it('produces distinct handle ids for the source and target side of the same column', () => {
    const sourceHandle = columnHandleId('Amount', 'source');
    const targetHandle = columnHandleId('Amount', 'target');
    expect(sourceHandle).not.toBe(targetHandle);
    expect(columnHandleId('[Amount]', 'source')).toBe(sourceHandle);
  });

  it('yields an empty view for an empty relation list without throwing', () => {
    const input: ColumnTraceViewInput = {
      relations: [],
      objects: new Map(),
      config: DEFAULT_CONFIG,
    };
    expect(() => buildColumnTraceView(input)).not.toThrow();
    const view = buildColumnTraceView(input);
    expect(view.nodes).toEqual([]);
    expect(view.edges).toEqual([]);
  });

  it('includes the card border in the node height so the last row is not clipped', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'A',
        toNode: 'dbo.t',
        toCol: 'A',
      },
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'B',
        toNode: 'dbo.t',
        toCol: 'B',
      },
    ];

    const node = findNode(
      buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }),
      'dbo.t',
    );
    expect(node.rows).toHaveLength(2);
    expect(node.height).toBe(
      COLUMN_NODE_HEADER_HEIGHT +
        2 * COLUMN_ROW_HEIGHT +
        2 * COLUMN_NODE_BORDER_WIDTH,
    );
  });

  it('joins the declared backend data type onto the row, keyed by normalised column name', () => {
    const objects = mkObjects(
      {
        ...mkObj('dbo.s'),
        columnTypes: new Map([['amount', 'decimal(18,2)']]),
      },
      mkObj('dbo.t'),
    );
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: '[Amount]',
        toNode: 'dbo.t',
        toCol: 'Amount',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findRow(view, 'dbo.s', '[Amount]').dataType).toBe('decimal(18,2)');
    expect(findRow(view, 'dbo.t', 'Amount').dataType).toBeUndefined();
  });

  it('carries the classification and note onto the edge', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.t',
        fromNode: 'dbo.s',
        fromCol: 'A',
        toNode: 'dbo.t',
        toCol: 'B',
        transforms: ['compute'],
        note: 'A * 2',
      },
    ];

    const [edge] = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    }).edges;
    expect(edge.transforms).toEqual(['compute']);
    expect(edge.note).toBe('A * 2');
  });

  it('renders per-relation value changes within one analyzed SQL projection', () => {
    // CREATE VIEW dbo.t AS SELECT A AS Copied, A * 2 AS Doubled FROM dbo.s;
    const view = buildColumnTraceView({
      objects: mkObjects(mkObj('dbo.s'), mkObj('dbo.t', 'view')),
      config: DEFAULT_CONFIG,
      relations: [
        {
          hopNode: 'dbo.t',
          fromNode: 'dbo.s',
          fromCol: 'A',
          toNode: 'dbo.t',
          toCol: 'Copied',
          transforms: ['pass_through'],
        },
        {
          hopNode: 'dbo.t',
          fromNode: 'dbo.s',
          fromCol: 'A',
          toNode: 'dbo.t',
          toCol: 'Doubled',
          transforms: ['compute'],
        },
      ],
    });
    expect(view.edges.map((edge) => [edge.targetColumn, edge.state])).toEqual([
      ['Copied', 'passthrough'],
      ['Doubled', 'transformation'],
    ]);
    expect(Array.from(resolveRowLineStates(view.edges).values())).toEqual([
      'passthrough',
      'transformation',
    ]);
  });

  it('puts the same classification on both legs of a relation routed through the hop', () => {
    const objects = mkObjects(
      mkObj('dbo.s'),
      mkObj('dbo.p', 'procedure'),
      mkObj('dbo.t'),
    );
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.p',
        fromNode: 'dbo.s',
        fromCol: 'Qty',
        toNode: 'dbo.t',
        toCol: 'Total',
        transforms: ['aggregate'],
        note: 'SUM of Qty',
      },
    ];

    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    for (const leg of view.edges) {
      expect(leg.transforms).toEqual(['aggregate']);
      expect(leg.note).toBe('SUM of Qty');
    }
  });

  it.each([false, true])(
    'merges notes, classes and value state on a shared leg (reverse=%s)',
    (reverse) => {
      const objects = mkObjects(
        mkObj('dbo.s'),
        mkObj('dbo.r'),
        mkObj('dbo.p', 'procedure'),
        mkObj('dbo.t'),
      );
      const relations: ColumnTraceRelation[] = [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s',
          fromCol: 'Qty',
          toNode: 'dbo.t',
          toCol: 'Total',
          transforms: ['compute'],
          note: 'Qty * 2',
        },
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.r',
          fromCol: 'Flag',
          toNode: 'dbo.t',
          toCol: 'Total',
          transforms: ['filter'],
          note: 'WHERE Flag = 1',
        },
      ];
      if (reverse) relations.reverse();

      const shared = buildColumnTraceView({
        relations,
        objects,
        config: DEFAULT_CONFIG,
      }).edges.filter((e) => e.source === 'dbo.p' && e.target === 'dbo.t');
      expect(shared).toHaveLength(1);
      expect(shared[0].transforms).toEqual(
        reverse ? ['filter', 'compute'] : ['compute', 'filter'],
      );
      expect(shared[0].note).toBe(
        reverse ? 'WHERE Flag = 1\nQty * 2' : 'Qty * 2\nWHERE Flag = 1',
      );
      expect(shared[0].state).toBe('transformation');
    },
  );

  it('sizes a transform super node as a compact circle box, not a port card', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.p', 'procedure'));
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: 'dbo.p',
        fromNode: 'dbo.s',
        fromCol: 'A',
        toNode: 'dbo.p',
        toCol: 'A',
      },
    ];

    const node = findNode(
      buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }),
      'dbo.p',
    );
    expect(node.width).toBe(COLUMN_TRANSFORM_NODE_WIDTH);
    expect(node.height).toBe(COLUMN_TRANSFORM_NODE_HEIGHT);
    expect(node.isTransformNode).toBe(true);
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

  const relations: ColumnTraceRelation[] = [
    {
      hopNode: 'dbo.p',
      fromNode: 'dbo.s1',
      fromCol: 'Qty',
      toNode: 'dbo.t',
      toCol: 'Total',
    },
    {
      hopNode: 'dbo.p',
      fromNode: 'dbo.s2',
      fromCol: 'Price',
      toNode: 'dbo.t',
      toCol: 'Total',
    },
  ];

  it('draws each relation as two legs through the hop rather than past it', () => {
    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const legs = view.edges.map(
      (e) => `${e.source}.${e.sourceColumn}->${e.target}.${e.targetColumn}`,
    );

    expect(legs).toContain('dbo.s1.Qty->dbo.p.Qty');
    expect(legs).toContain('dbo.s2.Price->dbo.p.Price');
    expect(legs).toContain('dbo.p.Total->dbo.t.Total');
    expect(legs.some((leg) => leg.startsWith('dbo.s1.Qty->dbo.t'))).toBe(false);
  });

  it('draws the shared outbound leg once', () => {
    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const outbound = view.edges.filter(
      (e) => e.source === 'dbo.p' && e.target === 'dbo.t',
    );
    expect(outbound).toHaveLength(1);
    expect(new Set(view.edges.map((e) => e.id)).size).toBe(view.edges.length);
  });

  it('keeps the target incoming shape on the original endpoints, not on the legs', () => {
    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const row = findRow(view, 'dbo.t', 'Total');
    expect(row.shape).toBe('incoming');
    expect(row.contributors).toBe(2);
  });

  it('keeps the rename signal across the split', () => {
    const view = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s1',
          fromCol: 'Amt',
          toNode: 'dbo.t',
          toCol: 'Amount',
        },
      ],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findRow(view, 'dbo.t', 'Amount').shape).toBe('renamed');
  });

  it('gives the hop one port per name the column carries, so a rename shows two', () => {
    const renaming = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s1',
          fromCol: 'Amt',
          toNode: 'dbo.t',
          toCol: 'Amount',
        },
      ],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findNode(renaming, 'dbo.p').rows.map((r) => r.name)).toEqual([
      'Amt',
      'Amount',
    ]);

    const unchanged = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s1',
          fromCol: 'Amount',
          toNode: 'dbo.t',
          toCol: 'Amount',
        },
      ],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findNode(unchanged, 'dbo.p').rows.map((r) => r.name)).toEqual([
      'Amount',
    ]);
  });

  it("bridges the hop's two ports, so a thread crossing it does not end there", () => {
    const view = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s1',
          fromCol: 'Amt',
          toNode: 'dbo.t',
          toCol: 'Amount',
        },
      ],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(view.portBridges).toEqual([
      { nodeId: 'dbo.p', fromColumn: 'Amt', toColumn: 'Amount' },
    ]);
  });

  it('bridges each relation separately, so two threads through one hop stay apart', () => {
    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(view.portBridges).toEqual([
      { nodeId: 'dbo.p', fromColumn: 'Qty', toColumn: 'Total' },
      { nodeId: 'dbo.p', fromColumn: 'Price', toColumn: 'Total' },
    ]);
    expect(
      view.portBridges.some(
        (b) => b.fromColumn === 'Qty' && b.toColumn === 'Price',
      ),
    ).toBe(false);
  });

  it('records no bridge when the name is unchanged, the one port already carrying the thread', () => {
    const view = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s1',
          fromCol: 'Amount',
          toNode: 'dbo.t',
          toCol: 'Amount',
        },
      ],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(view.portBridges).toEqual([]);
  });

  it('renders a hop outside the view as a direct edge, having nothing to route through', () => {
    const withoutProc = mkObjects(mkObj('dbo.s1'), mkObj('dbo.t'));
    const view = buildColumnTraceView({
      relations: [
        {
          hopNode: 'dbo.p',
          fromNode: 'dbo.s1',
          fromCol: 'Qty',
          toNode: 'dbo.t',
          toCol: 'Qty',
        },
      ],
      objects: withoutProc,
      config: DEFAULT_CONFIG,
    });
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['dbo.s1', 'dbo.t']);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0].source).toBe('dbo.s1');
    expect(view.edges[0].target).toBe('dbo.t');
  });
});

describe('resolveRowLineStates', () => {
  function edge(
    target: string,
    targetColumn: string,
    state: ColumnLineState,
  ): ColumnTraceViewEdge {
    return {
      id: `${target}:${targetColumn}:${state}`,
      source: 'dbo.s',
      sourceHandle: columnHandleId(targetColumn, 'source'),
      sourceColumn: targetColumn,
      target,
      targetHandle: columnHandleId(targetColumn, 'target'),
      targetColumn,
      state,
    };
  }

  it('keeps the state of a row fed by a single edge', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Amount', 'passthrough'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Amount'))).toBe('passthrough');
  });

  it('resolves an incoming row to transformation when any contributor transforms', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'NetAmount', 'passthrough'),
      edge('dbo.t', 'NetAmount', 'transformation'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'NetAmount'))).toBe(
      'transformation',
    );
  });

  it('is independent of edge order — the glyph must not follow hop order', () => {
    const forward = resolveRowLineStates([
      edge('dbo.t', 'NetAmount', 'transformation'),
      edge('dbo.t', 'NetAmount', 'passthrough'),
    ]);
    const reversed = resolveRowLineStates([
      edge('dbo.t', 'NetAmount', 'passthrough'),
      edge('dbo.t', 'NetAmount', 'transformation'),
    ]);
    expect(forward.get(columnRowKey('dbo.t', 'NetAmount'))).toBe(
      reversed.get(columnRowKey('dbo.t', 'NetAmount')),
    );
  });

  it('keeps passthrough only when every contributor agrees', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Qty', 'passthrough'),
      edge('dbo.t', 'Qty', 'passthrough'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Qty'))).toBe('passthrough');
  });

  it('degrades a passthrough/unknown disagreement to unknown rather than claiming either', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Qty', 'passthrough'),
      edge('dbo.t', 'Qty', 'unknown'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Qty'))).toBe('unknown');
  });

  it('keys rows by normalised column identity so a bracketed spelling lands on the same row', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', '[Amount]', 'transformation'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'amount'))).toBe('transformation');
  });

  it('scopes rows per node — the same column name on two nodes stays separate', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Amount', 'passthrough'),
      edge('dbo.u', 'Amount', 'transformation'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Amount'))).toBe('passthrough');
    expect(states.get(columnRowKey('dbo.u', 'Amount'))).toBe('transformation');
  });

  it('returns an empty map for no edges', () => {
    expect(resolveRowLineStates([]).size).toBe(0);
  });
});

describe('columnTraceView layout settings', () => {
  /** Horizontal distance between the two ranks of a two-node left-to-right view. */
  function rankGap(view: ReturnType<typeof buildColumnTraceView>): number {
    return (
      findNode(view, 'dbo.t').position.x - findNode(view, 'dbo.s').position.x
    );
  }

  const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
  const relations: ColumnTraceRelation[] = [
    {
      hopNode: 'dbo.t',
      fromNode: 'dbo.s',
      fromCol: 'Amount',
      toNode: 'dbo.t',
      toCol: 'Amount',
    },
  ];

  it('spaces ranks by the caller rank separation, not by a built-in default', () => {
    const wide: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: {
        ...DEFAULT_CONFIG.layout,
        rankSeparation: DEFAULT_CONFIG.layout.rankSeparation + 200,
      },
    };
    const defaultGap = rankGap(
      buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }),
    );
    const wideGap = rankGap(
      buildColumnTraceView({ relations, objects, config: wide }),
    );

    expect(defaultGap).toBe(
      COLUMN_NODE_WIDTH + DEFAULT_CONFIG.layout.rankSeparation,
    );
    expect(wideGap).toBe(COLUMN_NODE_WIDTH + wide.layout.rankSeparation);
  });

  it('takes the layout direction from the configuration when the view requests none', () => {
    const topDown: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, direction: 'TB' },
    };
    const view = buildColumnTraceView({ relations, objects, config: topDown });
    const source = findNode(view, 'dbo.s');
    const target = findNode(view, 'dbo.t');

    expect(target.position.y).toBeGreaterThan(source.position.y);
    expect(target.position.x).toBe(source.position.x);
  });

  it('lets an explicit view direction override the configured one', () => {
    const topDown: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, direction: 'TB' },
    };
    const view = buildColumnTraceView({
      relations,
      objects,
      config: topDown,
      layoutDirection: 'LR',
    });

    expect(rankGap(view)).toBe(
      COLUMN_NODE_WIDTH + topDown.layout.rankSeparation,
    );
  });
});

/** The AI badge and note draw above and below the card through `NodeToolbar`, outside the box Dagre measures. At the default separation of 30 their ~32px band does not fit, and one node's note lands on the next node's badge — so the band is carried by the vertical separation instead. */
describe('columnTraceView AI annotation band', () => {
  const objects = mkObjects(mkObj('dbo.s1'), mkObj('dbo.s2'), mkObj('dbo.t'));
  const relations: ColumnTraceRelation[] = [
    {
      hopNode: 'dbo.t',
      fromNode: 'dbo.s1',
      fromCol: 'Amount',
      toNode: 'dbo.t',
      toCol: 'Amount',
    },
    {
      hopNode: 'dbo.t',
      fromNode: 'dbo.s2',
      fromCol: 'Qty',
      toNode: 'dbo.t',
      toCol: 'Qty',
    },
  ];

  /** Vertical space between the two rank siblings, measured edge to edge. */
  function siblingGap(view: ReturnType<typeof buildColumnTraceView>): number {
    const [upper, lower] = [
      findNode(view, 'dbo.s1'),
      findNode(view, 'dbo.s2'),
    ].sort((a, b) => a.position.y - b.position.y);
    return lower.position.y - (upper.position.y + upper.height);
  }

  it('adds the band to the rank-sibling gap under LR', () => {
    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
      layoutDirection: 'LR',
    });

    expect(siblingGap(view)).toBe(
      DEFAULT_CONFIG.layout.nodeSeparation + COLUMN_AI_ANNOTATION_BAND,
    );
  });

  it('adds the band to the rank gap under TB, where the vertical neighbour is the next rank', () => {
    const view = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
      layoutDirection: 'TB',
    });
    const source = findNode(view, 'dbo.s1');
    const target = findNode(view, 'dbo.t');

    expect(target.position.y - (source.position.y + source.height)).toBe(
      DEFAULT_CONFIG.layout.rankSeparation + COLUMN_AI_ANNOTATION_BAND,
    );
  });

  it('stays additive to the configured separation rather than replacing it', () => {
    const tight: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, nodeSeparation: 4 },
    };
    const view = buildColumnTraceView({
      relations,
      objects,
      config: tight,
      layoutDirection: 'LR',
    });

    expect(siblingGap(view)).toBe(4 + COLUMN_AI_ANNOTATION_BAND);
  });
});

/** Lane for the column thread a click pins: the clicked column's trace cone — what it is derived from and what is derived from it — never a sibling input that merely shares an output with it. */
describe('columnThread — directed trace cone', () => {
  it.each([
    ['->', false],
    ['->', true],
    ['::', false],
    ['::', true],
  ] as const)(
    'preserves separate relations containing literal %s separators (CS=%s)',
    (separator, cs) => {
      const [a, b, c, hop] = ['a', 'b', 'c', 'h'].map(
        (name) => `[dbo].[${name}]`,
      );
      const from = quoteIdentifier(`x->${b}${separator}y`);
      const to = quoteIdentifier(`y->${c}${separator}z`);
      const relations = [
        { hopNode: hop, fromNode: a, fromCol: 'x', toNode: b, toCol: to },
        { hopNode: hop, fromNode: a, fromCol: from, toNode: c, toCol: 'z' },
      ];
      const view = buildColumnTraceView({
        relations,
        objects: mkObjects(...[a, b, c].map((id) => mkObj(id))),
        identifierCaseSensitive: cs,
        config: DEFAULT_CONFIG,
      });
      expect(
        view.edges.map((edge) => [edge.sourceColumn, edge.targetColumn]),
      ).toEqual([
        ['x', to],
        [from, 'z'],
      ]);
      const index = buildColumnThreadIndex(view);
      expect(columnThread(index, columnRowKey(a, 'x', cs))).toEqual(
        new Set([columnRowKey(a, 'x', cs), columnRowKey(b, to, cs)]),
      );
      expect(columnThread(index, columnRowKey(a, from, cs))).toEqual(
        new Set([columnRowKey(a, from, cs), columnRowKey(c, 'z', cs)]),
      );
    },
  );

  it.each([false, true])(
    'separates local dotted-column identity from a qualified remote node (CS=%s)',
    (cs) => {
      const local = '[dbo].[a]';
      const remote = '[dbo].[a].[b]';
      const sink = '[dbo].[sink]';
      const dottedColumn = '[[b]].c]';
      const view = buildColumnTraceView({
        identifierCaseSensitive: cs,
        config: DEFAULT_CONFIG,
        objects: mkObjects(
          mkObj(local),
          mkObj(remote, 'external'),
          mkObj(sink),
        ),
        relations: [
          {
            hopNode: sink,
            fromNode: local,
            fromCol: dottedColumn,
            toNode: sink,
            toCol: 'Left',
          },
          {
            hopNode: sink,
            fromNode: remote,
            fromCol: 'c',
            toNode: sink,
            toCol: 'Right',
          },
        ],
      });
      const localKey = columnRowKey(local, dottedColumn, cs);
      const remoteKey = columnRowKey(remote, 'c', cs);
      expect(localKey).not.toBe(remoteKey);
      const threads = buildColumnThreadIndex(view);
      expect(columnThread(threads, localKey)).toEqual(
        new Set([localKey, columnRowKey(sink, 'Left', cs)]),
      );
      expect(columnThread(threads, remoteKey)).toEqual(
        new Set([remoteKey, columnRowKey(sink, 'Right', cs)]),
      );
    },
  );

  const objects = mkObjects(
    mkObj('ai.SalesStaging'),
    mkObj('ai.vwConsolidatedSales', 'view'),
    mkObj('ai.PriceMaster'),
    mkObj('ai.vwPriceList', 'view'),
    mkObj('ai.spBuildSalesReport', 'procedure'),
    mkObj('ai.FactSalesReport'),
  );
  const relations: ColumnTraceRelation[] = [
    {
      hopNode: 'ai.vwConsolidatedSales',
      fromNode: 'ai.SalesStaging',
      fromCol: 'OrderQty',
      toNode: 'ai.vwConsolidatedSales',
      toCol: 'Qty',
    },
    {
      hopNode: 'ai.vwPriceList',
      fromNode: 'ai.PriceMaster',
      fromCol: 'ListPrice',
      toNode: 'ai.vwPriceList',
      toCol: 'UnitPrice',
    },
    {
      hopNode: 'ai.spBuildSalesReport',
      fromNode: 'ai.vwConsolidatedSales',
      fromCol: 'Qty',
      toNode: 'ai.FactSalesReport',
      toCol: 'TotalRevenue',
    },
    {
      hopNode: 'ai.spBuildSalesReport',
      fromNode: 'ai.vwPriceList',
      fromCol: 'UnitPrice',
      toNode: 'ai.FactSalesReport',
      toCol: 'TotalRevenue',
    },
  ];
  const index = buildColumnThreadIndex(
    buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }),
  );

  it('follows a column up to its sources and down to its consumers without turning around at a fan-in', () => {
    const cone = columnThread(
      index,
      columnRowKey('ai.vwConsolidatedSales', 'Qty'),
    );
    expect(
      cone.has(columnRowKey('ai.SalesStaging', 'OrderQty')),
      'upstream source',
    ).toBe(true);
    expect(
      cone.has(columnRowKey('ai.spBuildSalesReport', 'TotalRevenue')),
      'across the renaming hop',
    ).toBe(true);
    expect(
      cone.has(columnRowKey('ai.FactSalesReport', 'TotalRevenue')),
      'downstream consumer',
    ).toBe(true);
    expect(
      cone.has(columnRowKey('ai.vwPriceList', 'UnitPrice')),
      'sibling input of TotalRevenue',
    ).toBe(false);
    expect(cone.has(columnRowKey('ai.PriceMaster', 'ListPrice'))).toBe(false);
  });

  it('lights every input of a column clicked at the fan-in', () => {
    const cone = columnThread(
      index,
      columnRowKey('ai.FactSalesReport', 'TotalRevenue'),
    );
    for (const [node, col] of [
      ['ai.vwConsolidatedSales', 'Qty'],
      ['ai.SalesStaging', 'OrderQty'],
      ['ai.vwPriceList', 'UnitPrice'],
      ['ai.PriceMaster', 'ListPrice'],
    ]) {
      expect(cone.has(columnRowKey(node, col)), `${node}.${col}`).toBe(true);
    }
  });

  it('terminates on a cycle', () => {
    const cyclic = buildColumnThreadIndex({
      edges: [
        { source: 'a', sourceColumn: 'x', target: 'b', targetColumn: 'x' },
        { source: 'b', sourceColumn: 'x', target: 'a', targetColumn: 'x' },
      ] as ColumnTraceViewEdge[],
      portBridges: [],
    });
    expect(columnThread(cyclic, columnRowKey('a', 'x')).size).toBe(2);
  });
});

it('keeps checked CS object and column twins distinct through rows, handles, value states and thread indexes', () => {
  const upper = '[dbo].[CaseTab]';
  const lower = '[dbo].[casetab]';
  const sink = '[dbo].[Sink]';
  const objects = new Map([upper, lower, sink].map((id) => [id, mkObj(id)]));
  const view = buildColumnTraceView({
    identifierCaseSensitive: true,
    objects,
    config: DEFAULT_CONFIG,
    relations: [
      {
        hopNode: upper,
        fromNode: upper,
        fromCol: 'Value',
        toNode: sink,
        toCol: 'Upper',
        transforms: ['compute'],
      },
      {
        hopNode: lower,
        fromNode: lower,
        fromCol: 'Value',
        toNode: sink,
        toCol: 'lower',
        transforms: ['pass_through'],
      },
      {
        hopNode: upper,
        fromNode: upper,
        fromCol: 'value',
        toNode: sink,
        toCol: 'Other',
        transforms: ['compute'],
      },
    ],
  });
  expect(view.nodes.map((n) => n.id)).toEqual([upper, sink, lower]);
  expect(view.edges).toHaveLength(3);
  expect(findNode(view, upper).rows.map((row) => row.name)).toEqual([
    'Value',
    'value',
  ]);
  expect(view.edges[0].state).toBe('transformation');
  expect(view.edges[1].state).toBe('passthrough');
  expect(view.edges[0].sourceHandle).not.toBe(view.edges[2].sourceHandle);
  const index = buildColumnThreadIndex(view);
  expect(index.down.get(columnRowKey(upper, 'Value', true))).toEqual([
    columnRowKey(sink, 'Upper', true),
  ]);
  expect(index.down.get(columnRowKey(lower, 'Value', true))).toEqual([
    columnRowKey(sink, 'lower', true),
  ]);
  expect(columnRowKey(upper, 'Value', true)).not.toBe(
    columnRowKey(upper, 'value', true),
  );
});

describe('buildColumnTraceView — objects without a column relation', () => {
  const [src, mid, rowless] = [
    '[ai].[src]',
    '[ai].[mid]',
    '[ai].[sparchiveoldorders]',
  ];
  const relations: ColumnTraceRelation[] = [
    { hopNode: mid, fromNode: src, fromCol: 'Qty', toNode: mid, toCol: 'Qty' },
  ];

  it('keeps a row-less object as a node with no rows and joins it by its object edge', () => {
    const view = buildColumnTraceView({
      relations,
      objects: mkObjects(mkObj(src), mkObj(mid), mkObj(rowless, 'procedure')),
      config: DEFAULT_CONFIG,
      objectEdges: [{ source: mid, target: rowless }],
    });
    expect(view.nodes.map((n) => n.id)).toEqual([src, mid, rowless]);
    expect(findNode(view, rowless).rows).toEqual([]);
    expect(view.objectEdges.map((e) => [e.source, e.target])).toEqual([
      [mid, rowless],
    ]);
    expect(
      findNode(view, rowless).position,
      'laid out beside its neighbour, not parked at the origin',
    ).not.toEqual(findNode(view, mid).position);
  });

  it('draws no object edge between two objects a column edge already joins', () => {
    const view = buildColumnTraceView({
      relations,
      objects: mkObjects(mkObj(src), mkObj(mid), mkObj(rowless)),
      config: DEFAULT_CONFIG,
      objectEdges: [
        { source: src, target: mid },
        { source: mid, target: rowless },
        { source: mid, target: rowless },
        { source: rowless, target: rowless },
      ],
    });
    expect(view.edges).toHaveLength(1);
    expect(
      view.objectEdges.map((e) => [e.source, e.target]),
      'one line per pair, none for a self edge',
    ).toEqual([[mid, rowless]]);
  });

  it.each([false, true])(
    'keeps the object bridge between separate column components (reversed=%s)',
    (reversed) => {
      const [a, b, c, d] = ['dbo.a', 'dbo.b', 'dbo.c', 'dbo.d'];
      const relations: ColumnTraceRelation[] = [
        { hopNode: b, fromNode: a, fromCol: 'Qty', toNode: b, toCol: 'Qty' },
        {
          hopNode: d,
          fromNode: c,
          fromCol: 'Amount',
          toNode: d,
          toCol: 'Amount',
        },
      ];
      const before = structuredClone(relations);
      const bridge = reversed
        ? { source: c, target: b }
        : { source: b, target: c };
      const view = buildColumnTraceView({
        relations,
        objects: mkObjects(...[a, b, c, d].map((id) => mkObj(id))),
        config: DEFAULT_CONFIG,
        objectEdges: [
          { source: a, target: b },
          bridge,
          { source: c, target: d },
        ],
      });
      expect(
        view.objectEdges.map(({ source, target }) => ({ source, target })),
      ).toEqual([bridge]);
      expect(view.edges.map((edge) => [edge.source, edge.target])).toEqual([
        [a, b],
        [c, d],
      ]);
      const reachable = new Set([a]);
      for (let pass = 0; pass < view.nodes.length; pass++)
        for (const edge of [...view.edges, ...view.objectEdges]) {
          if (reachable.has(edge.source) || reachable.has(edge.target)) {
            reachable.add(edge.source);
            reachable.add(edge.target);
          }
        }
      expect([...reachable].sort()).toEqual([a, b, c, d]);
      // A declared object dependency connects the view, without inventing column-value lineage.
      expect(
        columnThread(buildColumnThreadIndex(view), columnRowKey(a, 'Qty')),
      ).toEqual(new Set([columnRowKey(a, 'Qty'), columnRowKey(b, 'Qty')]));
      expect(relations).toEqual(before);
    },
  );

  it('suppresses only represented directed object pairs through a procedure', () => {
    const [a, procedure, b] = ['dbo.a', 'dbo.proc', 'dbo.b'];
    const view = buildColumnTraceView({
      relations: [
        {
          hopNode: procedure,
          fromNode: a,
          fromCol: 'Qty',
          toNode: b,
          toCol: 'Total',
          transforms: ['compute'],
        },
      ],
      objects: mkObjects(mkObj(a), mkObj(procedure, 'procedure'), mkObj(b)),
      config: DEFAULT_CONFIG,
      objectEdges: [
        { source: a, target: procedure },
        { source: procedure, target: b },
        { source: procedure, target: a },
        { source: b, target: procedure },
      ],
    });
    expect(view.edges.map((edge) => [edge.source, edge.target])).toEqual([
      [a, procedure],
      [procedure, b],
    ]);
    expect(view.objectEdges.map((edge) => [edge.source, edge.target])).toEqual([
      [procedure, a],
      [b, procedure],
    ]);
    expect(
      columnThread(buildColumnThreadIndex(view), columnRowKey(a, 'Qty')),
    ).toEqual(
      new Set([
        columnRowKey(a, 'Qty'),
        columnRowKey(procedure, 'Qty'),
        columnRowKey(procedure, 'Total'),
        columnRowKey(b, 'Total'),
      ]),
    );
  });

  it('ignores an object edge whose endpoint is not a presented object', () => {
    const view = buildColumnTraceView({
      relations,
      objects: mkObjects(mkObj(src), mkObj(mid), mkObj(rowless)),
      config: DEFAULT_CONFIG,
      objectEdges: [{ source: mid, target: '[ai].[elsewhere]' }],
    });
    expect(view.objectEdges).toEqual([]);
  });

  it('leaves the output unchanged when the object edge already has a rendered column leg', () => {
    const objects = mkObjects(mkObj(src), mkObj(mid));
    const plain = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const withEdges = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
      objectEdges: [{ source: src, target: mid }],
    });
    expect(withEdges).toEqual(plain);
    expect(plain.objectEdges).toEqual([]);
    expect(plain.nodes.map((n) => n.id)).toEqual([src, mid]);
  });

  it('keeps the row-less object out of every column thread', () => {
    const view = buildColumnTraceView({
      relations,
      objects: mkObjects(mkObj(src), mkObj(mid), mkObj(rowless)),
      config: DEFAULT_CONFIG,
      objectEdges: [{ source: mid, target: rowless }],
    });
    const index = buildColumnThreadIndex(view);
    const thread = columnThread(index, columnRowKey(src, 'Qty'));
    expect(thread).toEqual(
      new Set([columnRowKey(src, 'Qty'), columnRowKey(mid, 'Qty')]),
    );
    expect(
      [...index.down.keys(), ...index.up.keys()].every(
        (key) => !key.includes('sparchiveoldorders'),
      ),
    ).toBe(true);
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
      const input = {
        relations: [],
        objects,
        identifierCaseSensitive: cs,
        config: DEFAULT_CONFIG,
        requested: {
          node: origin,
          columns: ['[Value]', cs ? '"value"' : '"VALUE"'],
        },
      };
      const before = structuredClone(input.requested);
      const view = buildColumnTraceView(input);
      expect(findNode(view, origin).rows.map((row) => row.name)).toEqual(
        cs ? ['Value', 'value'] : ['Value'],
      );
      expect(view.edges).toEqual([]);
      expect(view.portBridges).toEqual([]);
      const key = columnRowKey(origin, 'Value', cs);
      expect(columnThread(buildColumnThreadIndex(view), key)).toEqual(
        new Set([key]),
      );
      expect(input.requested).toEqual(before);
    },
  );

  it('adds an unmapped asked row without changing real relations or the source-free born hub thread', () => {
    const [source, procedure, target] = ['dbo.s', 'dbo.p', 'dbo.t'];
    const objects = mkObjects(
      mkObj(source),
      mkObj(procedure, 'procedure'),
      mkObj(target),
    );
    const relations: ColumnTraceRelation[] = [
      {
        hopNode: procedure,
        fromNode: source,
        fromCol: 'Qty',
        toNode: target,
        toCol: 'Total',
        transforms: ['compute'],
      },
      {
        hopNode: procedure,
        fromNode: procedure,
        fromCol: 'Born',
        toNode: target,
        toCol: 'Born',
      },
    ];
    const baseline = buildColumnTraceView({
      relations,
      objects,
      config: DEFAULT_CONFIG,
    });
    const input = {
      relations,
      objects,
      config: DEFAULT_CONFIG,
      requested: { node: target, columns: ['Total', 'Missing', 'Born'] },
    };
    const view = buildColumnTraceView(input);
    expect(
      findNode(view, target)
        .rows.map((row) => row.name)
        .sort(),
    ).toEqual(['Born', 'Missing', 'Total']);
    expect(view.edges).toEqual(baseline.edges);
    expect(view.portBridges).toEqual(baseline.portBridges);
    const index = buildColumnThreadIndex(view);
    expect(columnThread(index, columnRowKey(target, 'Born'))).toEqual(
      new Set([columnRowKey(procedure, 'Born'), columnRowKey(target, 'Born')]),
    );
    expect(columnThread(index, columnRowKey(target, 'Total'))).toEqual(
      columnThread(
        buildColumnThreadIndex(baseline),
        columnRowKey(target, 'Total'),
      ),
    );
    expect(columnThread(index, columnRowKey(target, 'Missing'))).toEqual(
      new Set([columnRowKey(target, 'Missing')]),
    );
  });

  it('keeps old relation-only bookmarks rowless when no requested descriptor was saved', () => {
    const view = buildColumnTraceView({
      relations: [],
      objects: mkObjects(mkObj('dbo.t')),
      config: DEFAULT_CONFIG,
    });
    expect(findNode(view, 'dbo.t').rows).toEqual([]);
    expect(view.edges).toEqual([]);
  });
});
