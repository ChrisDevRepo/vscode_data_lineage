/** Shared model fixture builders for backend and runtime unit tests. */
import Graph from 'graphology';
import type {
  DatabaseModel,
  LineageEdge,
  LineageNode,
  ObjectType,
  SchemaInfo,
} from '../../../src/engine/types';

/** Build a LineageNode fixture. `fullName` defaults to `id` — these synthetic graphs use flat, already-qualified ids for both — unless explicitly overridden. */
export function makeNode(
  node: Omit<LineageNode, 'fullName'> & Partial<Pick<LineageNode, 'fullName'>>,
): LineageNode {
  return { fullName: node.id, ...node };
}

/** Build a `LineageEdge[]` fixture from `[source, target]` pairs. Every synthetic edge is tagged `'body'`; callers supply explicit execution edges when testing calls. */
export function makeEdges(pairs: ReadonlyArray<readonly [string, string]>): LineageEdge[] {
  return pairs.map(([source, target]) => ({ source, target, type: 'body' }));
}

const ZERO_TYPE_COUNTS: Record<ObjectType, number> = {
  table: 0,
  view: 0,
  procedure: 0,
  function: 0,
  external: 0,
};

/** Build a minimal `SchemaInfo[]` fixture from bare schema names. `nodeCount`/`types` default to zero; callers fill them when testing schema counts. */
export function makeSchemas(names: ReadonlyArray<string>): SchemaInfo[] {
  return names.map((name) => ({ name, nodeCount: 0, types: { ...ZERO_TYPE_COUNTS } }));
}

/** Build a full `DatabaseModel` fixture from nodes + `[source, target]` edge pairs + schema names. `catalog`/`neighborIndex` default to empty (see module doc). */
export function makeModel(
  nodes: LineageNode[],
  edgePairs: ReadonlyArray<readonly [string, string]>,
  schemaNames: ReadonlyArray<string>,
  dbPlatform = 'SQL Server',
): DatabaseModel {
  return {
    nodes,
    edges: makeEdges(edgePairs),
    schemas: makeSchemas(schemaNames),
    catalog: {},
    neighborIndex: {},
    dbPlatform,
  };
}

/** Builds the normal model fixture with complete neighbor metadata for every declared edge. */
export function makeIndexedModel(
  nodes: LineageNode[],
  edgePairs: ReadonlyArray<readonly [string, string]>,
): DatabaseModel {
  const model = makeModel(nodes, edgePairs, [...new Set(nodes.map(node => node.schema))]);
  model.neighborIndex = Object.fromEntries(nodes.map(node => [node.id, { in: [] as string[], out: [] as string[] }]));
  for (const [from, to] of edgePairs) {
    model.neighborIndex[from].out.push(to);
    model.neighborIndex[to].in.push(from);
  }
  return model;
}

/** Build a directed graphology graph from nodes + edges (for synthetic test graphs) */
export function makeGraph(
  nodes: Array<{ id: string; schema?: string; name?: string; type?: string }>,
  edges: Array<[string, string]>
): Graph {
  const g = new Graph({ type: 'directed', multi: false });
  for (const n of nodes) {
    g.addNode(n.id, {
      schema: n.schema || 'dbo',
      name: n.name || n.id,
      type: n.type || 'table',
    });
  }
  for (const [s, t] of edges) {
    const key = `${s}→${t}`;
    if (!g.hasEdge(key)) {
      g.addEdgeWithKey(key, s, t, { type: 'body' });
    }
  }
  return g;
}
