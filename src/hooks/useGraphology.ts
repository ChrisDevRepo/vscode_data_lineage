import { useState, useCallback } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { DacpacModel, FilterState, ExtensionConfig, DEFAULT_CONFIG } from '../engine/types';
import { buildGraph, getGraphMetrics } from '../engine/graphBuilder';
import { filterBySchemas } from '../engine/dacpacExtractor';

interface UseGraphologyReturn {
  flowNodes: FlowNode<CustomNodeData>[];
  flowEdges: FlowEdge[];
  graph: Graph | null;
  metrics: ReturnType<typeof getGraphMetrics> | null;
  buildFromModel: (model: DacpacModel, filter: FilterState, config?: ExtensionConfig) => void;
}

export function useGraphology(): UseGraphologyReturn {
  const [flowNodes, setFlowNodes] = useState<FlowNode<CustomNodeData>[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [metrics, setMetrics] = useState<ReturnType<typeof getGraphMetrics> | null>(null);

  const buildFromModel = useCallback((model: DacpacModel, filter: FilterState, config: ExtensionConfig = DEFAULT_CONFIG) => {
    // Apply schema filter (with configurable maxNodes)
    const filtered = filterBySchemas(model, filter.schemas, config.maxNodes);

    // Apply type filter
    const typeFilteredNodes = filtered.nodes.filter((n) => filter.types.has(n.type));
    const typeNodeIds = new Set(typeFilteredNodes.map((n) => n.id));
    const typeFiltered: DacpacModel = {
      ...filtered,
      nodes: typeFilteredNodes,
      edges: filtered.edges.filter((e) => typeNodeIds.has(e.source) && typeNodeIds.has(e.target)),
    };

    // Apply focus schema filter (exclusion patterns applied earlier in handleVisualize)
    const focusFiltered = applyFocusSchemaFilter(typeFiltered, filter.focusSchemas);

    // Apply isolation filter (hide orphan nodes with no edges)
    const isolationFiltered = applyIsolationFilter(focusFiltered, filter.hideIsolated);

    const result = buildGraph(isolationFiltered, config);
    setFlowNodes(result.flowNodes as FlowNode<CustomNodeData>[]);
    setFlowEdges(result.flowEdges);
    setGraph(result.graph);
    setMetrics(getGraphMetrics(result.graph));
  }, []);

  return { flowNodes, flowEdges, graph, metrics, buildFromModel };
}

// ─── Isolation Filter (hide orphan / degree-0 nodes) ─────────────────────────

function applyIsolationFilter(model: DacpacModel, hideIsolated: boolean): DacpacModel {
  if (!hideIsolated) return model;

  const connectedIds = new Set<string>();
  for (const e of model.edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  const nodes = model.nodes.filter((n) => connectedIds.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { ...model, nodes, edges };
}

// ─── Focus Schema Filter (1-hop neighbors) ──────────────────────────────────

function applyFocusSchemaFilter(
  model: DacpacModel,
  focusSchemas: Set<string>
): DacpacModel {
  if (focusSchemas.size === 0) return model;

  // Keep nodes in focus schemas + their direct 1-hop neighbors via edges
  const focusNodeIds = new Set(
    model.nodes.filter((n) => focusSchemas.has(n.schema)).map((n) => n.id)
  );

  const neighborIds = new Set<string>();
  for (const e of model.edges) {
    if (focusNodeIds.has(e.source)) neighborIds.add(e.target);
    if (focusNodeIds.has(e.target)) neighborIds.add(e.source);
  }

  const keepIds = new Set([...focusNodeIds, ...neighborIds]);
  const nodes = model.nodes.filter((n) => keepIds.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { ...model, nodes, edges };
}
