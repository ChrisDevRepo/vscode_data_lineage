import Graph from 'graphology';
import type { ObjectType } from './types';
import { addRawSchemaEdge, collapseRawSchemaEdges, type CollapsedSchemaEdge } from './schemaEdgeHelpers';

/**
 * Sets of node IDs rendered individually or as collapsed schema clusters.
 */
export interface ExpandedSchemaViewResult {
  /** Objects rendered individually: every object whose schema is expanded. */
  individual: Set<string>;
  /** Objects collapsed into per-schema cluster nodes. */
  collapsed: Set<string>;
}

/**
 * Options for counting or hiding collapsed schema clusters.
 */
export interface ExpandedSchemaViewRenderOptions {
  /** Whether collapsed schemas should count as rendered cluster nodes. */
  includeCollapsedSchemaClusters?: boolean;
  /** When true, cluster nodes and their edges are marked `hidden: true` in React Flow. */
  hideClusters?: boolean;
}

/**
 * Schema-level aggregate node derived from object-level graph nodes.
 */
export interface SchemaProjectionNode {
  /**
   * Schema name represented by this aggregate node.
   */
  schemaName: string;
  /**
   * Number of objects in the schema.
   */
  objectCount: number;
  /**
   * Object counts keyed by lineage object type.
   */
  typeBreakdown: Partial<Record<ObjectType, number>>;
}

/**
 * Schema-level dependency edge aggregated from object-level edges.
 */
export type SchemaProjectionEdge = CollapsedSchemaEdge;

/**
 * Schema-level quotient projection of the object graph.
 */
export interface SchemaProjection {
  /**
   * Schema aggregate nodes keyed by schema name.
   */
  nodes: Map<string, SchemaProjectionNode>;
  /**
   * Aggregated schema-to-schema dependency edges.
   */
  edges: SchemaProjectionEdge[];
}

/**
 * Bridge edge between an expanded object node and a collapsed schema cluster.
 */
export interface SchemaBridgeEdge {
  /**
   * Expanded object node connected to the collapsed schema cluster.
   */
  nearId: string;
  /**
   * Collapsed schema on the far side of the bridge.
   */
  schema: string;
  /**
   * Direction of the bridge relative to the expanded object node.
   */
  dir: 'down' | 'up';
  /**
   * Number of object-level edges represented by the bridge.
   */
  count: number;
}

/**
 * Expanded Schema View projection with object nodes, schema clusters, and bridge edges.
 */
export interface ExpandedSchemaProjection extends ExpandedSchemaViewResult {
  /**
   * Collapsed schema clusters keyed by schema name.
   */
  collapsedSchemas: Map<string, SchemaProjectionNode>;
  /**
   * Object-level edges between individually rendered nodes.
   */
  individualEdges: Array<{ source: string; target: string }>;
  /**
   * Bridge edges between expanded objects and collapsed schema clusters.
   */
  bridges: Map<string, SchemaBridgeEdge>;
  /**
   * Aggregated edges between collapsed schema clusters.
   */
  schemaClusterEdges: SchemaProjectionEdge[];
}

function schemaOf(graph: Graph, id: string): string {
  return String(graph.getNodeAttribute(id, 'schema') ?? '');
}

function typeOf(graph: Graph, id: string): ObjectType | null {
  const type = graph.getNodeAttribute(id, 'type');
  return typeof type === 'string' && type.length > 0 ? type as ObjectType : null;
}

function hasIncludedNode(id: string, includedIds?: ReadonlySet<string>): boolean {
  return !includedIds || includedIds.has(id);
}

/**
 * Partitions graph nodes into expanded-object and collapsed-schema sets.
 *
 * @param graph - Graph instance to traverse.
 * @param expandedSchemas - Schemas that should render as individual object nodes.
 *
 * @returns Expanded and collapsed node sets for the current schema selection.
 */
export function partitionBySchema(graph: Graph, expandedSchemas: ReadonlySet<string>): ExpandedSchemaViewResult {
  const individual = new Set<string>();
  const collapsed = new Set<string>();

  for (const id of graph.nodes()) {
    if (expandedSchemas.has(schemaOf(graph, id))) individual.add(id);
    else collapsed.add(id);
  }

  return { individual, collapsed };
}

/**
 * Projects object-level lineage into a schema-level quotient graph.
 *
 * @param graph - Graph instance to traverse.
 * @param includedIds - Optional node IDs to keep in the projection.
 *
 * @returns Schema-level quotient projection of the object graph.
 */
export function projectSchemaQuotient(graph: Graph, includedIds?: ReadonlySet<string>): SchemaProjection {
  const nodes = new Map<string, SchemaProjectionNode>();
  const rawEdges = new Map<string, number>();

  for (const id of graph.nodes()) {
    if (!hasIncludedNode(id, includedIds)) continue;
    const schemaName = schemaOf(graph, id);
    if (!schemaName) continue;

    if (!nodes.has(schemaName)) {
      nodes.set(schemaName, { schemaName, objectCount: 0, typeBreakdown: {} });
    }
    const meta = nodes.get(schemaName)!;
    meta.objectCount++;

    const type = typeOf(graph, id);
    if (type) meta.typeBreakdown[type] = (meta.typeBreakdown[type] ?? 0) + 1;
  }

  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (!hasIncludedNode(source, includedIds) || !hasIncludedNode(target, includedIds)) return;
    const sourceSchema = schemaOf(graph, source);
    const targetSchema = schemaOf(graph, target);
    if (!sourceSchema || !targetSchema || sourceSchema === targetSchema) return;
    addRawSchemaEdge(rawEdges, sourceSchema, targetSchema);
  });

  return {
    nodes: new Map([...nodes.entries()].sort(([a], [b]) => a.localeCompare(b))),
    edges: collapseRawSchemaEdges(rawEdges),
  };
}

/**
 * Builds the mixed object-and-schema projection used by Expanded Schema View.
 *
 * @param graph - Graph instance to traverse.
 * @param expandedSchemas - Schemas that should render as individual object nodes.
 * @param options - Options that shape the returned summary.
 *
 * @returns Expanded Schema View projection for the current graph.
 */
export function projectExpandedSchemaView(
  graph: Graph,
  expandedSchemas: ReadonlySet<string>,
  options: ExpandedSchemaViewRenderOptions = {},
): ExpandedSchemaProjection {
  const includeCollapsedSchemaClusters = options.includeCollapsedSchemaClusters !== false;
  const { individual, collapsed } = partitionBySchema(graph, expandedSchemas);
  const collapsedProjection = includeCollapsedSchemaClusters
    ? projectSchemaQuotient(graph, collapsed)
    : { nodes: new Map<string, SchemaProjectionNode>(), edges: [] };
  const individualEdges: Array<{ source: string; target: string }> = [];
  const bridges = new Map<string, SchemaBridgeEdge>();

  graph.forEachEdge((_edge, _attrs, source, target) => {
    const sourceIsIndividual = individual.has(source);
    const targetIsIndividual = individual.has(target);

    if (sourceIsIndividual && targetIsIndividual) {
      individualEdges.push({ source, target });
      return;
    }

    if (!includeCollapsedSchemaClusters || (!sourceIsIndividual && !targetIsIndividual)) return;

    const collapsedId = sourceIsIndividual ? target : source;
    const nearId = sourceIsIndividual ? source : target;
    const schema = schemaOf(graph, collapsedId);
    if (!schema) return;

    const dir: SchemaBridgeEdge['dir'] = sourceIsIndividual ? 'down' : 'up';
    const key = `${nearId}|${schema}|${dir}`;
    const current = bridges.get(key);
    if (current) current.count++;
    else bridges.set(key, { nearId, schema, dir, count: 1 });
  });

  return {
    individual,
    collapsed,
    collapsedSchemas: collapsedProjection.nodes,
    individualEdges,
    bridges,
    schemaClusterEdges: collapsedProjection.edges,
  };
}

/**
 * Counts rendered nodes for Expanded Schema View limit checks.
 *
 * @param graph - Graph instance to traverse.
 * @param expandedSchemas - Schemas that should render as individual object nodes.
 * @param options - Options that shape the returned summary.
 *
 * @returns Number of rendered nodes in Expanded Schema View.
 */
export function countExpandedSchemaViewRenderedNodes(
  graph: Graph,
  expandedSchemas: ReadonlySet<string>,
  options: ExpandedSchemaViewRenderOptions = {},
): number {
  const projection = projectExpandedSchemaView(graph, expandedSchemas, options);
  return projection.individual.size + projection.collapsedSchemas.size;
}
