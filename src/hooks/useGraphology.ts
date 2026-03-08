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
    const filtered = filterBySchemas(model, filter.schemas, config.maxNodes);

    // Fused type + ext refs filter (single node pass)
    const isVirtual = (n: { externalType?: string }) =>
      n.externalType === 'file' || n.externalType === 'db';
    const allExtRefsVisible = filter.showExternalRefs && filter.externalRefTypes.has('file') && filter.externalRefTypes.has('db');

    const fusedNodes = filtered.nodes.filter((n) => {
      if (!filter.types.has(n.type)) return false;
      if (allExtRefsVisible || !isVirtual(n)) return true;
      if (!filter.showExternalRefs) return false;
      return filter.externalRefTypes.has(n.externalType as 'file' | 'db');
    });
    const fusedNodeIds = new Set(fusedNodes.map((n) => n.id));
    const fusedEdges = filtered.edges.filter((e) => fusedNodeIds.has(e.source) && fusedNodeIds.has(e.target));

    const focusFiltered = applyFocusSchemaFilter({ ...filtered, nodes: fusedNodes, edges: fusedEdges }, filter.focusSchemas);
    const isolationFiltered = applyIsolationFilter(focusFiltered, filter.hideIsolated);

    const result = buildGraph(isolationFiltered, config);
    setFlowNodes(result.flowNodes as FlowNode<CustomNodeData>[]);
    setFlowEdges(result.flowEdges);
    setGraph(result.graph);
    setMetrics(getGraphMetrics(result.graph));
  }, []);

  return { flowNodes, flowEdges, graph, metrics, buildFromModel };
}

// ─── Isolation Filter ────────────────────────────────────────────────────────

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

// ─── Focus Schema Filter ─────────────────────────────────────────────────────

function applyFocusSchemaFilter(
  model: DacpacModel,
  focusSchemas: Set<string>
): DacpacModel {
  if (focusSchemas.size === 0) return model;

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
