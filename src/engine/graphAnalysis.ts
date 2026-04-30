/**
 * @module GraphAnalysis
 * Provides advanced graph-theoretic analysis functions for the database schema graph.
 *
 * This module leverages `graphology` to perform structural investigations, including:
 * - Neighbor discovery (connected schemas).
 * - Island detection (isolated subgraphs).
 * - Hub analysis (highly connected nodes).
 * - Orphan detection (disconnected nodes).
 * - Longest dependency path calculation.
 * - Cycle detection (bidirectional or circular dependencies).
 * - External reference identification (cross-database or file-based dependencies).
 */

import Graph from 'graphology';
import { connectedComponents, stronglyConnectedComponents } from 'graphology-components';
import { DEFAULT_CONFIG, type AnalysisType, type AnalysisResult, type AnalysisGroup, type AnalysisConfig, type DatabaseModel } from './types';

/**
 * Discovers all schemas that have at least one edge connecting to a node in the target schema.
 * Uses the pre-built `neighborIndex` for O(NodesInSchema * Degree) performance.
 *
 * @param model - The complete database model.
 * @param schema - The target schema name.
 * @returns A set of schema names connected to the target schema (includes the target schema).
 */
export function getNeighborSchemas(model: DatabaseModel, schema: string): Set<string> {
  const neighborSchemas = new Set<string>([schema]);
  
  const focusNodes = model.nodes.filter(n => n.schema === schema);
  
  for (const node of focusNodes) {
    const neighbors = model.neighborIndex[node.id];
    if (!neighbors) continue;
    
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
export function analyzeLongestPath(graph: Graph, minNodes: number = 5, maxChains: number = DEFAULT_CONFIG.maxNodes): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'longest-path', groups: [], summary: 'No nodes in graph' };
  }

  const depth = new Map<string, number>();
  const successor = new Map<string, string>();
  const visiting = new Set<string>();

  function dfsLP(node: string): number {
    if (depth.has(node)) return depth.get(node)!;
    if (visiting.has(node)) return 0;
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

  const roots: Array<{ id: string; depth: number }> = [];
  graph.forEachNode((id) => {
    const d = depth.get(id) || 0;
    if (d > 0 && graph.inDegree(id) === 0) {
      roots.push({ id, depth: d });
    }
  });

  if (roots.length === 0) {
    graph.forEachNode((id) => {
      const d = depth.get(id) || 0;
      if (d > 0) roots.push({ id, depth: d });
    });
  }

  roots.sort((a, b) => b.depth - a.depth);

  const chains: Array<{ nodeIds: string[]; length: number }> = [];
  const seenEndpoints = new Set<string>();

  for (const root of roots) {
    const chain: string[] = [root.id];
    let cur = root.id;
    const visited = new Set<string>([cur]);
    while (successor.has(cur)) {
      cur = successor.get(cur)!;
      if (visited.has(cur)) break;
      visited.add(cur);
      chain.push(cur);
    }

    const endNode = chain[chain.length - 1];
    if (seenEndpoints.has(endNode)) continue;
    seenEndpoints.add(endNode);

    if (chain.length < minNodes) continue;
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
 * @param maxNodes - Safety limit for graph exploration.
 * @returns The resulting analysis report.
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
