import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist';
import type { TraceTree, TraceTreeGroup, TraceTreeLevel } from './traceTreeModel';
import type { ObjectType } from '../engine/types';
import { TYPE_COLORS, getExternalNodeColor, getSchemaColor } from '../utils/schemaColors';
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
  /** L0-anchored trace projection from the adapter. */
  tree: TraceTree;
  /** Display name of the trace origin. */
  originName: string;
  /** Collapsed to the slim rail. */
  collapsed: boolean;
  /** Collapse toggle. */
  onToggleCollapse: () => void;
  /** Label lookup by node id. */
  resolveNode: (id: string) => TraceTreeNodeMeta | undefined;
  /** Canvas selection, mirrored as the active row. */
  selectedNodeId: string | null;
  /** Row activation; the canvas owns selection. */
  onSelectNode: (id: string) => void;
  /** Focuses the checked paths; returns whether the focus applied. */
  onFocusPaths: (ids: string[]) => boolean;
  /** Exits an active focus, restoring the full scope. */
  onExitFocus: () => void;
  /** Whether a focus narrowing is on stage. */
  focusActive: boolean;
  /** Restores the trace's starting scope. */
  onResetTrace: () => void;
  /** Loads one level from the given grow candidates. */
  onGrowLevel: (candidateIds: string[]) => void;
  /** Remove intent for the current trace mode; growth honors it. */
  removeKind: 'trace-prune' | 'none';
}

/** Row shape handed to the tree widget; hierarchy only, no trace logic. */
interface PanelRow {
  /** Unique row id; a node on both sides of a cycle gets one row per side. */
  id: string;
  /** Trace node behind a leaf row; absent on group rows. */
  nodeId?: string;
  name: string;
  /** Schema-qualified name for the truncation tooltip; leaves only. */
  fullName?: string;
  /** Canvas type symbol (■ ● ▲ ◆ ⬡); leaves only. */
  typeIcon?: string;
  /** Right-aligned member count on schema clusters. */
  count?: number;
  /** Hop level of a level row; absent on other rows. */
  level?: number;
  /** Schema swatch color, consumed by CSS as --ln-tree-schema; clusters only. */
  schemaColor?: string;
  /** Out-of-scope grow candidates for leaf rows; absent on group rows. */
  growIds?: string[];
  children?: PanelRow[];
}

/** Cluster key for a leaf; schemaless nodes read as External like the legend. */
function schemaOf(meta: TraceTreeNodeMeta | undefined): string {
  return meta?.detail || 'External';
}

interface PanelSelection {
  checkedIds: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  checksEnabled: boolean;
  onGrowLevel: (candidateIds: string[]) => void;
  growsEnabled: boolean;
}

const PanelSelectionContext = createContext<PanelSelection>({
  checkedIds: new Set(),
  onToggleCheck: () => {},
  checksEnabled: true,
  onGrowLevel: () => {},
  growsEnabled: true,
});

const ROW_HEIGHT = 28;
const TREE_INDENT = 16;
/** Hop levels open on first render; deeper levels start collapsed. */
const INITIAL_OPEN_LEVELS = 2;

/**
 * Row body inside the widget's own `treeitem`, which owns role, selection, expansion and
 * activation; this renderer adds only the focus checkbox and the +level affordance.
 */
const TraceTreeRow = memo(function TraceTreeRow({ node, style }: NodeRendererProps<PanelRow>) {
  const { checkedIds, onToggleCheck, checksEnabled, onGrowLevel, growsEnabled } = useContext(PanelSelectionContext);
  const nodeId = node.data.nodeId;
  const growIds = node.data.growIds ?? [];
  const canGrow = growsEnabled && growIds.length > 0;
  const rowStyle: CSSProperties = node.data.schemaColor
    ? { ...style, '--ln-tree-schema': node.data.schemaColor } as CSSProperties
    : style;
  return (
    <div
      style={rowStyle}
      data-testid={`trace-tree-row-${node.id}`}
      data-trace-tree-kind={nodeId ? 'leaf' : 'group'}
      className={node.isSelected ? 'ln-tree-row ln-tree-row-active' : 'ln-tree-row'}
    >
      {nodeId ? (
        <Tooltip content={checksEnabled ? 'Focus path through this node' : 'Exit focus to change the selection'}>
          <input
            type="checkbox"
            aria-label={`Focus path through ${node.data.name}`}
            disabled={!checksEnabled}
            checked={checkedIds.has(nodeId)}
            onChange={() => onToggleCheck(nodeId)}
            onClick={(event) => event.stopPropagation()}
            className="w-4 h-4 rounded-sm cursor-pointer ln-checkbox"
          />
        </Tooltip>
      ) : (
        <span className="ln-tree-chevron" aria-hidden="true">{node.isOpen ? '▾' : '▸'}</span>
      )}
      <span className="ln-tree-label">
        {node.data.schemaColor ? <span className="ln-tree-swatch" aria-hidden="true" /> : null}
        {node.data.typeIcon ? <span className="ln-tree-type" aria-hidden="true">{node.data.typeIcon}</span> : null}
        {node.data.fullName ? (
          <Tooltip content={node.data.fullName} asChild>
            <span className="ln-tree-name">{node.data.name}</span>
          </Tooltip>
        ) : (
          <span className="ln-tree-name">{node.data.name}</span>
        )}
        {node.data.count != null ? <span className="ln-tree-count">{node.data.count}</span> : null}
      </span>
      {nodeId ? (
        <Tooltip content="Load one more level" asChild>
          <button
            type="button"
            aria-label={canGrow ? `Load one more level from ${node.data.name}` : `No further levels beyond ${node.data.name}`}
            disabled={!canGrow}
            className="ln-btn-icon ln-tree-grow w-7 h-7 flex items-center justify-center rounded-sm"
            onClick={(event) => {
              event.stopPropagation();
              onGrowLevel(growIds);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
});

function toPanelRows(tree: TraceTree, resolveNode: (id: string) => TraceTreeNodeMeta | undefined): PanelRow[] {
  const cluster = (groupId: string, group: TraceTreeGroup): PanelRow[] => {
    const bySchema = new Map<string, PanelRow[]>();
    for (const nodeId of group.nodeIds) {
      const meta = resolveNode(nodeId);
      const key = schemaOf(meta);
      const leaf: PanelRow = {
        id: `${group.side}:${nodeId}`,
        nodeId,
        name: meta?.name ?? nodeId,
        fullName: meta?.detail ? `${meta.detail}.${meta.name}` : meta?.name ?? nodeId,
        typeIcon: typeIcon(meta?.type),
        growIds: group.grow.get(nodeId) ?? [],
      };
      const members = bySchema.get(key);
      if (members) members.push(leaf);
      else bySchema.set(key, [leaf]);
    }
    return [...bySchema.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([schema, members]) => ({
        id: `${groupId}-schema-${schema}`,
        name: schema,
        count: members.length,
        schemaColor: schemaColor(schema === 'External' ? 'external' : undefined, schema),
        children: members.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  };
  const side = (sideId: string, name: string, levels: TraceTreeLevel[]): PanelRow => ({
    id: sideId,
    name,
    children: levels.map((level) => ({
      id: `${sideId}-L${level.depth}`,
      level: level.depth,
      name: `L${level.depth} · ${level.nodeIds.length} node${level.nodeIds.length === 1 ? '' : 's'}`,
      children: cluster(`${sideId}-L${level.depth}`, level),
    })),
  });
  const rows = [
    side('trace-up', `↑ Upstream (${tree.totalUpstream})`, tree.upstream),
    side('trace-down', `↓ Downstream (${tree.totalDownstream})`, tree.downstream),
  ];
  if (tree.connected) {
    rows.push({
      id: 'trace-connected',
      name: `↔ Connected (${tree.connected.nodeIds.length})`,
      children: cluster('trace-connected', tree.connected),
    });
  }
  return rows;
}

/** Leaf rows in display order, the find and selection index of the tree. */
function leafRows(rows: PanelRow[]): PanelRow[] {
  return rows.flatMap((row) => (row.children ? leafRows(row.children) : [row]));
}

/**
 * Docked left trace navigator: pinned L0 anchor, widget-owned tree, footer
 * with the focus actions. Rendered only while a trace is active; the canvas
 * selection drives the widget's controlled `selection`, and trace state
 * stays owned by the canvas.
 */
export const TraceTreePanel = memo(function TraceTreePanel({
  tree,
  originName,
  collapsed,
  onToggleCollapse,
  resolveNode,
  selectedNodeId,
  onSelectNode,
  onFocusPaths,
  onExitFocus,
  focusActive,
  onResetTrace,
  onGrowLevel,
  removeKind,
}: TraceTreePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<TreeApi<PanelRow> | undefined>(undefined);
  const [viewportHeight, setViewportHeight] = useState(320);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height;
      if (next && next > 0) setViewportHeight(Math.floor(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const data = useMemo(() => toPanelRows(tree, resolveNode), [tree, resolveNode]);
  const leaves = useMemo(() => leafRows(data), [data]);
  /** Sides, levels 1–2 and every schema cluster start open; deeper levels start closed. */
  const initialOpenState = useMemo<Record<string, boolean>>(() => {
    const open: Record<string, boolean> = {};
    for (const side of data) {
      open[side.id] = true;
      for (const child of side.children ?? []) {
        if (child.count != null || (child.level ?? 0) <= INITIAL_OPEN_LEVELS) open[child.id] = true;
        for (const cluster of child.children ?? []) if (cluster.children) open[cluster.id] = true;
      }
    }
    return open;
  }, [data]);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setCheckedIds(new Set());
  }, [tree]);

  useEffect(() => {
    if (!focusActive) setCheckedIds(new Set());
  }, [focusActive]);

  const toggleCheck = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selection = useMemo<PanelSelection>(
    () => ({
      checkedIds,
      onToggleCheck: toggleCheck,
      checksEnabled: !focusActive,
      onGrowLevel,
      growsEnabled: removeKind === 'trace-prune',
    }),
    [checkedIds, toggleCheck, focusActive, onGrowLevel, removeKind],
  );

  const [focusRefused, setFocusRefused] = useState(false);
  const clearChecks = useCallback(() => setCheckedIds(new Set()), []);

  useEffect(() => {
    setFocusRefused(false);
  }, [checkedIds, tree]);

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

  const activateRow = useCallback((node: NodeApi<PanelRow>) => {
    if (node.data.nodeId) onSelectNode(node.data.nodeId);
    else node.toggle();
  }, [onSelectNode]);

  if (collapsed) {
    return (
      <div className="ln-trace-tree-collapsed" data-testid="trace-tree-collapsed">
        <Tooltip content="Expand trace navigator" placement="right" asChild>
          <button type="button" aria-label="Expand trace navigator" onClick={onToggleCollapse} className="ln-btn-icon w-7 h-7 flex items-center justify-center rounded-sm">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <PanelSelectionContext.Provider value={selection}>
      <section
        aria-label="Trace navigator"
        data-testid="trace-tree-panel"
        className="ln-trace-tree"
      >
        <header className="ln-trace-tree-header">
          <span className="ln-trace-tree-title">Trace</span>
          <Tooltip content="Collapse trace navigator" asChild>
            <button type="button" aria-label="Collapse trace navigator" onClick={onToggleCollapse} className="ln-btn-icon w-7 h-7 flex items-center justify-center rounded-sm">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          </Tooltip>
        </header>
        <div className="ln-trace-tree-anchor" data-testid="trace-tree-anchor">
          <Tooltip content={`Recenter on ${originName}`} asChild>
            <button
              type="button"
              className="ln-trace-tree-recenter"
              style={originColor ? ({ '--ln-tree-schema': originColor } as CSSProperties) : undefined}
              aria-label={`Recenter trace origin ${originName}`}
              onClick={() => onSelectNode(tree.originId)}
            >
              <span className="ln-tree-type" aria-hidden="true">{typeIcon(originMeta?.type)}</span>
              <span className="flex flex-col items-start min-w-0">
                <span className="ln-trace-tree-origin">{originName}</span>
                <span className="ln-tree-detail">L0 · ↑{tree.totalUpstream} ↓{tree.totalDownstream}</span>
              </span>
            </button>
          </Tooltip>
          <Tooltip content="Reset trace to its starting scope" asChild>
            <button
              type="button"
              className="ln-btn-icon w-7 h-7 flex items-center justify-center rounded-sm"
              aria-label="Reset trace to its starting scope"
              onClick={onResetTrace}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
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
          >
            {TraceTreeRow}
          </Tree>
        </div>
        <footer className="ln-trace-tree-footer">
          {checkedIds.size === 0 && !focusActive ? (
            <p className="ln-tree-detail">Check nodes to focus the paths to them.</p>
          ) : null}
          {focusRefused && !focusActive ? (
            <p role="status" className="ln-tree-detail" data-testid="trace-tree-focus-refused">
              No single-direction path from the origin to every checked node.
            </p>
          ) : null}
          <div className="ln-trace-tree-actions">
            {focusActive ? (
              <button
                type="button"
                className="ln-tree-action"
                onClick={() => {
                  onExitFocus();
                  clearChecks();
                }}
              >
                Exit focus
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="ln-tree-action"
                  disabled={checkedIds.size === 0}
                  onClick={() => setFocusRefused(!onFocusPaths([...checkedIds]))}
                >
                  Focus paths ({checkedIds.size})
                </button>
                {checkedIds.size > 0 ? (
                  <button type="button" className="ln-tree-action" onClick={clearChecks}>
                    Clear
                  </button>
                ) : null}
              </>
            )}
          </div>
        </footer>
      </section>
    </PanelSelectionContext.Provider>
  );
});
