import Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';

/**
 * Build a connection-only directed graphology graph for AI BFS.
 * No Dagre positions, no React Flow — purely topology.
 * Kept separate from graphBuilder.ts which owns the visual graph + layout.
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
