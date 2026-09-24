import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';
import type { TraceTree } from './traceTreeModel';
import type { ObjectType } from '../engine/types';
import { TYPE_COLORS, getExternalNodeColor, getSchemaColor } from '../utils/schemaColors';

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
  /** Trace ignores schema/type filters. */
  useFullModel: boolean;
  /** Full-model toggle (relocated from the filter banner). */
  onToggleFullModel: () => void;
  /** Nodes hidden by active filters, for the footer hint. */
  filteredOutCount: number;
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
  /** Prunes the node, identical to canvas Delete. */
  onPruneNode: (id: string) => void;
  /** Restores the trace's starting scope. */
  onResetTrace: () => void;
  /** Loads one level from the given grow candidates. */
  onGrowLevel: (candidateIds: string[]) => void;
  /** Remove intent for the current trace mode; Delete and growth honor it. */
  removeKind: 'trace-prune' | 'none';
}

/** Row shape handed to the tree widget; hierarchy only, no trace logic. */
interface PanelRow {
  id: string;
  name: string;
  /** Canvas type symbol (■ ● ▲ ◆ ⬡); leaves only. */
  typeIcon?: string;
  /** Right-aligned member count on schema clusters. */
  count?: number;
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
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleCheck: (id: string) => void;
  checksEnabled: boolean;
  onGrowLevel: (candidateIds: string[]) => void;
  growsEnabled: boolean;
}

const PanelSelectionContext = createContext<PanelSelection>({
  selectedNodeId: null,
  onSelectNode: () => {},
  checkedIds: new Set(),
  onToggleCheck: () => {},
  checksEnabled: true,
  onGrowLevel: () => {},
  growsEnabled: true,
});

const ROW_HEIGHT = 28;
const TREE_INDENT = 16;

/** Fixed row height keeps virtualized scroll positions stable. */
const TraceTreeRow = memo(function TraceTreeRow({ node, style }: NodeRendererProps<PanelRow>) {
  const { selectedNodeId, onSelectNode, checkedIds, onToggleCheck, checksEnabled, onGrowLevel, growsEnabled } = useContext(PanelSelectionContext);
  const active = node.id === selectedNodeId;
  const growIds = node.data.growIds ?? [];
  const canGrow = growsEnabled && growIds.length > 0;
  const rowStyle: CSSProperties = node.data.schemaColor
    ? { ...style, '--ln-tree-schema': node.data.schemaColor } as CSSProperties
    : style;
  return (
    <div
      style={rowStyle}
      role="treeitem"
      aria-selected={active}
      aria-expanded={node.isLeaf ? undefined : node.isOpen}
      data-testid={`trace-tree-row-${node.id}`}
      data-trace-tree-kind={node.isLeaf ? 'leaf' : 'group'}
      className={active ? 'ln-tree-row ln-tree-row-active' : 'ln-tree-row'}
    >
      {node.isLeaf ? (
        <input
          type="checkbox"
          aria-label={`Focus path through ${node.data.name}`}
          title={checksEnabled ? 'Focus path through this node' : 'Exit focus to change the selection'}
          disabled={!checksEnabled}
          checked={checkedIds.has(node.id)}
          onChange={() => onToggleCheck(node.id)}
          onClick={(event) => event.stopPropagation()}
          className="ln-checkbox"
        />
      ) : (
        <button
          type="button"
          aria-label={node.isOpen ? `Collapse ${node.data.name}` : `Expand ${node.data.name}`}
          className="ln-tree-chevron"
          onClick={(event) => {
            event.stopPropagation();
            node.toggle();
          }}
        >
          {node.isOpen ? '▾' : '▸'}
        </button>
      )}
      <button
        type="button"
        className="ln-tree-label"
        onClick={() => {
          if (node.isLeaf) {
            onSelectNode(node.id);
          } else {
            node.toggle();
          }
        }}
      >
        {node.data.schemaColor ? <span className="ln-tree-swatch" aria-hidden="true" /> : null}
        {node.data.typeIcon ? <span className="ln-tree-type" aria-hidden="true">{node.data.typeIcon}</span> : null}
        <span className="ln-tree-name">{node.data.name}</span>
        {node.data.count != null ? <span className="ln-tree-count">{node.data.count}</span> : null}
      </button>
      {node.isLeaf ? (
        <button
          type="button"
          aria-label={canGrow ? `Load one more level from ${node.data.name}` : `No further levels beyond ${node.data.name}`}
          title={canGrow ? 'Load one more level' : 'No further levels in the full model'}
          disabled={!canGrow}
          className="ln-tree-grow"
          onClick={(event) => {
            event.stopPropagation();
            onGrowLevel(growIds);
          }}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      ) : null}
    </div>
  );
});

function toPanelRows(tree: TraceTree, resolveNode: (id: string) => TraceTreeNodeMeta | undefined): PanelRow[] {
  const leaf = (id: string): PanelRow => {
    const meta = resolveNode(id);
    return {
      id,
      name: meta?.name ?? id,
      typeIcon: typeIcon(meta?.type),
      growIds: tree.leafGrow.get(id) ?? [],
    };
  };
  const cluster = (sideId: string, depth: number, ids: string[]): PanelRow[] => {
    const bySchema = new Map<string, { id: string; name: string }[]>();
    for (const id of ids) {
      const meta = resolveNode(id);
      const key = schemaOf(meta);
      const members = bySchema.get(key);
      const member = { id, name: meta?.name ?? id };
      if (members) members.push(member);
      else bySchema.set(key, [member]);
    }
    return [...bySchema.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([schema, members]) => {
        members.sort((a, b) => a.name.localeCompare(b.name));
        return {
          id: `${sideId}-L${depth}-schema-${schema}`,
          name: schema,
          count: members.length,
          schemaColor: schema === 'External' ? getExternalNodeColor() : getSchemaColor(schema),
          children: members.map((member) => leaf(member.id)),
        };
      });
  };
  const side = (sideId: string, name: string, levels: TraceTree['upstream']): PanelRow => ({
    id: sideId,
    name,
    children: levels.map((level) => ({
      id: `${sideId}-L${level.depth}`,
      name: `L${level.depth} · ${level.nodeIds.length} node${level.nodeIds.length === 1 ? '' : 's'}`,
      children: cluster(sideId, level.depth, level.nodeIds),
    })),
  });
  return [
    side('trace-up', `↑ Upstream (${tree.totalUpstream})`, tree.upstream),
    side('trace-down', `↓ Downstream (${tree.totalDownstream})`, tree.downstream),
  ];
}

/**
 * Docked left trace navigator: pinned L0 anchor, widget-owned tree, footer
 * with the relocated full-model toggle. Rendered only while a trace is
 * active; selection and trace state stay owned by the canvas.
 */
export const TraceTreePanel = memo(function TraceTreePanel({
  tree,
  originName,
  collapsed,
  onToggleCollapse,
  useFullModel,
  onToggleFullModel,
  filteredOutCount,
  resolveNode,
  selectedNodeId,
  onSelectNode,
  onFocusPaths,
  onExitFocus,
  focusActive,
  onPruneNode,
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
  const initialOpenState = useMemo<Record<string, boolean>>(() => {
    const open: Record<string, boolean> = { 'trace-up': true, 'trace-down': true };
    const sides: Array<[string, TraceTree['upstream']]> = [
      ['trace-up', tree.upstream],
      ['trace-down', tree.downstream],
    ];
    for (const [sideId, levels] of sides) {
      for (const level of levels) {
        if (level.depth <= 2) open[`${sideId}-L${level.depth}`] = true;
        for (const id of level.nodeIds) {
          open[`${sideId}-L${level.depth}-schema-${schemaOf(resolveNode(id))}`] = true;
        }
      }
    }
    return open;
  }, [tree, resolveNode]);
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
      selectedNodeId,
      onSelectNode,
      checkedIds,
      onToggleCheck: toggleCheck,
      checksEnabled: !focusActive,
      onGrowLevel,
      growsEnabled: removeKind === 'trace-prune',
    }),
    [selectedNodeId, onSelectNode, checkedIds, toggleCheck, focusActive, onGrowLevel, removeKind],
  );

  const clearChecks = useCallback(() => setCheckedIds(new Set()), []);

  const matches = useMemo(() => {
    const term = findQuery.trim().toLowerCase();
    if (!term) return [];
    const found: string[] = [];
    const visit = (rows: PanelRow[]) => {
      for (const row of rows) {
        if (row.children) {
          visit(row.children);
        } else {
          const meta = resolveNode(row.id);
          const haystack = `${meta?.name ?? row.id} ${row.id}`.toLowerCase();
          if (haystack.includes(term)) found.push(row.id);
        }
      }
    };
    visit(data);
    return found;
  }, [data, findQuery, resolveNode]);

  const reveal = useCallback((id: string) => {
    const api = treeRef.current;
    const node = api?.get(id);
    if (!api || !node) return;
    let parent = node.parent;
    while (parent) {
      api.open(parent.id);
      parent = parent.parent;
    }
    void api.scrollTo(id);
  }, []);

  const currentMatch = matches.length > 0 ? matches[Math.min(findIndex, matches.length - 1)] : undefined;
  const originMeta = resolveNode(tree.originId);
  const originColor = schemaColor(originMeta?.type, originMeta?.detail);

  useEffect(() => {
    setFindIndex(0);
  }, [findQuery, tree]);

  useEffect(() => {
    if (currentMatch) reveal(currentMatch);
    else if (selectedNodeId) reveal(selectedNodeId);
  }, [currentMatch, selectedNodeId, reveal]);

  if (collapsed) {
    return (
      <div className="ln-trace-tree-collapsed" data-testid="trace-tree-collapsed">
        <button type="button" aria-label="Expand trace navigator" title="Expand trace navigator" onClick={onToggleCollapse} className="ln-trace-tree-collapse">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <PanelSelectionContext.Provider value={selection}>
      <section
        aria-label="Trace navigator"
        data-testid="trace-tree-panel"
        className="ln-trace-tree"
        onKeyDown={(event) => {
          if (event.key !== 'Delete' || event.target instanceof HTMLInputElement) return;
          if (removeKind !== 'trace-prune' || !selectedNodeId) return;
          event.preventDefault();
          onPruneNode(selectedNodeId);
        }}
      >
        <header className="ln-trace-tree-header">
          <span className="ln-trace-tree-title">Trace</span>
          <button type="button" aria-label="Collapse trace navigator" title="Collapse trace navigator" onClick={onToggleCollapse} className="ln-trace-tree-collapse">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </header>
        <div className="ln-trace-tree-anchor" data-testid="trace-tree-anchor">
          <button
            type="button"
            className="ln-trace-tree-recenter"
            style={originColor ? ({ '--ln-tree-schema': originColor } as CSSProperties) : undefined}
            aria-label={`Recenter trace origin ${originName}`}
            title={`Recenter on ${originName}`}
            onClick={() => onSelectNode(tree.originId)}
          >
            <span className="ln-tree-type" aria-hidden="true">{typeIcon(originMeta?.type)}</span>
            <span className="ln-tree-label-text">
              <span className="ln-trace-tree-origin">{originName}</span>
              <span className="ln-tree-detail">L0 · ↑{tree.totalUpstream} ↓{tree.totalDownstream}</span>
            </span>
          </button>
          <button
            type="button"
            className="ln-btn-icon w-7 h-7 flex items-center justify-center rounded-sm"
            aria-label="Reset trace to its starting scope"
            title="Reset trace to its starting scope"
            onClick={onResetTrace}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
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
                onSelectNode(currentMatch);
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
            selectionFollowsFocus={false}
          >
            {TraceTreeRow}
          </Tree>
        </div>
        <footer className="ln-trace-tree-footer">
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
                  title={checkedIds.size === 0 ? 'Check one or more nodes to focus their paths' : undefined}
                  onClick={() => {
                    if (onFocusPaths([...checkedIds])) return;
                    clearChecks();
                  }}
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
          <label className="flex items-center gap-1 text-xs ln-text-muted cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={useFullModel}
              onChange={onToggleFullModel}
              className="ln-checkbox"
            />
            Show all, ignoring filters
            {!useFullModel && filteredOutCount > 0 ? <span> (+{filteredOutCount})</span> : null}
          </label>
        </footer>
      </section>
    </PanelSelectionContext.Provider>
  );
});
