import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';
import type { AnalysisResult, AnalysisGroup, AnalysisConfig } from './types';

// ─── Islands (Connected Components) ─────────────────────────────────────────

export function analyzeIslands(graph: Graph, maxSize: number): AnalysisResult {
  if (graph.order === 0) {
    return { type: 'islands', groups: [], summary: 'No nodes in graph' };
  }

  let components = connectedComponents(graph);

  // Sort by size ascending (smallest islands first)
  components.sort((a, b) => a.length - b.length);

  // Filter by max size if configured (0 = show all)
  if (maxSize > 0) {
    components = components.filter(c => c.length <= maxSize);
  }

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

  const suffix = maxSize > 0 ? ` (max ${maxSize} nodes)` : '';
  return {
    type: 'islands',
    groups,
    summary: `${groups.length} island${groups.length !== 1 ? 's' : ''}${suffix}`,
  };
}

// ─── Hubs (High-Degree Nodes) ───────────────────────────────────────────────

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

// ─── Orphans (Isolated Nodes with degree 0) ─────────────────────────────────

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

// ─── Dispatch ───────────────────────────────────────────────────────────────

export function runAnalysis(graph: Graph, type: 'islands' | 'hubs' | 'orphans', analysisConfig: AnalysisConfig): AnalysisResult {
  switch (type) {
    case 'islands': return analyzeIslands(graph, analysisConfig.islandMaxSize);
    case 'hubs': return analyzeHubs(graph, analysisConfig.hubMinDegree);
    case 'orphans': return analyzeOrphans(graph);
  }
}
