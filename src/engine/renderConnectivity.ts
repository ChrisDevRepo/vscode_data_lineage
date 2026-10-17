import { groupByWeaklyConnected } from './unionFind';

/** Minimal node shape for rendered-connectivity analysis. */
export interface RenderConnectivityNode {
  /** React Flow node id. */
  id: string;
  /** Human-readable label (schema name for clusters, object name otherwise). */
  label?: string;
}

/** Minimal directed edge shape for rendered-connectivity analysis. */
export interface RenderConnectivityEdge {
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
}

/** Connectivity of the graph currently on screen. */
export interface RenderConnectivity {
  /** Rendered node count. */
  nodeCount: number;
  /** Rendered edge count. */
  edgeCount: number;
  /** Number of weakly-connected components. */
  componentCount: number;
  /** Labels of nodes with no incident edge, sorted ascending. */
  isolatedNodes: string[];
}

/** Summarizes the connectivity of the rendered graph. */
export function summarizeRenderedConnectivity(
  nodes: readonly RenderConnectivityNode[],
  edges: readonly RenderConnectivityEdge[],
): RenderConnectivity {
  const labelOf = new Map<string, string>();
  for (const node of nodes) labelOf.set(node.id, node.label?.trim() || node.id);

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);

  const knownEdges: Array<readonly [string, string]> = [];
  for (const edge of edges) {
    if (!labelOf.has(edge.source) || !labelOf.has(edge.target)) continue;
    knownEdges.push([edge.source, edge.target]);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const componentCount = groupByWeaklyConnected(nodes, knownEdges, (n) => n.id).length;

  const isolatedNodes = nodes
    .filter((n) => (degree.get(n.id) ?? 0) === 0)
    .map((n) => labelOf.get(n.id)!)
    .sort((a, b) => a.localeCompare(b));

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    componentCount,
    isolatedNodes,
  };
}

/** Renders a {@link RenderConnectivity} as the count lines in the debug dump. */
export function formatRenderConnectivity(conn: RenderConnectivity): string {
  return [
    `  Rendered: ${conn.nodeCount} nodes, ${conn.edgeCount} edges`,
    `  Components: ${conn.componentCount}`,
    `  Isolated: ${conn.isolatedNodes.length}`,
  ].join('\n');
}
