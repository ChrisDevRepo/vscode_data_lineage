/**
 * Schema View and Expanded Schema View construction.
 *
 * @remarks
 * Split out of graphBuilder.test.ts. Covers `projectSchemaQuotient`, `buildSchemaGraph`
 * and `buildExpandedSchemaViewGraph` — the collapse of an object graph into schema
 * clusters, and the bridge edges that keep an expanded schema connected to the clusters
 * around it. A dropped bridge renders a node as an orphan despite its model edges, so
 * each bridge rule is asserted on its own.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildExpandedSchemaViewGraph,
  buildGraph,
  buildGraphologyGraph,
  buildSchemaGraph,
} from '../../../src/engine/graphBuilder';
import { projectSchemaQuotient } from '../../../src/engine/schemaProjection';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../../src/engine/types';
import { getExternalNodeColor } from '../../../src/utils/schemaColors';
import { loadAdventureWorksModel } from '../helpers/testUtils';

const node = (id: string, name: string, schema: string, type: DatabaseModel['nodes'][number]['type']) =>
  ({ id, name, schema, fullName: id, type }) as DatabaseModel['nodes'][number];

const modelOf = (
  nodes: DatabaseModel['nodes'],
  edges: DatabaseModel['edges'],
  schemas: DatabaseModel['schemas'] = [],
) => ({ nodes, edges, schemas, catalog: {}, neighborIndex: {} }) as unknown as DatabaseModel;

// ─── projectSchemaQuotient ────────────────────────────────────────────────────

describe('projectSchemaQuotient', () => {
  // dbo.ProcA writes sales.TableB; sales.ProcC reads dbo.TableD — one edge each way.
  const crossSchema = () => modelOf(
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

  it('collapses a bidirectional schema pair into one projected edge', () => {
    expect(projectSchemaQuotient(buildGraphologyGraph(crossSchema())).edges).toHaveLength(1);
  });

  it('preserves the forward, reverse and total counts separately', () => {
    const [projected] = projectSchemaQuotient(buildGraphologyGraph(crossSchema())).edges;
    expect(projected.bidirectional).toBe(true);
    expect(projected.count).toBe(1);
    expect(projected.reverseCount).toBe(1);
    expect(projected.totalCount).toBe(2);
  });

  it('emits nothing when the working graph holds a single schema', () => {
    const model = crossSchema();
    const dboIds = new Set(model.nodes.filter(entry => entry.schema === 'dbo').map(entry => entry.id));
    const dboOnly = modelOf(
      model.nodes.filter(entry => dboIds.has(entry.id)),
      model.edges.filter(edge => dboIds.has(edge.source) && dboIds.has(edge.target)),
    );
    expect(projectSchemaQuotient(buildGraphologyGraph(dboOnly)).edges).toEqual([]);
  });

  it('drops same-schema edges — the quotient is cross-schema only', () => {
    const sameSchema = modelOf(
      [node('[dbo].[proca]', 'ProcA', 'dbo', 'procedure'), node('[dbo].[tabled]', 'TableD', 'dbo', 'table')],
      [{ source: '[dbo].[proca]', target: '[dbo].[tabled]', type: 'body' }],
    );
    expect(projectSchemaQuotient(buildGraphologyGraph(sameSchema)).edges).toEqual([]);
  });
});

// ─── buildSchemaGraph over the real model ─────────────────────────────────────

describe('buildSchemaGraph — AdventureWorks', () => {
  let model: DatabaseModel;

  beforeAll(async () => { model = await loadAdventureWorksModel(); });

  it('emits one node per schema in the model', () => {
    expect(buildSchemaGraph(buildGraphologyGraph(model)).nodes).toHaveLength(model.schemas.length);
  });

  it('emits one node when the working graph is filtered to a single schema', () => {
    const first = model.schemas[0].name;
    const ids = new Set(model.nodes.filter(entry => entry.schema === first).map(entry => entry.id));
    const filtered = {
      ...model,
      nodes: model.nodes.filter(entry => ids.has(entry.id)),
      edges: model.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    };
    expect(buildSchemaGraph(buildGraphologyGraph(filtered)).nodes).toHaveLength(1);
  });

  it('counts objects and types from the filtered working graph, not the full model', () => {
    const first = model.schemas[0].name;
    const filtered = {
      ...model,
      nodes: model.nodes.filter(entry => entry.schema === first && entry.type === 'table').slice(0, 1),
      edges: [],
    };
    const { nodes } = buildSchemaGraph(buildGraphologyGraph(filtered));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.objectCount).toBe(1);
    expect(nodes[0].data.typeBreakdown.table).toBe(1);
  });

  it('references only emitted schema nodes from its edges', () => {
    const { nodes, edges } = buildSchemaGraph(buildGraphologyGraph(model));
    const ids = new Set(nodes.map(entry => entry.id));
    const dangling = edges.filter(edge => !ids.has(edge.source) || !ids.has(edge.target));
    expect(dangling).toEqual([]);
  });
});

// ─── buildSchemaGraph — bidirectional pair and configuration ──────────────────

describe('buildSchemaGraph — bidirectional pair', () => {
  const bidiModel = () => modelOf(
    [node('[a].[p]', 'p', 'a', 'procedure'), node('[b].[t]', 't', 'b', 'table')],
    [
      { source: '[a].[p]', target: '[b].[t]', type: 'body' },
      { source: '[b].[t]', target: '[a].[p]', type: 'body' },
    ],
  );

  it('emits one edge labelled with the combined count, and a reverse marker', () => {
    const { edges } = buildSchemaGraph(buildGraphologyGraph(bidiModel()));
    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe('⇄ 2');
    expect(edges[0].markerStart).toBeTruthy();
  });

  it('honors the configured layout direction', () => {
    const vertical = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, direction: 'TB' as const, rankSeparation: 321, nodeSeparation: 123, edgeStyle: 'straight' as const },
    };
    const { nodes } = buildSchemaGraph(buildGraphologyGraph(bidiModel()), vertical);
    const source = nodes.find(entry => entry.data.schemaName === 'a')!;
    const target = nodes.find(entry => entry.data.schemaName === 'b')!;
    // Top-to-bottom means the pair separates further vertically than horizontally.
    expect(Math.abs(target.position.y - source.position.y))
      .toBeGreaterThan(Math.abs(target.position.x - source.position.x));
  });

  it('honors the configured edge style', () => {
    const straight = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, direction: 'TB' as const, edgeStyle: 'straight' as const },
    };
    expect(buildSchemaGraph(buildGraphologyGraph(bidiModel()), straight).edges[0].type).toBe('straight');
  });
});

// ─── buildExpandedSchemaViewGraph ─────────────────────────────────────────────

describe('buildExpandedSchemaViewGraph', () => {
  const NODES: DatabaseModel['nodes'] = [
    node('[sales].[orders]', 'Orders', 'sales', 'table'),
    node('[sales].[customer]', 'Customer', 'sales', 'table'),
    node('[ops].[loadorders]', 'LoadOrders', 'ops', 'procedure'),
    node('[audit].[auditorders]', 'AuditOrders', 'audit', 'table'),
    node('[ref].[lookup]', 'Lookup', 'ref', 'table'),
  ];
  const EDGES: DatabaseModel['edges'] = [
    { source: '[sales].[customer]', target: '[sales].[orders]', type: 'body' },
    { source: '[ops].[loadorders]', target: '[sales].[orders]', type: 'body' },
    { source: '[sales].[orders]', target: '[audit].[auditorders]', type: 'body' },
    { source: '[ops].[loadorders]', target: '[audit].[auditorders]', type: 'body' },
    { source: '[audit].[auditorders]', target: '[ops].[loadorders]', type: 'body' },
    { source: '[audit].[auditorders]', target: '[ref].[lookup]', type: 'body' },
  ];
  const SCHEMAS: DatabaseModel['schemas'] = [
    { name: 'sales', nodeCount: 2, types: { table: 2, view: 0, procedure: 0, function: 0, external: 0 } },
    { name: 'ops', nodeCount: 1, types: { table: 0, view: 0, procedure: 1, function: 0, external: 0 } },
    { name: 'audit', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
    { name: 'ref', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
  ];

  const model = (edges: DatabaseModel['edges'] = EDGES, nodes: DatabaseModel['nodes'] = NODES) =>
    modelOf(nodes, edges, SCHEMAS);
  const graph = (edges?: DatabaseModel['edges'], nodes?: DatabaseModel['nodes']) =>
    buildGraphologyGraph(model(edges, nodes));
  const salesExpanded = (focus: string | null = '[sales].[orders]') =>
    buildExpandedSchemaViewGraph(graph(), new Set(['sales']), focus);
  const cluster = (result: ReturnType<typeof salesExpanded>, schema: string) =>
    result.flowNodes.find(entry => entry.type === 'schemaNode' && entry.data.schemaName === schema);

  it('renders every object of the expanded schema individually', () => {
    const objects = salesExpanded().flowNodes
      .filter(entry => entry.type === 'lineageNode' && entry.data.schema === 'sales');
    expect(objects).toHaveLength(2);
  });

  it('does not render an object of a collapsed schema', () => {
    expect(salesExpanded().flowNodes.some(entry => entry.id === '[ops].[loadorders]')).toBe(false);
  });

  it.each(['label', 'fullName', 'objectType', 'inDegree', 'outDegree'] as const)(
    'carries the same %s on an expanded object as the full object graph',
    async (field) => {
      const expanded = salesExpanded().flowNodes.find(entry => entry.id === '[sales].[orders]');
      const full = buildGraph(model()).flowNodes.find(entry => entry.id === '[sales].[orders]');
      expect(expanded?.data[field]).toEqual(full?.data[field]);
    },
  );

  it.each(['ops', 'audit', 'ref'])('flags the collapsed %s schema as a cluster', (schema) => {
    expect(cluster(salesExpanded(), schema)?.data.isExpandedSchemaViewCluster).toBe(true);
  });

  it('bridges an expanded object to the collapsed clusters upstream and downstream of it', () => {
    const result = salesExpanded();
    const bridges = result.flowEdges.map(edge => `${edge.source}→${edge.target}`);
    expect(bridges).toContain(`${cluster(result, 'ops')!.id}→[sales].[orders]`);
    expect(bridges).toContain(`[sales].[orders]→${cluster(result, 'audit')!.id}`);
  });

  it('emits one canonical edge for a bidirectional collapsed pair, labelled with both directions', () => {
    const result = salesExpanded();
    const clusterEdges = result.flowEdges.filter(edge =>
      edge.source.startsWith('__expandedschemaviewcluster__')
      && edge.target.startsWith('__expandedschemaviewcluster__'));
    const bidirectional = clusterEdges.filter(edge => edge.id.includes('↔'));

    expect(bidirectional).toHaveLength(1);
    const auditToOps = bidirectional.find(edge =>
      edge.source === cluster(result, 'audit')!.id && edge.target === cluster(result, 'ops')!.id);
    expect(auditToOps?.label).toBe('⇄ 2');
    expect(auditToOps?.markerStart).toBeTruthy();
  });

  it('keeps a unidirectional collapsed pair as a one-way edge with its count', () => {
    const result = salesExpanded();
    const edge = result.flowEdges.find(entry =>
      entry.source === cluster(result, 'audit')!.id && entry.target === cluster(result, 'ref')!.id);
    expect(edge?.label).toBe('1');
  });

  it('highlights the focus node, and nothing when there is no focus', () => {
    expect(salesExpanded().flowNodes.find(entry => entry.id === '[sales].[orders]')?.data.highlighted).toBe(true);
    expect(salesExpanded(null).flowNodes
      .some(entry => entry.type === 'lineageNode' && entry.data.highlighted === true)).toBe(false);
  });

  it('never emits a self-loop', () => {
    expect(salesExpanded().flowEdges.filter(edge => edge.source === edge.target)).toEqual([]);
  });
});

describe('buildExpandedSchemaViewGraph — additive expansion', () => {
  // Re-declared locally: these cases vary the expanded set rather than the model.
  const NODES: DatabaseModel['nodes'] = [
    node('[sales].[orders]', 'Orders', 'sales', 'table'),
    node('[sales].[customer]', 'Customer', 'sales', 'table'),
    node('[ops].[loadorders]', 'LoadOrders', 'ops', 'procedure'),
    node('[audit].[auditorders]', 'AuditOrders', 'audit', 'table'),
    node('[ref].[lookup]', 'Lookup', 'ref', 'table'),
  ];
  const EDGES: DatabaseModel['edges'] = [
    { source: '[sales].[customer]', target: '[sales].[orders]', type: 'body' },
    { source: '[ops].[loadorders]', target: '[sales].[orders]', type: 'body' },
    { source: '[sales].[orders]', target: '[audit].[auditorders]', type: 'body' },
    { source: '[ops].[loadorders]', target: '[audit].[auditorders]', type: 'body' },
    { source: '[audit].[auditorders]', target: '[ops].[loadorders]', type: 'body' },
    { source: '[audit].[auditorders]', target: '[ref].[lookup]', type: 'body' },
  ];
  const graph = () => buildGraphologyGraph(modelOf(NODES, EDGES));

  it('renders a second expanded schema as objects', () => {
    const result = buildExpandedSchemaViewGraph(graph(), new Set(['sales', 'ops']), '[sales].[orders]');
    expect(result.flowNodes.some(entry => entry.id === '[ops].[loadorders]')).toBe(true);
  });

  it('renders an edge between two expanded schemas as a real object edge', () => {
    const result = buildExpandedSchemaViewGraph(graph(), new Set(['sales', 'ops']), '[sales].[orders]');
    expect(result.flowEdges.some(edge =>
      edge.source === '[ops].[loadorders]' && edge.target === '[sales].[orders]')).toBe(true);
  });

  it('bridges a newly expanded object to the schemas still collapsed', () => {
    const result = buildExpandedSchemaViewGraph(graph(), new Set(['sales', 'ops']), '[sales].[orders]');
    const audit = result.flowNodes.find(entry => entry.type === 'schemaNode' && entry.data.schemaName === 'audit');
    expect(audit).toBeDefined();
    expect(result.flowEdges.some(edge =>
      edge.source === '[ops].[loadorders]' && edge.target === audit!.id)).toBe(true);
  });

  it('emits no bridge and no cluster once every schema is expanded', () => {
    const result = buildExpandedSchemaViewGraph(graph(), new Set(['sales', 'ops', 'audit', 'ref']), null);
    expect(result.flowEdges.filter(edge => edge.id.startsWith('__bridge__'))).toEqual([]);
    expect(result.flowNodes.filter(entry => entry.type === 'schemaNode')).toEqual([]);
  });

  it('gives every individual node its own bridge to a shared collapsed cluster', () => {
    // Regression: only one bridge per (expanded schema × collapsed schema) pair existed,
    // anchored to the first node found, so the second appeared orphaned despite its edges.
    const extra = [...EDGES, { source: '[sales].[customer]', target: '[audit].[auditorders]', type: 'body' as const }];
    const result = buildExpandedSchemaViewGraph(buildGraphologyGraph(modelOf(NODES, extra)), new Set(['sales']), null);
    const audit = result.flowNodes.find(entry => entry.type === 'schemaNode' && entry.data.schemaName === 'audit')!;
    const bridged = result.flowEdges.filter(edge => edge.target === audit.id).map(edge => edge.source);

    expect(bridged).toContain('[sales].[orders]');
    expect(bridged).toContain('[sales].[customer]');
  });

  it('counts a bridge by the edges from that node to the cluster', () => {
    const nodes = [...NODES, node('[audit].[auditlog]', 'AuditLog', 'audit', 'table')];
    const edges = [...EDGES, { source: '[sales].[orders]', target: '[audit].[auditlog]', type: 'body' as const }];
    const result = buildExpandedSchemaViewGraph(buildGraphologyGraph(modelOf(nodes, edges)), new Set(['sales']), null);
    const audit = result.flowNodes.find(entry => entry.type === 'schemaNode' && entry.data.schemaName === 'audit')!;

    expect(result.flowEdges.find(edge =>
      edge.source === '[sales].[orders]' && edge.target === audit.id)?.label).toBe('2');
  });

  it('bridges upstream, from a collapsed cluster into an individual node', () => {
    const edges = [...EDGES, { source: '[ref].[lookup]', target: '[sales].[orders]', type: 'body' as const }];
    const result = buildExpandedSchemaViewGraph(buildGraphologyGraph(modelOf(NODES, edges)), new Set(['sales']), null);
    const ref = result.flowNodes.find(entry => entry.type === 'schemaNode' && entry.data.schemaName === 'ref')!;

    expect(result.flowEdges.some(edge =>
      edge.source === ref.id && edge.target === '[sales].[orders]')).toBe(true);
  });

  it('hides clusters and their bridges, keeping real edges, when hideClusters is set', () => {
    const result = buildExpandedSchemaViewGraph(graph(), new Set(['sales']), null, undefined, { hideClusters: true });

    expect(result.flowNodes.filter(entry => entry.type === 'schemaNode' && !entry.hidden)).toEqual([]);
    expect(result.flowEdges.filter(edge =>
      (edge.id.startsWith('__bridge__') || edge.id.startsWith('__clusteredge__')) && !edge.hidden)).toEqual([]);
    expect(result.flowEdges.some(edge =>
      edge.source === '[sales].[customer]' && edge.target === '[sales].[orders]')).toBe(true);
  });
});

// ─── External-only schemas ────────────────────────────────────────────────────

describe('schema views — an external-only schema', () => {
  const external = { ...node('[ext].[externalfile]', 'ExternalFile', 'ext', 'external'), externalType: 'file' as const };
  const model = modelOf(
    [node('[sales].[orders]', 'Orders', 'sales', 'table'), external],
    [{ source: external.id, target: '[sales].[orders]', type: 'body' }],
    [
      { name: 'sales', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
      { name: 'ext', nodeCount: 1, types: { table: 0, view: 0, procedure: 0, function: 0, external: 1 } },
    ],
  );

  it('marks the overview cluster external-only and colours it accordingly', () => {
    const cluster = buildSchemaGraph(buildGraphologyGraph(model)).nodes
      .find(entry => entry.data.schemaName === 'ext');
    expect(cluster?.data.isExternalOnly).toBe(true);
    expect(cluster?.data.color).toBe(getExternalNodeColor());
  });

  it('expands without crashing, colouring the object outside the schema palette', () => {
    const result = buildExpandedSchemaViewGraph(
      buildGraphologyGraph(model), new Set(['sales', 'ext']), '[sales].[orders]',
    );
    const expanded = result.flowNodes.find(entry => entry.id === external.id);
    expect(expanded).toBeDefined();
    expect(expanded?.data.schemaColor).toBe(getExternalNodeColor());
  });
});
