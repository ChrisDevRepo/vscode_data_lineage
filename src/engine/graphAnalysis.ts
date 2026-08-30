/**
 * @module GraphAnalysis
 * Provides advanced graph-theoretic analysis functions for the database schema graph.
 *
 * This module leverages `graphology` to perform structural investigations, including:
 * - Island detection (isolated subgraphs).
 * - Hub analysis (highly connected nodes).
 * - Orphan detection (disconnected nodes).
 * - Longest dependency path calculation.
 * - Cycle detection (bidirectional or circular dependencies).
 * - External reference identification (cross-database or file-based dependencies).
 */

import Graph from 'graphology';
import { connectedComponents, stronglyConnectedComponents } from 'graphology-components';
import { bidirectional } from 'graphology-shortest-path';
import { DEFAULT_CONFIG, type AnalysisType, type AnalysisResult, type AnalysisGroup, type AnalysisConfig } from './types';

/**
 * Detects isolated subgraphs (islands) that are disconnected from the rest of the graph.
 *
 * @param graph - The graph instance.
 * @param maxSize - Maximum node count for a component to be considered an "island".
 * @returns Result object containing the discovered island groups.
 */
export function analyzeIslands(graph: Graph, maxSize: number): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'islands', groups: [], summary: 'No nodes in graph' };
  }

  let components = connectedComponents(graph);
  components.sort((a, b) => a.length - b.length);
  components = components.filter(c => c.length >= 2 && c.length <= maxSize);

  const groups: AnalysisGroup[] = components.map((nodeIds, i) => {
    const schemas = new Set<string>();
    for (const id of nodeIds) {
      schemas.add(graph.getNodeAttribute(id, 'schema'));
    }
    return {
      id: `island-${i}`,
      label: `Island ${i + 1}`,
      nodeIds,
      meta: {
        nodes: nodeIds.length,
        schemas: [...schemas].join(', '),
      },
    };
  });

  return {
    type: 'islands',
    groups,
    summary: `${groups.length} island${groups.length !== 1 ? 's' : ''} (max ${maxSize} nodes)`,
  };
}

/**
 * Identifies high-degree "hub" nodes that serve as central points in the graph.
 *
 * @param graph - The graph instance.
 * @param minDegree - Minimum degree threshold for a node to be classified as a hub.
 * @returns Result object detailing the detected hubs.
 */
export function analyzeHubs(graph: Graph, minDegree: number): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'hubs', groups: [], summary: 'No nodes in graph' };
  }

  const nodesByDegree: Array<{ id: string; degree: number; inDegree: number; outDegree: number }> = [];
  graph.forEachNode((id) => {
    const degree = graph.degree(id);
    if (degree >= minDegree) {
      nodesByDegree.push({
        id,
        degree,
        inDegree: graph.inDegree(id),
        outDegree: graph.outDegree(id),
      });
    }
  });

  nodesByDegree.sort((a, b) => b.degree - a.degree);

  const groups: AnalysisGroup[] = nodesByDegree.map((hub) => {
    const schema = graph.getNodeAttribute(hub.id, 'schema');
    const name = graph.getNodeAttribute(hub.id, 'name');
    const type = graph.getNodeAttribute(hub.id, 'type');
    return {
      id: `hub-${hub.id}`,
      label: `[${schema}].${name}`,
      nodeIds: [hub.id],
      meta: {
        type,
        degree: hub.degree,
        inDegree: hub.inDegree,
        outDegree: hub.outDegree,
      },
    };
  });

  return {
    type: 'hubs',
    groups,
    summary: `${groups.length} hub${groups.length !== 1 ? 's' : ''} with ${minDegree}+ connections`,
  };
}

/**
 * Finds orphan nodes that have no inbound or outbound connections.
 *
 * @param graph - The graph instance.
 * @returns Result object grouping orphans by schema and object type.
 */
export function analyzeOrphans(graph: Graph): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'orphans', groups: [], summary: 'No nodes in graph' };
  }

  const orphanIds: string[] = [];
  graph.forEachNode((id) => {
    if (graph.degree(id) === 0) {
      orphanIds.push(id);
    }
  });

  const buckets = new Map<string, string[]>();
  for (const id of orphanIds) {
    const schema = graph.getNodeAttribute(id, 'schema');
    const type = graph.getNodeAttribute(id, 'type');
    const key = `${schema}/${type}`;
    const arr = buckets.get(key) || [];
    arr.push(id);
    buckets.set(key, arr);
  }

  const sortedKeys = [...buckets.keys()].sort(
    (a, b) => (buckets.get(b)?.length || 0) - (buckets.get(a)?.length || 0)
  );

  const groups: AnalysisGroup[] = sortedKeys.map((key) => {
    const nodeIds = buckets.get(key)!;
    const [schema, type] = key.split('/');
    return {
      id: `orphan-${key}`,
      label: `[${schema}] ${type}s`,
      nodeIds,
      meta: {
        schema,
        type,
        count: nodeIds.length,
      },
    };
  });

  return {
    type: 'orphans',
    groups,
    summary: `${orphanIds.length} orphan node${orphanIds.length !== 1 ? 's' : ''} in ${groups.length} group${groups.length !== 1 ? 's' : ''}`,
  };
}

/**
 * Calculates the longest non-cyclic dependency chains in the graph.
 *
 * @param graph - The graph instance.
 * @param minNodes - Minimum nodes required in a chain to be reported.
 * @param maxChains - Maximum number of chains to return.
 * @returns Result object containing the discovered dependency chains.
 */
/**
 * Default number of dependency chains {@link analyzeLongestPath} reports.
 *
 * @remarks
 * A chain count, not a node count. Chains are emitted deepest first, so the cap drops the shallow
 * tail of the ranking and never displaces the deepest chain. The previous default reused
 * `DEFAULT_CONFIG.maxNodes`, which is a node-count safety limit — three orders of magnitude too
 * loose for a per-chain group list, and a payload risk on a warehouse with many staging roots.
 */
const DEFAULT_MAX_CHAINS = 25;

/**
 * Condensed view of the graph: one vertex per strongly connected component.
 *
 * @remarks
 * A condensation is acyclic by construction, which is what makes the depth DP in
 * {@link analyzeLongestPath} exact.
 */
interface Condensation {
  /** Member node ids per component, indexed by component number. */
  components: string[][];
  /** Component successors, each remembering the `[tail, head]` node pair that realises the edge. */
  successors: Map<number, Map<number, [string, string]>>;
  /** Component in-degree in the condensation. */
  inDegree: number[];
}

/** Condenses each strongly connected component of `graph` to a single vertex. */
function condense(graph: Graph): Condensation {
  const components = stronglyConnectedComponents(graph);
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => {
    for (const id of members) componentOf.set(id, index);
  });

  const successors = new Map<number, Map<number, [string, string]>>();
  const inDegree = new Array<number>(components.length).fill(0);
  graph.forEachEdge((_edge, _attrs, source, target) => {
    const from = componentOf.get(source)!;
    const to = componentOf.get(target)!;
    if (from === to) return;
    let edges = successors.get(from);
    if (!edges) {
      edges = new Map();
      successors.set(from, edges);
    }
    if (edges.has(to)) return;
    edges.set(to, [source, target]);
    inDegree[to]++;
  });

  return { components, successors, inDegree };
}

/**
 * Walks one component from `entry` to `exit`.
 *
 * @remarks
 * A path between two members of a strongly connected component cannot leave it — a node reachable
 * from `entry` that also reaches `exit` reaches `entry` too, so it belongs to the same component.
 * The graph-wide search is therefore already confined to the component.
 */
function walkComponent(graph: Graph, members: readonly string[], entry: string, exit: string): string[] {
  if (members.length === 1 || entry === exit) return [entry];
  return bidirectional(graph, entry, exit) ?? [entry];
}

/**
 * Walks one component from `entry` to whichever member sits farthest from it.
 *
 * @remarks
 * One forward BFS from `entry` measures every member's shortest-path length, then one bidirectional
 * search reconstructs the winning walk — linear in the component instead of one search per member.
 * BFS distances to members are measured inside the component however far the search ranges: a path
 * from `entry` to a member cannot leave it (see {@link walkComponent}). Selection keeps the previous
 * tie-break — the first member, in `members` order, whose distance strictly exceeds the best so far.
 * An `entry` with no path to any other member stays the whole tail.
 */
function walkComponentTail(graph: Graph, members: readonly string[], entry: string): string[] {
  if (members.length === 1) return [entry];
  const dist = new Map<string, number>([[entry, 0]]);
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    graph.forEachOutNeighbor(node, (neighbor) => {
      if (dist.has(neighbor)) return;
      dist.set(neighbor, dist.get(node)! + 1);
      queue.push(neighbor);
    });
  }
  let exit = entry;
  let best = 0;
  for (const member of members) {
    if (member === entry) continue;
    const memberDist = dist.get(member);
    if (memberDist !== undefined && memberDist > best) {
      best = memberDist;
      exit = member;
    }
  }
  if (exit === entry) return [entry];
  return bidirectional(graph, entry, exit) ?? [entry];
}

/** Expands a component chain rooted at `root` back into an ordered list of real node ids. */
function expandChain(graph: Graph, condensation: Condensation, nextOf: readonly number[], root: number): string[] {
  const { components, successors } = condensation;
  const chain: string[] = [];
  let current = root;
  let entry = components[current][0];

  for (;;) {
    const next = nextOf[current];
    if (next === -1) {
      chain.push(...walkComponentTail(graph, components[current], entry));
      return chain;
    }
    const [exit, head] = successors.get(current)!.get(next)!;
    chain.push(...walkComponent(graph, components[current], entry, exit));
    entry = head;
    current = next;
  }
}

export function analyzeLongestPath(graph: Graph, minNodes = 5, maxChains: number = DEFAULT_MAX_CHAINS): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'longest-path', groups: [], summary: 'No nodes in graph' };
  }

  const condensation = condense(graph);
  const { components, successors, inDegree } = condensation;

  // Kahn ordering of the condensation, then the depth DP in reverse. Both are iterative, so a chain
  // spanning thousands of objects cannot exhaust the call stack.
  const remaining = [...inDegree];
  const order: number[] = [];
  for (let i = 0; i < components.length; i++) if (remaining[i] === 0) order.push(i);
  for (let i = 0; i < order.length; i++) {
    for (const to of successors.get(order[i])?.keys() ?? []) {
      if (--remaining[to] === 0) order.push(to);
    }
  }

  const depth = new Array<number>(components.length).fill(0);
  const nextOf = new Array<number>(components.length).fill(-1);
  for (let i = order.length - 1; i >= 0; i--) {
    const from = order[i];
    for (const to of successors.get(from)?.keys() ?? []) {
      if (depth[to] + 1 > depth[from]) {
        depth[from] = depth[to] + 1;
        nextOf[from] = to;
      }
    }
  }

  const roots = order.filter((component) => inDegree[component] === 0);

  // Component-hop depth only ranks roots correctly when every component is a singleton; a root
  // whose path crosses a multi-node strongly-connected component gets the same "+1" as one that
  // crosses only singletons, so ranking (and capping) by that count can drop a genuinely longer
  // real-node chain. Expand every root's chain first and rank by the real node count instead —
  // the number of roots is bounded by the graph's entry points, not by maxChains.
  const expandedChains = roots.map((root) => expandChain(graph, condensation, nextOf, root));
  expandedChains.sort((a, b) => b.length - a.length);

  const chains: Array<{ nodeIds: string[]; length: number }> = [];
  const seenEndpoints = new Set<string>();

  for (const nodeIds of expandedChains) {
    const endNode = nodeIds[nodeIds.length - 1];
    if (seenEndpoints.has(endNode)) continue;
    seenEndpoints.add(endNode);

    if (nodeIds.length < minNodes) continue;
    chains.push({ nodeIds, length: nodeIds.length - 1 });
    if (chains.length >= maxChains) break;
  }

  const groups: AnalysisGroup[] = chains.map((chain, i) => {
    const startId = chain.nodeIds[0];
    const endId = chain.nodeIds[chain.nodeIds.length - 1];
    const startName = graph.getNodeAttribute(startId, 'name');
    const endName = graph.getNodeAttribute(endId, 'name');
    return {
      id: `chain-${i}`,
      label: `Chain ${i + 1} (${chain.length} steps)`,
      nodeIds: chain.nodeIds,
      meta: { depth: chain.length, from: startName, to: endName },
    };
  });

  const maxDepth = chains.length > 0 ? chains[0].length : 0;
  return {
    type: 'longest-path',
    groups,
    summary: maxDepth > 0
      ? `Deepest chain: ${maxDepth} step${maxDepth !== 1 ? 's' : ''} (${chains.length} chain${chains.length !== 1 ? 's' : ''})`
      : 'No dependency chains found',
  };
}

/**
 * Detects circular dependencies (Strongly Connected Components of size 2+).
 *
 * @param graph - The graph instance.
 * @returns Result object detailing the detected cycles.
 */
export function analyzeCycles(graph: Graph): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'cycles', groups: [], summary: 'No nodes in graph' };
  }

  const sccs = stronglyConnectedComponents(graph);
  const cycleComponents = sccs.filter(scc => scc.length >= 2);
  cycleComponents.sort((a, b) => b.length - a.length);

  const groups: AnalysisGroup[] = cycleComponents.map((nodeIds, i) => {
    const schemas = new Set<string>();
    for (const id of nodeIds) {
      schemas.add(graph.getNodeAttribute(id, 'schema'));
    }
    return {
      id: `cycle-${i}`,
      label: nodeIds.length === 2
        ? `Bidirectional: ${graph.getNodeAttribute(nodeIds[0], 'name')} ↔ ${graph.getNodeAttribute(nodeIds[1], 'name')}`
        : `Cycle (${nodeIds.length} nodes)`,
      nodeIds,
      meta: { count: nodeIds.length, schemas: [...schemas].join(', ') },
    };
  });

  const totalNodes = cycleComponents.reduce((sum, scc) => sum + scc.length, 0);
  return {
    type: 'cycles',
    groups,
    summary: totalNodes === 0
      ? 'No cycles detected — graph is a DAG'
      : `${groups.length} cycle${groups.length !== 1 ? 's' : ''} (${totalNodes} nodes)`,
  };
}

/**
 * Identifies external references (files or cross-database links) within the graph.
 *
 * @param graph - The graph instance.
 * @returns Result object grouping external references by kind.
 */
export function analyzeExternalRefs(graph: Graph): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'external-refs', groups: [], summary: 'No nodes in graph' };
  }

  const fileGroups: AnalysisGroup[] = [];
  const dbGroups: AnalysisGroup[] = [];

  graph.forEachNode((id) => {
    const externalType = graph.getNodeAttribute(id, 'externalType');
    if (externalType !== 'file' && externalType !== 'db') return;

    const name: string = graph.getNodeAttribute(id, 'name') ?? id;
    const externalDatabase: string = graph.getNodeAttribute(id, 'externalDatabase') ?? '';
    const externalUrl: string = graph.getNodeAttribute(id, 'externalUrl') ?? '';

    const neighborIds: string[] = [];
    graph.forEachNeighbor(id, (neighbor) => neighborIds.push(neighbor));

    const nodeIds = [id, ...neighborIds];

    if (externalType === 'file') {
      const label = externalUrl ? externalUrl.split('/').filter(Boolean).pop() ?? name : name;
      fileGroups.push({
        id: `extref-${id}`,
        label,
        nodeIds,
        meta: { kind: 'file', database: '', neighborCount: neighborIds.length },
      });
    } else {
      const label = externalDatabase ? `${externalDatabase} / ${name}` : name;
      dbGroups.push({
        id: `extref-${id}`,
        label,
        nodeIds,
        meta: { kind: 'db', database: externalDatabase, neighborCount: neighborIds.length },
      });
    }
  });

  fileGroups.sort((a, b) => a.label.localeCompare(b.label));
  dbGroups.sort((a, b) => {
    const dbCmp = String(a.meta!.database).localeCompare(String(b.meta!.database));
    return dbCmp !== 0 ? dbCmp : a.label.localeCompare(b.label);
  });

  const groups = [...fileGroups, ...dbGroups];
  const filePart = fileGroups.length > 0 ? `${fileGroups.length} file source${fileGroups.length !== 1 ? 's' : ''}` : '';
  const dbPart = dbGroups.length > 0 ? `${dbGroups.length} cross-DB ref${dbGroups.length !== 1 ? 's' : ''}` : '';
  const summary = [filePart, dbPart].filter(Boolean).join(', ') || 'No external refs found';

  return { type: 'external-refs', groups, summary };
}

/**
 * Unified entry point to run a specific analysis type on the graph.
 *
 * @param graph - The graphology instance.
 * @param type - Type of analysis to perform.
 * @param analysisConfig - Analysis-specific thresholds.
 * @param maxNodes - Upper bound on island size, applied as the tighter of it and `islandMaxSize`.
 *   It is a node count and bounds no other analysis; longest-path chain count is capped by
 *   {@link DEFAULT_MAX_CHAINS}.
 * @returns The resulting analysis report.
 */
export function runAnalysis(graph: Graph, type: AnalysisType, analysisConfig: AnalysisConfig, maxNodes: number = DEFAULT_CONFIG.maxNodes): AnalysisResult {
  switch (type) {
    case 'islands': return analyzeIslands(graph, Math.min(analysisConfig.islandMaxSize, maxNodes));
    case 'hubs': return analyzeHubs(graph, analysisConfig.hubMinDegree);
    case 'orphans': return analyzeOrphans(graph);
    case 'longest-path': return analyzeLongestPath(graph, analysisConfig.longestPathMinNodes);
    case 'cycles': return analyzeCycles(graph);
    case 'external-refs': return analyzeExternalRefs(graph);
  }
}
