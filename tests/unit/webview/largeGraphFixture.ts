/**
 * Deterministic large-graph generator for the rendering lanes.
 *
 * The largest tracked fixture is 148 nodes (tests/fixtures/graph-baseline-aw.json), so nothing above
 * ~150 objects had ever been executed. `maxNodes` admits 2000 objects and `renderLimit` renders up
 * to 1500, which leaves the whole range a real warehouse lands in untested. This builds a model of
 * any size with a warehouse-like shape — schemas of tables feeding views feeding procedures — with
 * no randomness, so a failure is reproducible from the node count alone.
 */

import type {
  CatalogEntry,
  DatabaseModel,
  LineageEdge,
  LineageNode,
  NeighborIndex,
  ObjectType,
  SchemaInfo,
} from '../../../src/engine/types';

/** Schemas the generated objects are spread across, mirroring a mid-size warehouse. */
const SCHEMAS = ['dbo', 'stg', 'dim', 'fact', 'ref', 'audit', 'etl', 'rpt', 'sec', 'ext', 'ods', 'mart'];

/** Object mix per 10 generated nodes: 5 tables, 3 views, 2 procedures. */
const TYPE_CYCLE: ObjectType[] = ['table', 'table', 'view', 'table', 'procedure', 'table', 'view', 'table', 'view', 'procedure'];

function emptyTypeCounts(): Record<ObjectType, number> {
  return { table: 0, view: 0, procedure: 0, function: 0, external: 0 };
}

/**
 * Builds a lineage model of exactly `nodeCount` objects with a deterministic dependency shape.
 *
 * @remarks
 * Every node after the first takes two upstream dependencies at fixed strides, giving an average
 * degree near 2.5 and a graph that is connected in one component — the shape that makes traversal
 * and layout do real work. Strides are coprime with the schema count so edges cross schemas rather
 * than forming isolated per-schema clusters.
 *
 * @param nodeCount - Number of objects to generate.
 * @returns A model with nodes, edges, schemas, catalog, and neighbor index fully populated.
 */
export function buildLargeModel(nodeCount: number): DatabaseModel {
  const nodes: LineageNode[] = [];
  const catalog: Record<string, CatalogEntry> = {};
  const schemaCounts = new Map<string, { count: number; types: Record<ObjectType, number> }>();

  for (let i = 0; i < nodeCount; i++) {
    const schema = SCHEMAS[i % SCHEMAS.length];
    const type = TYPE_CYCLE[i % TYPE_CYCLE.length];
    const name = `${type === 'table' ? 'Tbl' : type === 'view' ? 'Vw' : 'Sp'}${String(i).padStart(4, '0')}`;
    const id = `[${schema}].[${name.toLowerCase()}]`;
    nodes.push({ id, schema, name, fullName: `[${schema}].[${name}]`, type });
    catalog[id] = { schema, name, type };

    let entry = schemaCounts.get(schema);
    if (!entry) {
      entry = { count: 0, types: emptyTypeCounts() };
      schemaCounts.set(schema, entry);
    }
    entry.count++;
    entry.types[type]++;
  }

  const edges: LineageEdge[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < nodeCount; i++) {
    for (const stride of [1, 7]) {
      const sourceIndex = i - stride;
      if (sourceIndex < 0) continue;
      const source = nodes[sourceIndex].id;
      const target = nodes[i].id;
      const key = `${source}->${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target, type: nodes[i].type === 'procedure' ? 'exec' : 'body' });
    }
  }

  const neighborIndex: NeighborIndex = {};
  for (const node of nodes) neighborIndex[node.id] = { in: [], out: [] };
  for (const edge of edges) {
    neighborIndex[edge.source].out.push(edge.target);
    neighborIndex[edge.target].in.push(edge.source);
  }

  const schemas: SchemaInfo[] = [...schemaCounts.entries()]
    .map(([name, entry]) => ({ name, nodeCount: entry.count, types: entry.types }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { nodes, edges, schemas, catalog, neighborIndex, source: 'dacpac' };
}
