import type { Node as FlowNode } from '@xyflow/react';
import type { ColumnTraceViewNode } from './columnTraceView';
import type { AiBadge, ColumnTraceNodeData, CustomNodeData, GraphMode, TraceNodeControls, TraceState } from './types';

/** Per-node display state that depends on the current selection, trace, and AI overlay rather than on where the node sits on the canvas. */
export interface NodeDecorationInputs {
  /** Whether the canvas renders schema clusters or individual objects. */
  graphMode: GraphMode;
  /** Node the user last clicked; null or undefined when nothing is focused. */
  highlightedNodeId: string | null | undefined;
  /** Direct neighbors of the highlighted node, which stay undimmed. */
  level1Neighbors: ReadonlySet<string>;
  /** Explicit lit set replacing click-selection lighting, e.g. a trace-tree path. Unset or empty disables the override; the trace origin stays lit either way. */
  litOverride?: ReadonlySet<string>;
  /** Current trace mode, which decides whether the trace origin keeps its highlight. */
  traceMode: TraceState['mode'];
  /** Origin node of the active trace. */
  traceSelectedNodeId: string | null;
  /** Whether an allowlist-backed bookmark view is on stage. */
  isBookmarkMode: boolean;
  /** Whether the active view permits removing a node from its scope. */
  canRemoveNodeFromScopedView: boolean;
  /** Whether the zoom level is close enough to show AI notes. */
  notesVisible: boolean;
  /** Removes a node from the active allowlist-backed view. */
  onRemoveFromView?: (nodeId: string) => void;
  /** Interactive trace controls, populated for the highlighted node only. */
  traceControlsByNode: ReadonlyMap<string, TraceNodeControls>;
  /** AI-authored highlight styling by node id. */
  aiHighlightMap: ReadonlyMap<string, { color: string; glow: string; shadow: string }>;
  /** AI-authored badges by node id. */
  aiBadgeMap: ReadonlyMap<string, AiBadge>;
  /** AI-authored notes by node id. */
  aiNoteMap: ReadonlyMap<string, { text: string }>;
  /** Expands a schema cluster into its objects; undefined outside Schema View. */
  onExpandSchema?: (schemaName: string) => void;
  /** Recenters Expanded Schema View on a schema; undefined outside Schema View. */
  onMakeSchemaCenter?: (schemaName: string) => void;
}

/** One id's last decoration, kept with the inputs that produced it. */
interface CacheEntry {
  source: FlowNode;
  key: readonly unknown[];
  result: FlowNode;
}

/** Retains the decorated node produced for each id across renders. */
type NodeDecorationCache = Map<string, CacheEntry>;

/** Creates the retention map {@link decorateFlowNodes} reuses across renders. */
export function createNodeDecorationCache(): NodeDecorationCache {
  return new Map();
}

/** Class name marking a node exempt from the active-selection dim — the node itself, a level-1 neighbour, or the trace origin. */
export const LIT_CLASS_NAME = 'ln-lit';

/** Node count above which React Flow's `onlyRenderVisibleElements` viewport culling pays for itself — below it, the per-frame visibility bookkeeping costs more than the render work it would skip (React Flow's own performance guidance). */
export const VIRTUALIZATION_NODE_THRESHOLD = 300;

/** Edge count above which a connected edge's dash animation is switched off regardless of `config.layout`, so a dense graph is not repainted every frame for a flourish nobody can track by eye at that density. */
export const EDGE_ANIMATION_COUNT_THRESHOLD = 200;

/** Whether the rendered node count justifies React Flow's viewport-culling mode. */
export function shouldVirtualizeCanvas(renderedNodeCount: number): boolean {
  return renderedNodeCount > VIRTUALIZATION_NODE_THRESHOLD;
}

/** Whether a connected edge should animate: the config toggle, gated off past {@link EDGE_ANIMATION_COUNT_THRESHOLD}. */
export function shouldAnimateEdges(renderedEdgeCount: number, configAllowsAnimation: boolean): boolean {
  return configAllowsAnimation && renderedEdgeCount <= EDGE_ANIMATION_COUNT_THRESHOLD;
}

/** Zoom below which `CustomNode` drops its label, badges and trace-control decorations for a plain box — only once the 11px label renders under ~2px and no one can read it. Labels stay at every readable zoom; legibility, not repaint cost, decides. */
export const SIMPLE_NODE_ZOOM_THRESHOLD = 0.15;

/** Default for React Flow's `minZoom`. The canvas lowers it further when fitting the laid-out graph needs a smaller zoom, so a fit never clamps and leaves nodes outside the pane. */
export const MIN_CANVAS_ZOOM = 0.02;

/** Compares two decoration keys field by field, treating `NaN`-safe identity as equal. */
export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/** Drops cache entries for ids no longer present in the current render pass. */
export function pruneStaleEntries<K, V>(cache: Map<K, V>, present: ReadonlySet<K>): void {
  for (const id of [...cache.keys()]) {
    if (!present.has(id)) cache.delete(id);
  }
}

/** Decoration inputs a single node reads; the Schema View callbacks and graph mode are cluster-only. */
export type NodeSelectionInputs = Omit<NodeDecorationInputs, 'graphMode' | 'onExpandSchema' | 'onMakeSchemaCenter'>;

/** Selection, trace, and AI state derived for one non-schema node. */
export interface NodeDecoration {
  /** Highlight state: `true` for the trace origin, `'yellow'` for the clicked node, else the node's own. */
  highlighted: boolean | 'yellow' | undefined;
  /** Whether the node is de-emphasised because another node is focused. */
  dimmed: boolean;
  /** Whether the node is exempt from the active-selection dim — itself, a level-1 neighbour, or the trace origin. */
  lit: boolean;
  /** Whether the scoped-view remove control is shown. */
  removable: boolean;
  /** Remove-from-view callback, attached only while the control is shown. */
  onRemoveFromView: ((nodeId: string) => void) | undefined;
  /** Interactive trace controls, populated for the highlighted node only. */
  traceControls: TraceNodeControls | undefined;
  /** AI-authored highlight styling for this node. */
  aiHighlight: { color: string; glow: string; shadow: string } | undefined;
  /** AI-authored badge for this node. */
  aiBadge: AiBadge | undefined;
  /** AI-authored note for this node, dropped while notes are hidden. */
  aiNote: { text: string } | undefined;
}

/** Schema-cluster callbacks, which are attached only while Schema View is on stage. */
function schemaCallbacks(inputs: NodeDecorationInputs): { onExpandSchema?: (schemaName: string) => void; onMakeSchemaCenter?: (schemaName: string) => void } {
  const schemaView = inputs.graphMode === 'overview';
  return {
    onExpandSchema: schemaView ? inputs.onExpandSchema : undefined,
    onMakeSchemaCenter: schemaView ? inputs.onMakeSchemaCenter : undefined,
  };
}

/** Base click-selection highlight/dim state, before the trace-origin override. */
function resolveBaseSelectionState(
  nodeId: string,
  highlightedNodeId: string | null | undefined,
  level1Neighbors: ReadonlySet<string>,
): { highlighted: boolean; isNeighbor: boolean; dimmed: boolean } {
  const highlighted = highlightedNodeId === nodeId;
  const isNeighbor = level1Neighbors.has(nodeId);
  const dimmed = !!highlightedNodeId && !highlighted && !isNeighbor;
  return { highlighted, isNeighbor, dimmed };
}

/** Whether `nodeId` is the origin of an applied, filtered, or path trace. */
function isTraceOriginNode(
  nodeId: string,
  inputs: Pick<NodeDecorationInputs, 'traceSelectedNodeId' | 'traceMode'>,
): boolean {
  return nodeId === inputs.traceSelectedNodeId && (
    inputs.traceMode === 'applied' || inputs.traceMode === 'filtered' || inputs.traceMode === 'path-applied'
  );
}

/** Selection, trace, and AI decoration for one non-schema node — the one rule both canvas views (object view through {@link decorateFlowNodes}, column view per column node) apply. */
export function computeNodeDecoration(
  nodeId: string,
  ownHighlight: boolean | 'yellow' | undefined,
  inputs: NodeSelectionInputs,
): NodeDecoration {
  const { highlighted: isHighlighted, isNeighbor, dimmed: baseDimmed } = resolveBaseSelectionState(nodeId, inputs.highlightedNodeId, inputs.level1Neighbors);
  const isTraceOrigin = isTraceOriginNode(nodeId, inputs);
  const override = inputs.litOverride?.size ? inputs.litOverride : undefined;
  const lit = override
    ? override.has(nodeId) || isTraceOrigin
    : isHighlighted || isNeighbor || isTraceOrigin;
  const removable = inputs.isBookmarkMode && inputs.canRemoveNodeFromScopedView;
  return {
    highlighted: isTraceOrigin ? true : isHighlighted ? 'yellow' : ownHighlight,
    dimmed: override ? !lit : baseDimmed && !isTraceOrigin,
    lit,
    removable,
    onRemoveFromView: removable ? inputs.onRemoveFromView : undefined,
    traceControls: inputs.traceControlsByNode.get(nodeId),
    aiHighlight: inputs.aiHighlightMap.get(nodeId),
    aiBadge: inputs.aiBadgeMap.get(nodeId),
    aiNote: inputs.notesVisible ? inputs.aiNoteMap.get(nodeId) : undefined,
  };
}

/** Returns the retained result for `node` when `key` matches the one it was built with, and otherwise the freshly built node, recording it against the new key. */
function reuseOrBuild(
  node: FlowNode,
  key: readonly unknown[],
  cache: NodeDecorationCache,
  build: () => FlowNode,
): FlowNode {
  const cached = cache.get(node.id);
  if (cached && sameKey(cached.key, key)) {
    if (cached.source === node) return cached.result;
    if (cached.source.data === node.data) {
      const moved = { ...node, className: cached.result.className, data: cached.result.data };
      cache.set(node.id, { source: node, key, result: moved });
      return moved;
    }
  }
  const result = build();
  cache.set(node.id, { source: node, key, result });
  return result;
}

/** Applies an already-computed decoration to its node. */
function applyDecoration(node: FlowNode, d: NodeDecoration): FlowNode {
  return {
    ...node,
    className: d.lit ? LIT_CLASS_NAME : undefined,
    data: {
      ...node.data,
      highlighted: d.highlighted,
      showRemoveButton: d.removable,
      onRemoveFromView: d.onRemoveFromView,
      traceControls: d.traceControls,
      aiHighlight: d.aiHighlight,
      aiBadge: d.aiBadge,
      aiNote: d.aiNote,
    },
  };
}

/** Applies selection, trace, and AI decoration to each node, reusing the previous result whenever that node's decoration inputs are unchanged. */
export function decorateFlowNodes(
  nodes: readonly FlowNode[],
  inputs: NodeDecorationInputs,
  cache: NodeDecorationCache,
): FlowNode[] {
  const present = new Set<string>();
  const decorated = nodes.map((node) => {
    present.add(node.id);
    if (node.type === 'schemaNode') {
      const callbacks = schemaCallbacks(inputs);
      return reuseOrBuild(
        node,
        [callbacks.onExpandSchema, callbacks.onMakeSchemaCenter],
        cache,
        () => ({ ...node, data: { ...node.data, ...callbacks } }),
      );
    }
    const decoration = computeNodeDecoration(node.id, (node.data as CustomNodeData).highlighted, inputs);
    return reuseOrBuild(
      node,
      [decoration.lit, decoration.highlighted, decoration.removable, decoration.onRemoveFromView, decoration.traceControls, decoration.aiHighlight, decoration.aiBadge, decoration.aiNote],
      cache,
      () => applyDecoration(node, decoration),
    );
  });
  pruneStaleEntries(cache, present);
  return decorated;
}

/** One column node's last projection, kept with the inputs that produced it. */
interface ColumnCacheEntry {
  data: ColumnTraceNodeData;
  x: number;
  y: number;
  result: FlowNode;
}

/** Retains the React Flow node produced for each column-view node across renders. */
type ColumnNodeCache = Map<string, ColumnCacheEntry>;

/** Creates the retention map {@link projectColumnNodes} reuses across renders. */
export function createColumnNodeCache(): ColumnNodeCache {
  return new Map();
}

/** Projects the column-trace view onto React Flow nodes, reusing the previous object for every node whose data and position are unchanged. */
export function projectColumnNodes(
  views: readonly ColumnTraceViewNode[],
  dataById: ReadonlyMap<string, ColumnTraceNodeData>,
  positions: Readonly<Record<string, { x: number; y: number }>>,
  cache: ColumnNodeCache,
): FlowNode[] {
  const present = new Set<string>();
  const projected: FlowNode[] = [];
  for (const view of views) {
    const data = dataById.get(view.id);
    if (!data) continue;
    present.add(view.id);
    const position = positions[view.id] ?? view.position;
    const cached = cache.get(view.id);
    if (cached && cached.data === data && cached.x === position.x && cached.y === position.y) {
      projected.push(cached.result);
      continue;
    }
    const result: FlowNode = {
      id: view.id,
      type: 'columnTraceNode',
      position,
      width: view.width,
      height: view.height,
      data,
    };
    cache.set(view.id, { data, x: position.x, y: position.y, result });
    projected.push(result);
  }
  pruneStaleEntries(cache, present);
  return projected;
}
