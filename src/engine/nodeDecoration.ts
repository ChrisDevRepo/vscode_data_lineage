import type { Node as FlowNode } from '@xyflow/react';
import type { CustomNodeData, TraceNodeControls } from '../components/CustomNode';
import type { ColumnTraceNodeData } from '../components/ColumnTraceNode';
import type { ColumnTraceViewNode } from './columnTraceView';
import type { GraphMode, TraceState } from './types';

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
  aiBadgeMap: ReadonlyMap<string, { text: string }>;
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
export type NodeDecorationCache = Map<string, CacheEntry>;

/**
 * Creates the retention map {@link decorateFlowNodes} reuses across renders.
 *
 * @returns An empty cache, owned by the caller for the lifetime of the canvas.
 */
export function createNodeDecorationCache(): NodeDecorationCache {
  return new Map();
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

function decorationKey(node: FlowNode, inputs: NodeDecorationInputs): readonly unknown[] {
  if (node.type === 'schemaNode') {
    const schemaView = inputs.graphMode === 'overview';
    return [
      schemaView ? inputs.onExpandSchema : undefined,
      schemaView ? inputs.onMakeSchemaCenter : undefined,
    ];
  }
  const { highlighted: isHighlighted, dimmed: baseDimmed } = resolveBaseSelectionState(node.id, inputs.highlightedNodeId, inputs.level1Neighbors);
  const isTraceOrigin = isTraceOriginNode(node.id, inputs);
  const removable = inputs.isBookmarkMode && inputs.canRemoveNodeFromScopedView;
  return [
    isTraceOrigin ? true : isHighlighted ? 'yellow' : (node.data as CustomNodeData).highlighted,
    baseDimmed && !isTraceOrigin,
    removable,
    removable ? inputs.onRemoveFromView : undefined,
    inputs.traceControlsByNode.get(node.id),
    inputs.aiHighlightMap.get(node.id),
    inputs.aiBadgeMap.get(node.id),
    inputs.notesVisible ? inputs.aiNoteMap.get(node.id) : undefined,
  ];
}

/**
 * Base click-selection highlight/dim state, shared by object view and column view.
 *
 * @remarks
 * Object view layers a trace-origin override on top ({@link isTraceOriginNode}); column view has no
 * trace concept and uses this result unmodified — one rule for "is this the selected node", read by
 * both callers instead of restated in each.
 */
export function resolveBaseSelectionState(
  nodeId: string,
  highlightedNodeId: string | null | undefined,
  level1Neighbors: ReadonlySet<string>,
): { highlighted: boolean; dimmed: boolean } {
  const highlighted = highlightedNodeId === nodeId;
  const dimmed = !!highlightedNodeId && !highlighted && !level1Neighbors.has(nodeId);
  return { highlighted, dimmed };
}

function isTraceOriginNode(nodeId: string, inputs: NodeDecorationInputs): boolean {
  return nodeId === inputs.traceSelectedNodeId && (
    inputs.traceMode === 'applied' || inputs.traceMode === 'filtered' || inputs.traceMode === 'path-applied'
  );
}

function decorateOne(node: FlowNode, inputs: NodeDecorationInputs): FlowNode {
  if (node.type === 'schemaNode') {
    const schemaView = inputs.graphMode === 'overview';
    return {
      ...node,
      data: {
        ...node.data,
        onExpandSchema: schemaView ? inputs.onExpandSchema : undefined,
        onMakeSchemaCenter: schemaView ? inputs.onMakeSchemaCenter : undefined,
      },
    };
  }

  const { highlighted: isHighlighted, dimmed: baseDimmed } = resolveBaseSelectionState(node.id, inputs.highlightedNodeId, inputs.level1Neighbors);
  const isTraceOrigin = isTraceOriginNode(node.id, inputs);
  const shouldBeDimmed = baseDimmed && !isTraceOrigin;
  const removable = inputs.isBookmarkMode && inputs.canRemoveNodeFromScopedView;
  return {
    ...node,
    data: {
      ...node.data,
      highlighted: isTraceOrigin ? true : isHighlighted ? 'yellow' : (node.data as CustomNodeData).highlighted,
      dimmed: !!shouldBeDimmed,
      showRemoveButton: removable,
      onRemoveFromView: removable ? inputs.onRemoveFromView : undefined,
      traceControls: inputs.traceControlsByNode.get(node.id),
      aiHighlight: inputs.aiHighlightMap.get(node.id),
      aiBadge: inputs.aiBadgeMap.get(node.id),
      aiNote: inputs.notesVisible ? inputs.aiNoteMap.get(node.id) : undefined,
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
    const key = decorationKey(node, inputs);
    const cached = cache.get(node.id);
    if (cached && sameKey(cached.key, key)) {
      if (cached.source === node) return cached.result;
      // The node object is new but its decoration is not — a drag frame, which changes position and
      // nothing else. Carry the previous `data` across so even the dragged node keeps its memo.
      if (cached.source.data === node.data) {
        const moved = { ...node, data: cached.result.data };
        cache.set(node.id, { source: node, key, result: moved });
        return moved;
      }
    }
    const result = decorateOne(node, inputs);
    cache.set(node.id, { source: node, key, result });
    return result;
  });
  for (const id of [...cache.keys()]) {
    if (!present.has(id)) cache.delete(id);
  }
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
export type ColumnNodeCache = Map<string, ColumnCacheEntry>;

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
  const projected = views.map((view) => {
    present.add(view.id);
    const data = dataById.get(view.id)!;
    const position = positions[view.id] ?? view.position;
    const cached = cache.get(view.id);
    if (cached && cached.data === data && cached.x === position.x && cached.y === position.y) {
      return cached.result;
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
    return result;
  });
  for (const id of [...cache.keys()]) {
    if (!present.has(id)) cache.delete(id);
  }
  return projected;
}
