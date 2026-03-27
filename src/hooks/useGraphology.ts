import { useState, useCallback } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { DatabaseModel, FilterState, ExtensionConfig, DEFAULT_CONFIG } from '../engine/types';
import { buildGraph, getGraphMetrics } from '../engine/graphBuilder';
import { filterBySchemas } from '../engine/dacpacExtractor';
import { compileExclusionPattern } from '../utils/sql';

interface UseGraphologyReturn {
  flowNodes: FlowNode<CustomNodeData>[];
  flowEdges: FlowEdge[];
  graph: Graph | null;
  metrics: ReturnType<typeof getGraphMetrics> | null;
  buildFromModel: (model: DatabaseModel, filter: FilterState, config?: ExtensionConfig) => void;
}

export function useGraphology(): UseGraphologyReturn {
  const [flowNodes, setFlowNodes] = useState<FlowNode<CustomNodeData>[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [metrics, setMetrics] = useState<ReturnType<typeof getGraphMetrics> | null>(null);

  const buildFromModel = useCallback((model: DatabaseModel, filter: FilterState, config: ExtensionConfig = DEFAULT_CONFIG) => {
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

    const exclusionFiltered = applyExclusionFilter({ ...filtered, nodes: fusedNodes, edges: fusedEdges }, filter.exclusionPatterns);
    const focusFiltered = applyFocusSchemaFilter(exclusionFiltered, filter.focusSchemas);
    const isolationFiltered = applyIsolationFilter(focusFiltered, filter.hideIsolated);
    const allowlistFiltered = applyAllowlistFilter(isolationFiltered, filter.allowlistNodeIds);

    const result = buildGraph(allowlistFiltered, config);
    setFlowNodes(result.flowNodes as FlowNode<CustomNodeData>[]);
    setFlowEdges(result.flowEdges);
    setGraph(result.graph);
    setMetrics(getGraphMetrics(result.graph));
  }, []);

  return { flowNodes, flowEdges, graph, metrics, buildFromModel };
}

// ─── Exclusion Filter (interactive / render-time) ────────────────────────────
// Separate from dacpacExtractor.applyExclusionPatterns, which is load-time only
// (applied once when the data source is loaded, driven by config.excludePatterns).
// This filter is applied on every graph rebuild driven by filter.exclusionPatterns
// from the UI ExclusionDropdown — instant effect, no data reload required.

function applyExclusionFilter(model: DatabaseModel, patterns: string[]): DatabaseModel {
  if (!patterns || patterns.length === 0) return model;

  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try { regexes.push(compileExclusionPattern(p)); } catch { /* skip invalid — UI validates before add */ }
  }
  if (regexes.length === 0) return model;

  const nodes = model.nodes.filter((n) => {
    const name = `${n.schema}.${n.name}`;
    return !regexes.some((r) => r.test(name) || r.test(n.fullName));
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}

// ─── Isolation Filter ────────────────────────────────────────────────────────

function applyIsolationFilter(model: DatabaseModel, hideIsolated: boolean): DatabaseModel {
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

// ─── Allowlist Filter ────────────────────────────────────────────────────────
// Applied last in the pipeline — only nodes in the allowlist survive.
// Edges are preserved only when both endpoints are in the allowlist.
// Empty/absent allowlist = no-op (full graph passes through).

function applyAllowlistFilter(model: DatabaseModel, allowlist: Set<string> | undefined): DatabaseModel {
  if (!allowlist || allowlist.size === 0) return model;
  const nodes = model.nodes.filter((n) => allowlist.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}

// ─── Focus Schema Filter ─────────────────────────────────────────────────────

function applyFocusSchemaFilter(
  model: DatabaseModel,
  focusSchemas: Set<string>
): DatabaseModel {
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
