/**
 * Minimal node shape for rendered-connectivity analysis.
 *
 * @remarks
 * Decoupled from React Flow types so the helper stays pure and unit-testable.
 */
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

/** A weakly-connected group of rendered nodes. */
export interface RenderComponent {
  /** Number of nodes in the component. */
  size: number;
  /** Member labels (falls back to id when no label), sorted ascending. */
  nodes: string[];
}

/**
 * Connectivity of the graph currently on screen.
 *
 * @remarks
 * Computed from the actual rendered React Flow nodes/edges so the debug dump
 * reflects exactly what the user sees — including whether clusters are joined
 * or orphaned. Bounded by `renderLimit`, so always cheap.
 */
export interface RenderConnectivity {
  /** Rendered node count. */
  nodeCount: number;
  /** Rendered edge count. */
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

class UnionFind {
  private parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    let root = key;
    while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root)!;
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Summarizes the connectivity of the rendered graph.
 *
 * @param nodes - Rendered nodes (id + optional label).
 * @param edges - Rendered directed edges, treated as undirected for grouping.
 *
 * @returns Component count, the largest components, and isolated node labels.
 */
export function summarizeRenderedConnectivity(
  nodes: readonly RenderConnectivityNode[],
  edges: readonly RenderConnectivityEdge[],
): RenderConnectivity {
  const labelOf = new Map<string, string>();
  for (const node of nodes) labelOf.set(node.id, node.label?.trim() || node.id);

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);

  const uf = new UnionFind();
  for (const node of nodes) uf.add(node.id);
  for (const edge of edges) {
    // Edges may reference endpoints not in the node set defensively; only group known ones.
    if (!labelOf.has(edge.source) || !labelOf.has(edge.target)) continue;
    uf.union(edge.source, edge.target);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = uf.find(node.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(labelOf.get(node.id)!);
  }

  const components: RenderComponent[] = [...groups.values()]
    .map((members) => ({ size: members.length, nodes: members.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.size - a.size || a.nodes[0].localeCompare(b.nodes[0]))
    .slice(0, MAX_COMPONENTS_LISTED)
    .map((c) => ({
      size: c.size,
      nodes: c.nodes.length > MAX_MEMBERS_PER_COMPONENT
        ? [...c.nodes.slice(0, MAX_MEMBERS_PER_COMPONENT), `… +${c.nodes.length - MAX_MEMBERS_PER_COMPONENT} more`]
        : c.nodes,
    }));

  const isolatedNodes = nodes
    .filter((n) => (degree.get(n.id) ?? 0) === 0)
    .map((n) => labelOf.get(n.id)!)
    .sort((a, b) => a.localeCompare(b));

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    componentCount: groups.size,
    components,
    isolatedNodes,
  };
}

/**
 * Renders a {@link RenderConnectivity} as the `RENDERED CONNECTIVITY` block in
 * the debug dump.
 *
 * @param conn - The rendered-connectivity summary to format.
 *
 * @returns Indented multi-line text (no trailing newline).
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
