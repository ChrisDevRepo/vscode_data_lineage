import { groupByWeaklyConnected } from './unionFind';

/** Minimal node shape for rendered-connectivity analysis, free of React Flow types. */
export interface RenderConnectivityNode {
  /** React Flow node id. */
  id: string;
  /** Human-readable label (schema name for clusters, object name otherwise). */
  label?: string;
}

/** Minimal directed edge shape for rendered-connectivity analysis. */
export interface RenderConnectivityEdge {
  source: string;
  target: string;
}

/** A weakly-connected group of rendered nodes. */
export interface RenderComponent {
  size: number;
  /** Member labels (falls back to id when no label), sorted ascending. */
  nodes: string[];
}

/**
 * Connectivity of the graph currently on screen, computed from the actual rendered React Flow
 * nodes/edges so the debug dump reflects exactly what the user sees, including whether clusters are
 * joined or orphaned. Bounded by `renderLimit`, so always cheap.
 */
export interface RenderConnectivity {
  nodeCount: number;
  edgeCount: number;
  /** Number of weakly-connected components. */
  componentCount: number;
  /** Components, largest first; capped to keep the dump compact. */
  components: RenderComponent[];
  /** Labels of nodes with no incident edge, sorted ascending. */
  isolatedNodes: string[];
}

/** Largest individual-component listings kept verbatim in the summary. */
const MAX_COMPONENTS_LISTED = 12;
/** Member labels kept per listed component before truncating. */
const MAX_MEMBERS_PER_COMPONENT = 25;

/**
 * Summarizes the connectivity of the rendered graph: component count, the largest components and
 * isolated node labels. Directed edges are treated as undirected for grouping.
 */
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

  const groups = groupByWeaklyConnected(nodes, knownEdges, (n) => n.id, (n) => labelOf.get(n.id)!);

  const components: RenderComponent[] = groups
    .slice(0, MAX_COMPONENTS_LISTED)
    .map((members) => ({
      size: members.length,
      nodes: members.length > MAX_MEMBERS_PER_COMPONENT
        ? [...members.slice(0, MAX_MEMBERS_PER_COMPONENT), `… +${members.length - MAX_MEMBERS_PER_COMPONENT} more`]
        : members,
    }));

  const isolatedNodes = nodes
    .filter((n) => (degree.get(n.id) ?? 0) === 0)
    .map((n) => labelOf.get(n.id)!)
    .sort((a, b) => a.localeCompare(b));

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    componentCount: groups.length,
    components,
    isolatedNodes,
  };
}

/**
 * Renders a {@link RenderConnectivity} as the debug dump's `RENDERED CONNECTIVITY` block: indented,
 * no trailing newline.
 */
export function formatRenderConnectivity(conn: RenderConnectivity): string {
  const lines: string[] = [];
  lines.push(`  Rendered: ${conn.nodeCount} nodes, ${conn.edgeCount} edges`);
  lines.push(`  Components: ${conn.componentCount}`);
  conn.components.forEach((c, i) => {
    lines.push(`  [${i + 1}] ${c.size} node(s): ${c.nodes.join(', ')}`);
  });
  if (conn.componentCount > conn.components.length) {
    lines.push(`  … +${conn.componentCount - conn.components.length} more component(s)`);
  }
  if (conn.isolatedNodes.length > 0) {
    lines.push(`  Isolated (no edges): ${conn.isolatedNodes.join(', ')}`);
  }
  return lines.join('\n');
}
