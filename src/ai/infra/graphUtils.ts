import Graph from 'graphology';
import type { DatabaseModel } from '../../engine/types';

/**
 * Constructs a minimal, directed topology-only graph from a DatabaseModel.
 *
 * @remarks
 * This graph is optimized for algorithmic traversal (e.g., BFS/DFS) and does not include
 * layout information (Dagre/React Flow) or rich visual metadata. It is intentionally
 * decoupled from the primary `graphBuilder.ts` to ensure the AI's structural reasoning
 * is performed on a clean, performance-oriented model.
 *
 * @param model - The current database model containing nodes and edges extracted from DDL/Metadata.
 * @returns A directed `graphology` instance representing the logical dependencies of the model.
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

