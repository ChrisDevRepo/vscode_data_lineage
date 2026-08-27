import { memo, useState, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  columnHandleId,
  COLUMN_NODE_WIDTH,
  COLUMN_NODE_HEADER_HEIGHT,
  COLUMN_ROW_HEIGHT,
  type ColumnTraceRow,
  type ColumnTraceViewNode,
  type ColumnLineState,
} from '../engine/columnTraceView';
import { TYPE_COLORS, SHORT_TYPE_LABELS, getSchemaColor } from '../utils/schemaColors';
import type { ObjectType } from '../engine/types';

/**
 * The business data associated with a single column-trace node in the React Flow canvas.
 */
export type ColumnTraceNodeData = {
  /** Positioned view node computed by {@link import('../engine/columnTraceView').buildColumnTraceView}. */
  view: ColumnTraceViewNode;
  /** Whether the row list renders; false collapses the node to a single summary line. */
  rowsVisible?: boolean;
  /** Column name currently on the hovered path; unset rows de-emphasise while this is set. */
  hoveredColumn?: string;
  /** Fires on row hover/focus enter with the column name, and on leave with `null`. */
  onColumnHover?: (nodeId: string, column: string | null) => void;
  /**
   * Per-row line state for the state dot, keyed by row name.
   *
   * @remarks
   * A row absent from this map renders an unstated dot — the map is populated by the caller from
   * edges touching this row, never computed here.
   */
  rowLineStates?: Partial<Record<string, ColumnLineState>>;
};

function reducedMotionActive(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function lineStateColor(state: ColumnLineState | undefined): string {
  if (state === 'transformation') return 'var(--ln-ai-bu)';
  if (state === 'passthrough') return 'var(--ln-fg-muted)';
  return 'var(--ln-fg-dim)';
}

function shapeLabel(row: ColumnTraceRow): string | null {
  if (!row.shape) return null;
  if (row.shape === 'fan-in') return `fan-in${typeof row.contributors === 'number' ? ` (${row.contributors})` : ''}`;
  return row.shape;
}

function rowCenter(index: number): number {
  return COLUMN_NODE_HEADER_HEIGHT + index * COLUMN_ROW_HEIGHT + COLUMN_ROW_HEIGHT / 2;
}

function ColumnTraceRowLine({
  row,
  isTransformNode,
  hoveredColumn,
  lineState,
  focused,
  transition,
  onHoverStart,
  onHoverEnd,
}: {
  row: ColumnTraceRow;
  isTransformNode: boolean;
  hoveredColumn: string | undefined;
  lineState: ColumnLineState | undefined;
  focused: boolean;
  transition: string;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}) {
  const isHoveredRow = hoveredColumn === row.name;
  const isDeemphasised = hoveredColumn !== undefined && !isHoveredRow;
  const label = shapeLabel(row);

  const style: CSSProperties = {
    height: COLUMN_ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 8px',
    opacity: isDeemphasised ? 0.5 : 1,
    backgroundColor: isHoveredRow ? 'var(--ln-hover-bg)' : 'transparent',
    boxShadow: focused ? 'inset 0 0 0 2px var(--ln-focus-border)' : undefined,
    transition,
  };

  return (
    <div
      style={style}
      tabIndex={0}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      onFocus={onHoverStart}
      onBlur={onHoverEnd}
    >
      {isTransformNode ? (
        <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--ln-fg-muted)', width: 8, textAlign: 'center', flexShrink: 0 }}>▹</span>
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            flexShrink: 0,
            backgroundColor: lineStateColor(lineState),
          }}
        />
      )}
      <span className="text-[10px]" style={{ color: 'var(--ln-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isHoveredRow ? 600 : 400 }}>
        {row.name}
      </span>
      {label && (
        <span className="text-[9px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {label}
        </span>
      )}
    </div>
  );
}

function ColumnTraceNodeComponent({ id, data }: { id: string; data: ColumnTraceNodeData }) {
  const { view } = data;
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const rowsVisible = data.rowsVisible !== false;
  const transition = reducedMotionActive() ? 'none' : 'background-color 120ms ease, opacity 120ms ease';

  const icon = TYPE_COLORS[view.objectType as ObjectType]?.icon ?? '▪';
  const typeLabel = SHORT_TYPE_LABELS[view.objectType as ObjectType] ?? view.objectType;
  const schemaColor = getSchemaColor(view.schema);

  const summaryLine = view.isTransformNode
    ? `${view.rows.length} traced ports`
    : `${view.rows.length} traced columns`;

  const rowsBlockHeight = view.rows.length * COLUMN_ROW_HEIGHT;

  const hoverStart = (column: string) => data.onColumnHover?.(id, column);
  const hoverEnd = () => data.onColumnHover?.(id, null);

  return (
    <div
      className="rounded-lg border-2 ln-node-card"
      style={{
        position: 'relative',
        width: view.width || COLUMN_NODE_WIDTH,
        height: view.height,
        borderColor: 'var(--ln-node-border)',
        borderLeftColor: schemaColor,
        borderLeftWidth: 6,
        backgroundColor: 'var(--ln-node-bg)',
        boxShadow: 'var(--ln-node-shadow)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: COLUMN_NODE_HEADER_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          flexShrink: 0,
          backgroundColor: view.isTransformNode ? 'color-mix(in srgb, var(--ln-ai-or) 16%, var(--ln-bg-elevated))' : 'var(--ln-bg-elevated)',
          borderBottom: '1px solid var(--ln-border-light)',
        }}
      >
        <span className="text-[11px]" aria-hidden="true" style={{ color: 'var(--ln-fg-muted)', lineHeight: 1 }}>{icon}</span>
        <span className="text-[10px]" style={{ color: 'var(--ln-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
          {view.schema}.{view.label}
        </span>
        {view.isTransformNode ? (
          <span className="text-[8px]" style={{ color: 'var(--ln-ai-or)', fontWeight: 700, letterSpacing: '0.03em', flexShrink: 0 }}>
            TRANSFORM
          </span>
        ) : (
          <span className="text-[8px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0 }}>{typeLabel}</span>
        )}
      </div>

      <div style={{ position: 'relative', height: rowsBlockHeight, flexShrink: 0 }}>
        {rowsVisible ? (
          view.rows.map((row) => (
            <ColumnTraceRowLine
              key={row.name}
              row={row}
              isTransformNode={view.isTransformNode}
              hoveredColumn={data.hoveredColumn}
              lineState={data.rowLineStates?.[row.name]}
              focused={focusedRow === row.name}
              transition={transition}
              onHoverStart={() => { setFocusedRow(row.name); hoverStart(row.name); }}
              onHoverEnd={() => { setFocusedRow(null); hoverEnd(); }}
            />
          ))
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="text-[9px]" style={{ color: 'var(--ln-fg-muted)' }}>{summaryLine}</span>
          </div>
        )}
      </div>

      {view.rows.map((row, i) => (
        <Handle
          key={`t-${row.name}`}
          type="target"
          position={Position.Left}
          id={columnHandleId(row.name, 'target')}
          className="w-2! h-2! ln-handle"
          style={{ top: rowCenter(i) }}
        />
      ))}
      {view.rows.map((row, i) => (
        <Handle
          key={`s-${row.name}`}
          type="source"
          position={Position.Right}
          id={columnHandleId(row.name, 'source')}
          className="w-2! h-2! ln-handle"
          style={{ top: rowCenter(i) }}
        />
      ))}
    </div>
  );
}

/**
 * Renders one traced column-trace node — an object's traced columns, or a transform's ports —
 * inside the React Flow canvas, one row per {@link ColumnTraceRow} with a handle pair on each
 * traced row.
 */
export const ColumnTraceNode = memo(ColumnTraceNodeComponent);
