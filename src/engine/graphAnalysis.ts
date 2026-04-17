import Graph from 'graphology';
import { connectedComponents, stronglyConnectedComponents } from 'graphology-components';
import { DEFAULT_CONFIG, type AnalysisType, type AnalysisResult, type AnalysisGroup, type AnalysisConfig, type DatabaseModel } from './types';

/**
 * Computes all schemas that have at least one edge connecting to a node in the target schema.
 * Uses the pre-built `neighborIndex` for optimized O(NodesInSchema * Degree) performance.
 *
 * @param model - The complete database model containing nodes, catalog, and neighbor indices.
 * @param schema - The target schema name to find neighbors for.
 * @returns A set of schema names that are connected to the target schema, including the target schema itself.
 */
export function getNeighborSchemas(model: DatabaseModel, schema: string): Set<string> {
  const neighborSchemas = new Set<string>([schema]);
  
  // 1. Find all nodes belonging to the target schema
  const focusNodes = model.nodes.filter(n => n.schema === schema);
  
  // 2. For each node, look up its immediate neighbors in the index
  for (const node of focusNodes) {
    const neighbors = model.neighborIndex[node.id];
    if (!neighbors) continue;
    
    // Combine inbound and outbound neighbors
    const allNeighborIds = [...neighbors.in, ...neighbors.out];
    for (const nid of allNeighborIds) {
      const neighborMeta = model.catalog[nid];
      if (neighborMeta && neighborMeta.schema) {
        neighborSchemas.add(neighborMeta.schema);
      }
    }
  }
  
  return neighborSchemas;
}

/**
 * Analyzes the graph to find isolated subgraphs (islands) that have no connections to the main graph.
 * Discards isolated single nodes, considering an island to require at least 2 nodes up to `maxSize`.
 *
 * @param graph - The graphology instance representing the database schema.
 * @param maxSize - The maximum number of nodes an island can have to be included in the results.
 * @returns An `AnalysisResult` containing groups of nodes representing each island and a descriptive summary.
 */
export function analyzeIslands(graph: Graph, maxSize: number): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'islands', groups: [], summary: 'No nodes in graph' };
  }

  let components = connectedComponents(graph);

  // Sort by size ascending (smallest islands first)
  components.sort((a, b) => a.length - b.length);

  // Islands need 2+ nodes (single isolated nodes → Orphan analysis); filter by maxSize
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
 * Identifies highly connected nodes (hubs) in the graph based on a minimum degree threshold.
 * Hubs often represent critical tables or views with high structural importance.
 *
 * @param graph - The graphology instance to analyze.
 * @param minDegree - The minimum total degree (in-degree + out-degree) required for a node to be considered a hub.
 * @returns An `AnalysisResult` detailing the identified hubs, sorted by degree descending.
 */
export function analyzeHubs(graph: Graph, minDegree: number): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'hubs', groups: [], summary: 'No nodes in graph' };
  }

  // Collect nodes that meet the minimum degree threshold
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

  // Sort by degree descending
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
 * Detects orphan nodes in the graph, which are nodes completely disconnected from any other node (degree of 0).
 * Orphans are grouped by their schema and node type for easier review.
 *
 * @param graph - The graphology instance to analyze.
 * @returns An `AnalysisResult` grouping orphan nodes by schema and type, along with a summary.
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

  // Group orphans by schema + type
  const buckets = new Map<string, string[]>();
  for (const id of orphanIds) {
    const schema = graph.getNodeAttribute(id, 'schema');
    const type = graph.getNodeAttribute(id, 'type');
    const key = `${schema}/${type}`;
    const arr = buckets.get(key) || [];
    arr.push(id);
    buckets.set(key, arr);
  }

  // Sort buckets by size descending
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
 * Computes the longest dependency chains in the graph using a memoized Depth-First Search (DFS).
 * It guards against cycles and returns chains that meet the minimum node count requirement.
 *
 * @param graph - The graphology instance representing dependencies.
 * @param minNodes - The minimum length of a path to be included in the results (default: 5).
 * @param maxChains - The maximum number of chains to return to bound performance/output size (default: `DEFAULT_CONFIG.maxNodes`).
 * @returns An `AnalysisResult` containing the longest non-cyclic dependency paths.
 */
export function analyzeLongestPath(graph: Graph, minNodes: number = 5, maxChains: number = DEFAULT_CONFIG.maxNodes): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'longest-path', groups: [], summary: 'No nodes in graph' };
  }

  // DFS + memoization: compute longest downstream depth for each node
  const depth = new Map<string, number>();
  const successor = new Map<string, string>();
  const visiting = new Set<string>();

  function dfsLP(node: string): number {
    if (depth.has(node)) return depth.get(node)!;
    if (visiting.has(node)) return 0; // cycle guard
    visiting.add(node);

    let maxDown = 0;
    let bestNext: string | null = null;

    graph.forEachOutNeighbor(node, (neighbor) => {
      const d = dfsLP(neighbor) + 1;
      if (d > maxDown) {
        maxDown = d;
        bestNext = neighbor;
      }
    });

    visiting.delete(node);
    depth.set(node, maxDown);
    if (bestNext) successor.set(node, bestNext);
    return maxDown;
  }

  graph.forEachNode((id) => dfsLP(id));

  // Collect root nodes and reconstruct chains from those with deepest paths
  const roots: Array<{ id: string; depth: number }> = [];
  graph.forEachNode((id) => {
    const d = depth.get(id) || 0;
    if (d > 0 && graph.inDegree(id) === 0) {
      roots.push({ id, depth: d });
    }
  });

  // If no true roots (cycles everywhere), fall back to nodes with highest depth
  if (roots.length === 0) {
    graph.forEachNode((id) => {
      const d = depth.get(id) || 0;
      if (d > 0) roots.push({ id, depth: d });
    });
  }

  roots.sort((a, b) => b.depth - a.depth);

  // Reconstruct chains, deduplicate by end-node
  const chains: Array<{ nodeIds: string[]; length: number }> = [];
  const seenEndpoints = new Set<string>();

  for (const root of roots) {
    const chain: string[] = [root.id];
    let cur = root.id;
    const visited = new Set<string>([cur]);
    while (successor.has(cur)) {
      cur = successor.get(cur)!;
      if (visited.has(cur)) break; // cycle in successor chain
      visited.add(cur);
      chain.push(cur);
    }

    const endNode = chain[chain.length - 1];
    if (seenEndpoints.has(endNode)) continue;
    seenEndpoints.add(endNode);

    if (chain.length < minNodes) continue; // skip short chains
    chains.push({ nodeIds: chain, length: chain.length - 1 });
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
 * Detects Strongly Connected Components (SCCs) of size 2 or greater, representing cycles in the graph.
 * Cycles typically indicate bidirectional dependencies or recursive reference patterns.
 *
 * @param graph - The graphology instance to analyze.
 * @returns An `AnalysisResult` outlining all detected cycles, sorted by the number of nodes involved.
 */
export function analyzeCycles(graph: Graph): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'cycles', groups: [], summary: 'No nodes in graph' };
  }

  // Each SCC of size ≥ 2 is a distinct cycle group
  const sccs = stronglyConnectedComponents(graph);
  const cycleComponents = sccs.filter(scc => scc.length >= 2);

  // Sort by size descending (largest cycles first)
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
 * Analyzes the graph to find nodes representing external references, such as linked databases or files.
 * Groups external references into file-based and database-based categories.
 *
 * @param graph - The graphology instance to analyze.
 * @returns An `AnalysisResult` detailing groups of external file and database references.
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
      // db: name is "schema.object", externalDatabase is the db name
      const label = externalDatabase ? `${externalDatabase} / ${name}` : name;
      dbGroups.push({
        id: `extref-${id}`,
        label,
        nodeIds,
        meta: { kind: 'db', database: externalDatabase, neighborCount: neighborIds.length },
      });
    }
  });

  // Sort file groups alphabetically, db groups by database then label
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
 * Serves as a unified dispatcher to run a specific structural analysis on the graph.
 *
 * @param graph - The graphology instance to analyze.
 * @param type - The type of analysis to execute (e.g., 'islands', 'hubs', 'orphans').
 * @param analysisConfig - The configuration parameters dictating thresholds for the analyses.
 * @param maxNodes - An optional upper bound for graph traversal or output limits (default: `DEFAULT_CONFIG.maxNodes`).
 * @returns The `AnalysisResult` generated by the corresponding specific analysis function.
 */
export function runAnalysis(graph: Graph, type: AnalysisType, analysisConfig: AnalysisConfig, maxNodes: number = DEFAULT_CONFIG.maxNodes): AnalysisResult {
  switch (type) {
    case 'islands': return analyzeIslands(graph, Math.min(analysisConfig.islandMaxSize, maxNodes));
    case 'hubs': return analyzeHubs(graph, analysisConfig.hubMinDegree);
    case 'orphans': return analyzeOrphans(graph);
    case 'longest-path': return analyzeLongestPath(graph, analysisConfig.longestPathMinNodes, maxNodes);
    case 'cycles': return analyzeCycles(graph);
    case 'external-refs': return analyzeExternalRefs(graph);
  }
}
