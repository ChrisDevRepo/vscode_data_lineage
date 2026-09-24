import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist';
import type { TraceTree, TraceTreeGroup, TraceTreeLevel, TraceTreeSide } from './traceTreeModel';
import type { ObjectType } from '../engine/types';
import { TYPE_COLORS, getExternalNodeColor, getSchemaColor } from '../utils/schemaColors';
import { SidePanel } from './SidePanel';
import { TRACE_ICON } from './TracedFilterBanner';
import { Tooltip } from './ui/Tooltip';

/** Display metadata for one tree row, resolved from the canvas node lists. */
export interface TraceTreeNodeMeta {
  /** Human-readable object name. */
  name: string;
  /** Secondary line (schema); omitted when unknown. */
  detail?: string;
  /** Canvas object type; drives the type symbol. */
  type?: ObjectType;
}

/** Type symbol for a tree row; same glyphs as the canvas nodes. */
function typeIcon(type?: ObjectType): string {
  return (type && TYPE_COLORS[type]?.icon) || '▪';
}

/** Schema color for a tree row; identical to the canvas node border rule. */
function schemaColor(type?: ObjectType, schema?: string): string | undefined {
  if (type === 'external') return getExternalNodeColor();
  return schema ? getSchemaColor(schema) : undefined;
}

export interface TraceTreePanelProps {
  /** L0-anchored trace projection from the adapter, over the pre-route scope. */
  tree: TraceTree;
  /** Display name of the trace origin. */
  originName: string;
  /** Collapsed to the reopen button. */
  collapsed: boolean;
  /** Collapse toggle. */
  onToggleCollapse: () => void;
  /** Label lookup by node id. */
  resolveNode: (id: string) => TraceTreeNodeMeta | undefined;
  /** Canvas selection, mirrored as the active row. */
  selectedNodeId: string | null;
  /** Row activation; the canvas owns selection and route lighting. */
  onSelectNode: (id: string) => void;
  /** Checked route targets; owned by the trace. */
  focusTargetIds: readonly string[];
  /** Shows only the routes to the given targets (empty restores); false when a route is unreachable. */
  onFocusTargets: (ids: string[]) => boolean;
  /** Nodes on the canvas while routes are shown; null when the full trace is on stage. */
  onStageIds: ReadonlySet<string> | null;
  /** Manual scope edits since the trace started. */
  editCounts: { added: number; trimmed: number };
  /** Restores the trace's starting scope. */
  onResetTrace: () => void;
  /** Loads one level from the given grow candidates. */
  onGrowLevel: (candidateIds: string[]) => void;
  /** Remove intent for the current trace mode; level growth honors it. */
  removeKind: 'trace-prune' | 'none';
}

type RowKind = 'side' | 'level' | 'leaf';

/** Row shape handed to the tree widget; hierarchy only, no trace logic. */
interface PanelRow {
  /** Unique row id; a node on both sides of a cycle gets one row per side. */
  id: string;
  kind: RowKind;
  /** Tree placement; side and leaf rows only. */
  side?: TraceTreeSide;
  /** Trace node behind a leaf row. */
  nodeId?: string;
  name: string;
  /** Schema-qualified name for the truncation tooltip; leaves only. */
  fullName?: string;
  /** Canvas type symbol (■ ● ▲ ◆ ⬡); leaves only. */
  typeIcon?: string;
  /** Right-aligned member count on side and level rows. */
  count?: number;
  /** Hop level of a level row. */
  level?: number;
  /** Schema color, consumed by CSS as --ln-tree-schema; tints the leaf type symbol. */
  schemaColor?: string;
  /** One more level on this side; side rows only. */
  nextIds?: string[];
  children?: PanelRow[];
}


interface PanelContext {
  checkedIds: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  onStageIds: ReadonlySet<string> | null;
  onGrowLevel: (candidateIds: string[]) => void;
  growsEnabled: boolean;
}

const PanelRowContext = createContext<PanelContext>({
  checkedIds: new Set(),
  onToggleCheck: () => {},
  onStageIds: null,
  onGrowLevel: () => {},
  growsEnabled: true,
});

const ROW_HEIGHT = 24;
const TREE_INDENT = 12;
/** Hop levels open on first render; deeper levels start collapsed. */
const INITIAL_OPEN_LEVELS = 2;
const SIDE_ROW_IDS = new Set(['trace-up', 'trace-down', 'trace-connected']);

const ExpandAllIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M8 15l4 4 4-4" />
  </svg>
);

const CollapseAllIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 5l4 4 4-4M8 19l4-4 4 4" />
  </svg>
);

const PlusIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" d="M12 4.5v15m7.5-7.5h-15" />
  </svg>
);

/** Side header: fixed section label with the +1 level action; never collapses. */
function SideRow({ row }: { row: PanelRow }) {
  const { onGrowLevel, growsEnabled } = useContext(PanelRowContext);
  const next = row.nextIds ?? [];
  const direction = row.side === 'up' ? 'upstream' : 'downstream';
  const canGrow = growsEnabled && next.length > 0;
  const hint = !growsEnabled
    ? 'Show all to load more levels'
    : next.length > 0
      ? `Load one more ${direction} level (+${next.length} node${next.length === 1 ? '' : 's'})`
      : `No further ${direction} level`;
  return (
    <>
      <span className="ln-tree-section">{row.name}</span>
      <span className="ln-tree-count">{row.count}</span>
      {row.nextIds ? (
        <Tooltip content={hint} asChild>
          <button
            type="button"
            aria-label={hint}
            disabled={!canGrow}
            className="ln-btn-icon ln-tree-grow w-7 h-7 flex items-center justify-center rounded-sm"
            onClick={(event) => {
              event.stopPropagation();
              onGrowLevel(next);
            }}
          >
            {PlusIcon}
          </button>
        </Tooltip>
      ) : null}
    </>
  );
}

/**
 * Leaf: route checkbox plus the object label, the type symbol tinted in the schema color; muted
 * while routes hide it from the canvas. Cmd/Ctrl+click toggles the route like the checkbox.
 */
function LeafRow({ row }: { row: PanelRow }) {
  const { checkedIds, onToggleCheck } = useContext(PanelRowContext);
  const nodeId = row.nodeId!;
  const routable = row.side !== 'connected';
  const checked = checkedIds.has(nodeId);
  return (
    <>
      <Tooltip content={!routable ? 'No route from the starting point' : checked ? 'Remove this route' : 'Add the route to this node (⌘/Ctrl+click)'}>
        <input
          type="checkbox"
          aria-label={`Show route to ${row.name}`}
          disabled={!routable}
          checked={checked}
          onChange={() => onToggleCheck(nodeId)}
          onClick={(event) => event.stopPropagation()}
          className="w-4 h-4 rounded-sm cursor-pointer ln-checkbox"
        />
      </Tooltip>
      <span
        className="ln-tree-label"
        onClickCapture={(event) => {
          if (!routable || !(event.metaKey || event.ctrlKey)) return;
          event.stopPropagation();
          onToggleCheck(nodeId);
        }}
      >
        <span className="ln-tree-type" aria-hidden="true">{row.typeIcon}</span>
        <Tooltip content={row.fullName} asChild>
          <span className="ln-tree-name">{row.name}</span>
        </Tooltip>
      </span>
    </>
  );
}

/**
 * Row body inside the widget's own `treeitem`, which owns role, selection, expansion and
 * activation; this renderer adds the section label, route checkbox and +1 level action.
 */
const TraceTreeRow = memo(function TraceTreeRow({ node, style }: NodeRendererProps<PanelRow>) {
  const { onStageIds } = useContext(PanelRowContext);
  const row = node.data;
  const offStage = row.kind === 'leaf' && !!onStageIds && !onStageIds.has(row.nodeId!);
  const rowStyle: CSSProperties = row.schemaColor
    ? { ...style, '--ln-tree-schema': row.schemaColor } as CSSProperties
    : style;
  const className = ['ln-tree-row', node.isSelected && 'ln-tree-row-active', offStage && 'ln-tree-row-offstage']
    .filter(Boolean).join(' ');
  return (
    <div style={rowStyle} data-testid={`trace-tree-row-${node.id}`} data-trace-tree-kind={row.kind} className={className}>
      {row.kind === 'side' ? <SideRow row={row} /> : null}
      {row.kind === 'leaf' ? <LeafRow row={row} /> : null}
      {row.kind === 'level' ? (
        <>
          <span className="ln-tree-chevron" aria-hidden="true">{node.isOpen ? '▾' : '▸'}</span>
          <span className="ln-tree-label">
            <span className="ln-tree-name">{row.name}</span>
            {row.count != null ? <span className="ln-tree-count">{row.count}</span> : null}
          </span>
        </>
      ) : null}
    </div>
  );
});

function toPanelRows(tree: TraceTree, resolveNode: (id: string) => TraceTreeNodeMeta | undefined): PanelRow[] {
  /** Leaves of a group, sorted by schema then name; schemaless nodes read as External like the legend. */
  const leaves = (group: TraceTreeGroup): PanelRow[] => group.nodeIds
    .map((nodeId) => {
      const meta = resolveNode(nodeId);
      const row: PanelRow = {
        id: `${group.side}:${nodeId}`,
        kind: 'leaf',
        side: group.side,
        nodeId,
        name: meta?.name ?? nodeId,
        fullName: meta?.detail ? `${meta.detail}.${meta.name}` : meta?.name ?? nodeId,
        typeIcon: typeIcon(meta?.type),
        schemaColor: schemaColor(meta?.type, meta?.detail),
      };
      return { schema: meta?.detail || 'External', row };
    })
    .sort((a, b) => a.schema.localeCompare(b.schema) || a.row.name.localeCompare(b.row.name))
    .map(({ row }) => row);
  const side = (sideId: string, sideKey: 'up' | 'down', name: string, total: number, levels: TraceTreeLevel[], nextIds: string[]): PanelRow => ({
    id: sideId,
    kind: 'side',
    side: sideKey,
    name,
    count: total,
    nextIds,
    children: levels.map((level) => ({
      id: `${sideId}-L${level.depth}`,
      kind: 'level' as const,
      level: level.depth,
      name: `L${level.depth}`,
      count: level.nodeIds.length,
      children: leaves(level),
    })),
  });
  const rows = [
    side('trace-up', 'up', '↑ Upstream', tree.totalUpstream, tree.upstream, tree.nextUpstream),
    side('trace-down', 'down', '↓ Downstream', tree.totalDownstream, tree.downstream, tree.nextDownstream),
  ];
  if (tree.connected) {
    rows.push({
      id: 'trace-connected',
      kind: 'side',
      side: 'connected',
      name: '↔ Connected',
      count: tree.connected.nodeIds.length,
      children: leaves(tree.connected),
    });
  }
  return rows;
}

/** Leaf rows in display order, the find and selection index of the tree. */
function leafRows(rows: PanelRow[]): PanelRow[] {
  return rows.flatMap((row) => (row.children ? leafRows(row.children) : [row]));
}

/**
 * Trace navigator on the shared {@link SidePanel} shell: pinned L0 starting point, fixed
 * upstream/downstream sections, widget-owned tree, footer with the route and edit status.
 * The canvas selection drives the widget's controlled `selection`; trace state stays owned by
 * the canvas.
 */
export const TraceTreePanel = memo(function TraceTreePanel({
  tree,
  originName,
  collapsed,
  onToggleCollapse,
  resolveNode,
  selectedNodeId,
  onSelectNode,
  focusTargetIds,
  onFocusTargets,
  onStageIds,
  editCounts,
  onResetTrace,
  onGrowLevel,
  removeKind,
}: TraceTreePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<TreeApi<PanelRow> | undefined>(undefined);
  const focusIndexRef = useRef<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(320);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [routeRefused, setRouteRefused] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height;
      if (next && next > 0) setViewportHeight(Math.floor(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed]);

  const data = useMemo(() => toPanelRows(tree, resolveNode), [tree, resolveNode]);
  const leaves = useMemo(() => leafRows(data), [data]);
  /** Sides and levels 1–2 start open; deeper levels start closed. */
  const initialOpenState = useMemo<Record<string, boolean>>(() => {
    const open: Record<string, boolean> = {};
    for (const side of data) {
      open[side.id] = true;
      for (const child of side.children ?? []) {
        if (child.kind === 'level' && (child.level ?? 0) <= INITIAL_OPEN_LEVELS) open[child.id] = true;
      }
    }
    return open;
  }, [data]);

  const checkedIds = useMemo(() => new Set(focusTargetIds), [focusTargetIds]);

  const toggleCheck = useCallback((id: string) => {
    const next = checkedIds.has(id) ? focusTargetIds.filter((target) => target !== id) : [...focusTargetIds, id];
    setRouteRefused(!onFocusTargets(next));
  }, [checkedIds, focusTargetIds, onFocusTargets]);

  const rowContext = useMemo<PanelContext>(
    () => ({
      checkedIds,
      onToggleCheck: toggleCheck,
      onStageIds,
      onGrowLevel,
      growsEnabled: removeKind === 'trace-prune',
    }),
    [checkedIds, toggleCheck, onStageIds, onGrowLevel, removeKind],
  );

  useEffect(() => {
    setRouteRefused(false);
  }, [tree]);

  const matches = useMemo(() => {
    const term = findQuery.trim().toLowerCase();
    if (!term) return [];
    return leaves.filter((row) => `${row.name} ${row.nodeId}`.toLowerCase().includes(term));
  }, [leaves, findQuery]);

  const currentMatch = matches.length > 0 ? matches[Math.min(findIndex, matches.length - 1)] : undefined;
  const originMeta = resolveNode(tree.originId);
  const originColor = schemaColor(originMeta?.type, originMeta?.detail);

  useEffect(() => {
    setFindIndex(0);
  }, [findQuery, tree]);

  useEffect(() => {
    if (currentMatch) void treeRef.current?.scrollTo(currentMatch.id);
  }, [currentMatch]);

  /**
   * Mirrors the canvas selection into the widget. `setSelection` selects by id even inside a
   * collapsed level (`select` skips hidden rows) and `scrollTo` opens the parents; a row already
   * selected for the same node (the other side of a cycle) is kept.
   */
  useEffect(() => {
    const api = treeRef.current;
    if (!api || api.selectedNodes[0]?.data.nodeId === (selectedNodeId ?? undefined)) return;
    const rowId = selectedNodeId ? leaves.find((row) => row.nodeId === selectedNodeId)?.id ?? null : null;
    api.setSelection({ ids: rowId ? [rowId] : [], anchor: rowId, mostRecent: rowId });
    if (rowId) void api.scrollTo(rowId);
  }, [selectedNodeId, leaves]);

  /** Keeps keyboard focus in the list when a trim removes the focused row: the row now at its index takes it. */
  useEffect(() => {
    const api = treeRef.current;
    const index = focusIndexRef.current;
    if (!api || index == null || api.focusedNode) return;
    const rows = api.visibleNodes;
    if (rows.length > 0) api.focus(rows[Math.min(index, rows.length - 1)], { scroll: false });
  }, [data]);

  const activateRow = useCallback((node: NodeApi<PanelRow>) => {
    if (node.data.nodeId) onSelectNode(node.data.nodeId);
    else if (node.data.kind !== 'side') node.toggle();
  }, [onSelectNode]);

  /** Side sections are fixed: a keyboard collapse reopens at once. */
  const keepSidesOpen = useCallback((id: string) => {
    const api = treeRef.current;
    if (api && SIDE_ROW_IDS.has(id) && !api.isOpen(id)) api.open(id);
  }, []);

  if (collapsed) {
    return (
      <div className="ln-trace-tree-collapsed" data-testid="trace-tree-collapsed">
        <Tooltip content="Show trace navigator" placement="right" asChild>
          <button type="button" aria-label="Show trace navigator" onClick={onToggleCollapse} className="ln-btn-icon w-7 h-7 flex items-center justify-center rounded-sm">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={TRACE_ICON} />
            </svg>
          </button>
        </Tooltip>
      </div>
    );
  }

  const routeCount = focusTargetIds.length;
  const edited = editCounts.added + editCounts.trimmed > 0;
  const editSummary = [
    editCounts.trimmed > 0 ? `${editCounts.trimmed} trimmed` : null,
    editCounts.added > 0 ? `${editCounts.added} added` : null,
  ].filter(Boolean).join(' · ');

  return (
    <PanelRowContext.Provider value={rowContext}>
      <SidePanel
        title="Trace"
        className="ln-trace-tree"
        closeLabel="Hide trace navigator"
        onClose={onToggleCollapse}
        actions={(
          <>
            <Tooltip content="Expand all" asChild>
              <button type="button" aria-label="Expand all" className="ln-btn-icon w-6 h-6 flex items-center justify-center rounded-sm" onClick={() => treeRef.current?.openAll()}>
                {ExpandAllIcon}
              </button>
            </Tooltip>
            <Tooltip content="Collapse all" asChild>
              <button type="button" aria-label="Collapse all" className="ln-btn-icon w-6 h-6 flex items-center justify-center rounded-sm" onClick={() => treeRef.current?.closeAll()}>
                {CollapseAllIcon}
              </button>
            </Tooltip>
          </>
        )}
        icon={(
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" style={{ color: 'var(--ln-sidebar-header-fg)' }} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d={TRACE_ICON} />
          </svg>
        )}
      >
        <section aria-label="Trace navigator" data-testid="trace-tree-panel" className="ln-trace-tree-content">
          <div className="ln-trace-tree-root" data-testid="trace-tree-anchor">
            <Tooltip content={`Starting point · recenter on ${originName}`} asChild>
              <button
                type="button"
                className="ln-trace-tree-recenter"
                style={originColor ? ({ '--ln-tree-schema': originColor } as CSSProperties) : undefined}
                aria-label={`Recenter on starting point ${originName}`}
                onClick={() => onSelectNode(tree.originId)}
              >
                <span className="ln-trace-tree-level-badge">L0</span>
                <span className="ln-tree-type" aria-hidden="true">{typeIcon(originMeta?.type)}</span>
                <span className="ln-trace-tree-origin">{originName}</span>
                <span className="ln-tree-count">↑{tree.totalUpstream} ↓{tree.totalDownstream}</span>
              </button>
            </Tooltip>
          </div>
          <div className="ln-trace-tree-find">
            <input
              type="text"
              role="searchbox"
              aria-label="Find node in trace"
              placeholder="Find node…"
              value={findQuery}
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && matches.length > 0) {
                  event.preventDefault();
                  setFindIndex((index) => (index + 1) % matches.length);
                } else if (event.key === 'ArrowUp' && matches.length > 0) {
                  event.preventDefault();
                  setFindIndex((index) => (index + matches.length - 1) % matches.length);
                } else if (event.key === 'Enter' && currentMatch) {
                  event.preventDefault();
                  if (currentMatch.nodeId) onSelectNode(currentMatch.nodeId);
                } else if (event.key === 'Escape') {
                  setFindQuery('');
                }
              }}
              className="ln-input"
            />
            {findQuery.trim() ? (
              <span className="ln-tree-detail" data-testid="trace-tree-find-count">
                {matches.length > 0 ? `${Math.min(findIndex, matches.length - 1) + 1}/${matches.length}` : '0/0'}
              </span>
            ) : null}
          </div>
          <div ref={containerRef} className="ln-trace-tree-body">
            <Tree<PanelRow>
              ref={treeRef}
              data={data}
              openByDefault={false}
              initialOpenState={initialOpenState}
              width="100%"
              height={viewportHeight}
              indent={TREE_INDENT}
              rowHeight={ROW_HEIGHT}
              disableDrag
              disableDrop
              disableMultiSelection
              disableSelect={(row) => !row.nodeId}
              onActivate={activateRow}
              onToggle={keepSidesOpen}
              onFocus={(node) => { focusIndexRef.current = node.rowIndex; }}
            >
              {TraceTreeRow}
            </Tree>
          </div>
          <footer className="ln-trace-tree-footer">
            {routeRefused ? (
              <p role="status" className="ln-tree-detail" data-testid="trace-tree-focus-refused">
                No route from the starting point to that node.
              </p>
            ) : null}
            {routeCount > 0 ? (
              <div className="ln-trace-tree-status">
                <span>Viewing {routeCount} route{routeCount === 1 ? '' : 's'}</span>
                <button type="button" className="ln-tree-action" onClick={() => onFocusTargets([])}>
                  Show all
                </button>
              </div>
            ) : null}
            {edited ? (
              <div className="ln-trace-tree-status" data-testid="trace-tree-edits">
                <span>{editSummary}</span>
                <Tooltip content="Restore the trace's starting scope" asChild>
                  <button type="button" className="ln-tree-action" onClick={onResetTrace}>
                    Reset
                  </button>
                </Tooltip>
              </div>
            ) : null}
            {routeCount === 0 && !edited ? (
              <p className="ln-tree-detail">Click: route · ⌘/Ctrl+click or ☐: add route · Del: trim</p>
            ) : null}
          </footer>
        </section>
      </SidePanel>
    </PanelRowContext.Provider>
  );
});
