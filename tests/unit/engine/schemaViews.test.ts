/** Schema View and Expanded Schema View construction. */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildExpandedSchemaViewGraph,
  buildGraphologyGraph,
  buildSchemaGraph,
} from '../../../src/engine/graphBuilder';
import { projectSchemaQuotient } from '../../../src/engine/schemaProjection';
import { type DatabaseModel } from '../../../src/engine/shared/types';
import { loadAdventureWorksModel } from '../helpers/testUtils';

const node = (
  id: string,
  name: string,
  schema: string,
  type: DatabaseModel['nodes'][number]['type'],
) =>
  ({ id, name, schema, fullName: id, type }) as DatabaseModel['nodes'][number];

const modelOf = (
  nodes: DatabaseModel['nodes'],
  edges: DatabaseModel['edges'],
  schemas: DatabaseModel['schemas'] = [],
) =>
  ({
    nodes,
    edges,
    schemas,
    catalog: {},
    neighborIndex: {},
  }) as unknown as DatabaseModel;

describe('projectSchemaQuotient', () => {
  const crossSchema = () =>
    modelOf(
      [
        node('[dbo].[proca]', 'ProcA', 'dbo', 'procedure'),
        node('[dbo].[tabled]', 'TableD', 'dbo', 'table'),
        node('[sales].[tableb]', 'TableB', 'sales', 'table'),
        node('[sales].[procc]', 'ProcC', 'sales', 'procedure'),
      ],
      [
        { source: '[dbo].[proca]', target: '[sales].[tableb]', type: 'body' },
        { source: '[sales].[procc]', target: '[dbo].[tabled]', type: 'body' },
      ],
    );

  it('collapses a bidirectional schema pair into one projected edge, keeping forward, reverse and total counts', () => {
    const { edges } = projectSchemaQuotient(
      buildGraphologyGraph(crossSchema()),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      bidirectional: true,
      count: 1,
      reverseCount: 1,
      totalCount: 2,
    });
  });
});

describe('buildSchemaGraph — AdventureWorks', () => {
  let model: DatabaseModel;

  beforeAll(async () => {
    model = await loadAdventureWorksModel();
  });

  it('emits one node per schema in the model', () => {
    expect(buildSchemaGraph(buildGraphologyGraph(model)).nodes).toHaveLength(
      model.schemas.length,
    );
  });

  it('references only emitted schema nodes from its edges', () => {
    const { nodes, edges } = buildSchemaGraph(buildGraphologyGraph(model));
    const ids = new Set(nodes.map((entry) => entry.id));
    const dangling = edges.filter(
      (edge) => !ids.has(edge.source) || !ids.has(edge.target),
    );
    expect(dangling).toEqual([]);
  });
});

describe('buildSchemaGraph — bidirectional pair', () => {
  const bidiModel = () =>
    modelOf(
      [
        node('[a].[p]', 'p', 'a', 'procedure'),
        node('[b].[t]', 't', 'b', 'table'),
      ],
      [
        { source: '[a].[p]', target: '[b].[t]', type: 'body' },
        { source: '[b].[t]', target: '[a].[p]', type: 'body' },
      ],
    );

  it('emits one edge labelled with the combined count, and a reverse marker', () => {
    const { edges } = buildSchemaGraph(buildGraphologyGraph(bidiModel()));
    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe('⇄ 2');
    expect(edges[0].markerStart).toMatchObject({ type: 'arrow' });
  });
});

describe('buildExpandedSchemaViewGraph', () => {
  const NODES: DatabaseModel['nodes'] = [
    node('[sales].[orders]', 'Orders', 'sales', 'table'),
    node('[sales].[customer]', 'Customer', 'sales', 'table'),
    node('[ops].[loadorders]', 'LoadOrders', 'ops', 'procedure'),
    node('[audit].[auditorders]', 'AuditOrders', 'audit', 'table'),
    node('[ref].[lookup]', 'Lookup', 'ref', 'table'),
  ];
  const body = (source: string, target: string) => ({
    source,
    target,
    type: 'body' as const,
  });
  const EDGES: DatabaseModel['edges'] = [
    body('[sales].[customer]', '[sales].[orders]'),
    body('[ops].[loadorders]', '[sales].[orders]'),
    body('[sales].[orders]', '[audit].[auditorders]'),
    body('[ops].[loadorders]', '[audit].[auditorders]'),
    body('[audit].[auditorders]', '[ops].[loadorders]'),
    body('[audit].[auditorders]', '[ref].[lookup]'),
  ];
  const SCHEMAS: DatabaseModel['schemas'] = (
    [
      ['sales', 'table', 2],
      ['ops', 'procedure', 1],
      ['audit', 'table', 1],
      ['ref', 'table', 1],
    ] as const
  ).map(([name, type, nodeCount]) => ({
    name,
    nodeCount,
    types: {
      table: 0,
      view: 0,
      procedure: 0,
      function: 0,
      external: 0,
      [type]: nodeCount,
    },
  }));

  const model = (
    edges: DatabaseModel['edges'] = EDGES,
    nodes: DatabaseModel['nodes'] = NODES,
  ) => modelOf(nodes, edges, SCHEMAS);
  const expand = (
    schemas: string[],
    focus: string | null = null,
    edges?: DatabaseModel['edges'],
    nodes?: DatabaseModel['nodes'],
  ) =>
    buildExpandedSchemaViewGraph(
      buildGraphologyGraph(model(edges, nodes)),
      new Set(schemas),
      focus,
    );
  type Result = ReturnType<typeof expand>;
  const salesExpanded = (focus: string | null = '[sales].[orders]') =>
    expand(['sales'], focus);
  const CLUSTER = '__expandedschemaviewcluster__';
  /** Nodes as `id` for objects and `cluster:<schema>` for flagged collapsed-schema clusters. */
  const nodesOf = (result: Result) =>
    result.flowNodes.map((entry) =>
      entry.type === 'schemaNode'
        ? `${entry.data.isExpandedSchemaViewCluster ? 'cluster' : 'schema'}:${entry.data.schemaName}`
        : entry.id,
    );
  /** Edges as `source→target [label]`, cluster ends shown as `cluster:<schema>`. */
  const edgesOf = (result: Pick<Result, 'flowEdges'>) =>
    result.flowEdges
      .map((edge) =>
        [
          `${edge.source}→${edge.target}`.replaceAll(CLUSTER, 'cluster:'),
          edge.label,
        ]
          .filter(Boolean)
          .join(' '),
      )
      .sort();

  it('renders every object of the expanded schema individually and each collapsed schema as one cluster', () => {
    expect(nodesOf(salesExpanded())).toEqual([
      '[sales].[orders]',
      '[sales].[customer]',
      'cluster:audit',
      'cluster:ops',
      'cluster:ref',
    ]);
  });

  it('bridges expanded objects to clusters and joins clusters by one counted edge per pair, never a self-loop', () => {
    // ops→orders and orders→audit are bridges; audit⇄ops (two edges) and audit→ref are cluster
    // pairs.
    expect(edgesOf(salesExpanded())).toEqual([
      '[sales].[customer]→[sales].[orders]',
      '[sales].[orders]→cluster:audit 1',
      'cluster:audit→cluster:ops ⇄ 2',
      'cluster:audit→cluster:ref 1',
      'cluster:ops→[sales].[orders] 1',
    ]);
    const bidirectional = salesExpanded().flowEdges.find(
      (edge) => edge.label === '⇄ 2',
    );
    expect(bidirectional?.markerStart).toMatchObject({ type: 'arrow' });
  });

  it('renders a second expanded schema as objects, with real edges between expanded schemas and bridges to the rest', () => {
    const result = expand(['sales', 'ops'], '[sales].[orders]');
    expect(nodesOf(result)).toEqual([
      '[sales].[orders]',
      '[sales].[customer]',
      '[ops].[loadorders]',
      'cluster:audit',
      'cluster:ref',
    ]);
    expect(edgesOf(result)).toEqual([
      '[ops].[loadorders]→[sales].[orders]',
      '[ops].[loadorders]→cluster:audit 1',
      '[sales].[customer]→[sales].[orders]',
      '[sales].[orders]→cluster:audit 1',
      'cluster:audit→[ops].[loadorders] 1',
      'cluster:audit→cluster:ref 1',
    ]);
  });
});
