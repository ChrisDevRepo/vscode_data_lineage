import type { Node as FlowNode } from '@xyflow/react';
import type { ColumnTraceViewNode } from './columnTraceView';
import type { AiBadge, ColumnTraceNodeData, CustomNodeData, GraphMode, TraceNodeControls, TraceState } from './types';

/**
 * Per-node display state that depends on the current selection, trace, and AI overlay rather than
 * on where the node sits on the canvas.
 *
 * @remarks
 * Position is deliberately absent. React Flow emits a position change per drag frame, so a
 * decoration derived from position would rebuild every node's `data` object on every frame and
 * defeat the `React.memo` on the node renderers.
 */
export interface NodeDecorationInputs {
  /** Whether the canvas renders schema clusters or individual objects. */
  graphMode: GraphMode;
  /** Node the user last clicked; null or undefined when nothing is focused. */
  highlightedNodeId: string | null | undefined;
  /** Direct neighbors of the highlighted node, which stay undimmed. */
  level1Neighbors: ReadonlySet<string>;
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

/**
 * Creates the retention map {@link decorateFlowNodes} reuses across renders.
 *
 * @returns An empty cache, owned by the caller for the lifetime of the canvas.
 */
export function createNodeDecorationCache(): NodeDecorationCache {
  return new Map();
}

/**
 * Class name marking a node exempt from the active-selection dim — the node itself, a level-1
 * neighbour, or the trace origin.
 *
 * @remarks
 * Paired with the `.ln-has-selection` wrapper class ({@link ./GraphCanvas.tsx}) by the CSS rule in
 * `src/index.css`: everything outside the lit set is dimmed by that one rule, so an ordinary node's
 * `data` never needs to change just because some other node was clicked. {@link decorateFlowEdges}
 * (`src/engine/edgeDecoration.ts`) applies the same class to an edge's incident set.
 */
export const LIT_CLASS_NAME = 'ln-lit';

/**
 * Node count above which React Flow's `onlyRenderVisibleElements` viewport culling pays for
 * itself — below it, the per-frame visibility bookkeeping costs more than the render work it
 * would skip (React Flow's own performance guidance).
 */
export const VIRTUALIZATION_NODE_THRESHOLD = 300;

/**
 * Edge count above which a connected edge's dash animation is switched off regardless of
 * `config.layout`, so a dense graph is not repainted every frame for a flourish nobody can track
 * by eye at that density.
 */
export const EDGE_ANIMATION_COUNT_THRESHOLD = 200;

/** Whether the rendered node count justifies React Flow's viewport-culling mode. */
export function shouldVirtualizeCanvas(renderedNodeCount: number): boolean {
  return renderedNodeCount > VIRTUALIZATION_NODE_THRESHOLD;
}

/**
 * Whether a connected edge should animate: the config toggle, gated off past
 * {@link EDGE_ANIMATION_COUNT_THRESHOLD}.
 */
export function shouldAnimateEdges(renderedEdgeCount: number, configAllowsAnimation: boolean): boolean {
  return configAllowsAnimation && renderedEdgeCount <= EDGE_ANIMATION_COUNT_THRESHOLD;
}

/**
 * Zoom below which `CustomNode` drops its label, badges and trace-control decorations for a plain
 * box — at this scale none of that detail is legible, and skipping it keeps a large, zoomed-out
 * graph cheap to repaint.
 */
export const SIMPLE_NODE_ZOOM_THRESHOLD = 0.4;

/**
 * Floor for React Flow's `minZoom`, so `fitView` can always zoom out far enough to contain every
 * node of the largest renderable graph rather than clamping and leaving nodes outside the pane.
 *
 * @remarks
 * Well below {@link SIMPLE_NODE_ZOOM_THRESHOLD}: every node this small already renders as the plain
 * box {@link SIMPLE_NODE_ZOOM_THRESHOLD} gates, so a small `minZoom` still reads as a legible map
 * rather than illegible label text.
 */
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
  /**
   * Whether the node is exempt from the active-selection dim — itself, a level-1 neighbour, or the
   * trace origin.
   *
   * @remarks
   * Unlike {@link dimmed}, this stays `false` for an ordinary node whether or not a selection is
   * active, so the object-view canvas can use it as a `className` (see {@link LIT_CLASS_NAME}) that
   * only changes identity for the handful of nodes actually entering or leaving the lit set.
   */
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

/**
 * Selection, trace, and AI decoration for one non-schema node — the one rule both canvas views
 * (object view through {@link decorateFlowNodes}, column view per column node) apply.
 *
 * @remarks
 * The trace origin is highlighted and never dimmed; otherwise the clicked node is `'yellow'` and
 * any other node keeps `ownHighlight`. Object view computes this once per node per pass and derives
 * both the retention key and the emitted `data` from the one result, so the key cannot describe a
 * decoration other than the one that was applied.
 *
 * @param nodeId - Id of the node being decorated.
 * @param ownHighlight - The node's own highlight state, kept when neither selection rule applies.
 * @param inputs - Position-independent decoration state.
 * @returns The node's decoration.
 */
export function computeNodeDecoration(
  nodeId: string,
  ownHighlight: boolean | 'yellow' | undefined,
  inputs: NodeSelectionInputs,
): NodeDecoration {
  const { highlighted: isHighlighted, isNeighbor, dimmed: baseDimmed } = resolveBaseSelectionState(nodeId, inputs.highlightedNodeId, inputs.level1Neighbors);
  const isTraceOrigin = isTraceOriginNode(nodeId, inputs);
  const removable = inputs.isBookmarkMode && inputs.canRemoveNodeFromScopedView;
  return {
    highlighted: isTraceOrigin ? true : isHighlighted ? 'yellow' : ownHighlight,
    dimmed: baseDimmed && !isTraceOrigin,
    lit: isHighlighted || isNeighbor || isTraceOrigin,
    removable,
    onRemoveFromView: removable ? inputs.onRemoveFromView : undefined,
    traceControls: inputs.traceControlsByNode.get(nodeId),
    aiHighlight: inputs.aiHighlightMap.get(nodeId),
    aiBadge: inputs.aiBadgeMap.get(nodeId),
    aiNote: inputs.notesVisible ? inputs.aiNoteMap.get(nodeId) : undefined,
  };
}

/**
 * Returns the retained result for `node` when `key` matches the one it was built with, and
 * otherwise the freshly built node, recording it against the new key.
 *
 * @remarks
 * The two reuse paths are what keeps `React.memo` alive: an unchanged node object is handed back
 * untouched, and a node object replaced by a position-only change carries the previous `data` and
 * `className` across so even the dragged node's renderer skips.
 */
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

/**
 * Applies an already-computed decoration to its node.
 *
 * @remarks
 * The dim itself is not written into `data`: {@link NodeDecoration.lit} becomes the node's
 * `className` instead (see {@link LIT_CLASS_NAME}), a top-level `FlowNode` field React Flow applies
 * to the node's outer wrapper without passing it to the memoized node renderer. That keeps `data`
 * — and with it, `React.memo`'s ability to skip the renderer — unaffected by which node is dimmed.
 */
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

/**
 * Applies selection, trace, and AI decoration to each node, reusing the previous result whenever
 * that node's decoration inputs are unchanged.
 *
 * @remarks
 * A drag emits a position change for one node, so `applyNodeChanges` returns a new object for that
 * node and keeps every other node's reference. Reusing the cached result for the untouched nodes
 * keeps their `data` reference stable, which is what lets `React.memo` skip them: without it a
 * single drag frame re-renders every node on the canvas.
 *
 * Entries for ids absent from `nodes` are dropped, so the cache tracks the rendered set rather than
 * growing across filter changes.
 *
 * @param nodes - Nodes to decorate, in render order.
 * @param inputs - Position-independent decoration state.
 * @param cache - Retention map from {@link createNodeDecorationCache}, mutated in place.
 * @returns The decorated nodes, in the order given.
 */
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

/**
 * Creates the retention map {@link projectColumnNodes} reuses across renders.
 *
 * @returns An empty cache, owned by the caller for the lifetime of the canvas.
 */
export function createColumnNodeCache(): ColumnNodeCache {
  return new Map();
}

/**
 * Projects the column-trace view onto React Flow nodes, reusing the previous object for every node
 * whose data and position are unchanged.
 *
 * @remarks
 * React Flow adopts a node whose object identity changed: it resets that node's handle bounds and
 * re-measures it. Rebuilding the whole array each render therefore re-measures the whole canvas on
 * every hover and drag frame, so identity is preserved here for the nodes that did not move.
 *
 * Width and height are declared from the view box rather than measured. A column node's height is
 * `header + rows`, so it is known before layout — the same number dagre positioned against — and
 * declaring it lets the minimap draw the node on its first render instead of after a measurement
 * round-trip.
 *
 * Entries for ids absent from `views` are dropped, so the cache tracks the rendered set.
 *
 * @param views - Positioned column-view nodes, in render order.
 * @param dataById - Per-node render data, keyed by node id; must cover every id in `views`.
 * @param positions - Hand-placed positions by node id, overriding the laid-out position.
 * @param cache - Retention map from {@link createColumnNodeCache}, mutated in place.
 * @returns The projected nodes, in the order given.
 */
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
