/**
 * Snapshot accessors over a loaded {@link DatabaseModel} — the bare traversal graph, the id→node
 * map, and the per-node column/DDL reads.
 *
 * @remarks
 * Model-layer reads with no tool-layer dependency, so the navigation engine, the prompting layer
 * and the tools all reach them without importing across a layer boundary. Pure: no `vscode`, no
 * registry, no presentation.
 */
import Graph from 'graphology';
import type {
  ColumnDef,
  DatabaseModel,
  LineageNode,
  ObjectType,
} from '../../engine/types';
import { normalizeBodyScript } from '../../utils/sql';

/**
 * The two high-fidelity reads these accessors take from the engine's column store.
 *
 * @remarks
 * Declared structurally so the snapshot accessors state what they read instead of importing the
 * store implementation across the layer boundary; `ColumnStore` satisfies it as written.
 */
export interface NodeSnapshotStore {
  /** Stored column definitions for `nodeId`, or `undefined` when the store holds none. */
  getColumns(nodeId: string): ColumnDef[] | undefined;
  /** Stored DDL text for `nodeId`, or `undefined` when the store holds none. */
  getDdl(nodeId: string): string | undefined;
}

/**
 * Constructs a minimal, directed topology-only graph from a DatabaseModel.
 *
 * @remarks
 * Decoupled from `graphBuilder.ts` so the AI's structural reasoning runs on a clean,
 * performance-oriented model — no layout (Dagre/React Flow) or visual metadata.
 */
export function buildBareGraph(model: DatabaseModel): Graph {
  const graph = new Graph({ type: 'directed', multi: false });

  for (const node of model.nodes) {
    graph.addNode(node.id, { type: node.type, schema: node.schema });
  }

  for (const edge of model.edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      if (!graph.hasEdge(edge.source, edge.target)) {
        graph.addEdge(edge.source, edge.target, { type: edge.type });
      }
    }
  }

  return graph;
}

/**
 * Builds a lookup map for nodes by their ID.
 */
export function buildNodeMap(model: DatabaseModel): Map<string, LineageNode> {
  const m = new Map<string, LineageNode>();
  for (const n of model.nodes) m.set(n.id, n);
  return m;
}

/**
 * Retrieves the column definitions for a specific node, preferring the ColumnStore if available.
 */
export function getNodeColumns(
  nodeId: string, nodeMap: Map<string, LineageNode>,
  store?: NodeSnapshotStore,
): ColumnDef[] | undefined {
  return (typeof store?.getColumns === 'function' ? store.getColumns(nodeId) : undefined) ?? nodeMap.get(nodeId)?.columns;
}

/**
 * Retrieves the stored DDL for a specific node (blank lines dropped, tabs expanded).
 */
export function getNodeDdl(
  nodeId: string, nodeMap: Map<string, LineageNode>,
  store?: NodeSnapshotStore,
): string | undefined {
  const raw = (typeof store?.getDdl === 'function' ? store.getDdl(nodeId) : undefined) ?? nodeMap.get(nodeId)?.bodyScript;
  return raw ? normalizeBodyScript(raw) : undefined;
}

/**
 * Object types whose body is the source of lineage information — view / procedure / function.
 *
 * @remarks
 * Drives DDL-vs-columns selection in the hop focus node and search-target filtering in the DDL
 * search tool (`tools/tools.ts`), and bodied-node accounting in the navigation engine. Tables and
 * external references are intentionally excluded — they expose columns + foreign keys, not bodies.
 */
export const SCRIPT_TYPES: Set<ObjectType> = new Set(['view', 'procedure', 'function']);
