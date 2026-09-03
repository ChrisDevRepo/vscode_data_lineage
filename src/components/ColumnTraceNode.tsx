import { memo, useState, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  columnHandleId,
  columnRowKey,
  COLUMN_NODE_WIDTH,
  COLUMN_NODE_HEADER_HEIGHT,
  COLUMN_NODE_BORDER_WIDTH,
  COLUMN_ROW_HEIGHT,
  type ColumnTraceRow,
  type ColumnLineState,
} from '../engine/columnTraceView';
import { useColumnHover } from '../contexts/ColumnHoverContext';
import { TYPE_COLORS, SHORT_TYPE_LABELS, getSchemaColor } from '../utils/schemaColors';
import { resolveNodeHighlightStyle } from '../utils/nodeHighlightVisuals';
import { AiBadgeToolbar, AiNoteToolbar } from './AiNodeAnnotations';
import type { ColumnTraceNodeData, ObjectType } from '../engine/types';

function lineStateColor(state: ColumnLineState | undefined): string {
  if (state === 'transformation') return 'var(--ln-ai-bu)';
  if (state === 'passthrough') return 'var(--ln-fg-muted)';
  return 'var(--ln-fg-dim)';
}

function shapeLabel(row: ColumnTraceRow): string | null {
  if (!row.shape) return null;
  if (row.shape === 'incoming' || row.shape === 'outgoing') {
    return `${row.shape}${typeof row.contributors === 'number' ? ` (${row.contributors})` : ''}`;
  }
  return row.shape;
}

/**
 * Row hover/focus transition.
 *
 * @remarks
 * Not conditioned on the reduced-motion preference here: `index.css` drops every transition under
 * both VS Code's `workbench.reduceMotion` class and the OS `prefers-reduced-motion` query, so a
 * second check in the render path could only disagree with the rule that actually applies.
 */
const ROW_TRANSITION = 'background-color 120ms ease, opacity 120ms ease';

function rowCenter(index: number): number {
  return COLUMN_NODE_HEADER_HEIGHT + index * COLUMN_ROW_HEIGHT + COLUMN_ROW_HEIGHT / 2;
}

function ColumnTraceRowLine({
  row,
  nodeId,
  nodeTitle,
  isTransformNode,
  lineState,
  focused,
  onFocusStart,
  onFocusEnd,
}: {
  row: ColumnTraceRow;
  nodeId: string;
  nodeTitle: string;
  isTransformNode: boolean;
  lineState: ColumnLineState | undefined;
  focused: boolean;
  onFocusStart: () => void;
  onFocusEnd: () => void;
}) {
  const { hoveredPath, onColumnHover } = useColumnHover();
  const isHoveredRow = !!hoveredPath?.has(columnRowKey(nodeId, row.name));
  const isDeemphasised = !!hoveredPath && !isHoveredRow;
  const label = shapeLabel(row);

  const style: CSSProperties = {
    height: COLUMN_ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 8px',
    opacity: isDeemphasised ? 0.5 : 1,
    backgroundColor: isHoveredRow ? 'var(--ln-hover-bg)' : 'transparent',
    // Focus only — a pointer user already has the hover background and weight to go by, and
    // painting the focus indicator on hover would also let a mouse move clear a keyboard position.
    boxShadow: focused ? 'inset 0 0 0 2px var(--ln-focus-border)' : undefined,
    transition: ROW_TRANSITION,
  };

  // Both glyphs are aria-hidden, so the row's own label is the only thing announced; it names the
  // object as well as the column, since a bare column name is ambiguous across a multi-node trace.
  const ariaLabel = `${nodeTitle} column ${row.name}${label ? `, ${label}` : ''}`;

  return (
    <div
      style={style}
      role="listitem"
      tabIndex={0}
      aria-label={ariaLabel}
      onMouseEnter={() => onColumnHover(nodeId, row.name)}
      onMouseLeave={() => onColumnHover(nodeId, null)}
      onFocus={() => { onFocusStart(); onColumnHover(nodeId, row.name); }}
      onBlur={() => { onFocusEnd(); onColumnHover(nodeId, null); }}
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

  const icon = TYPE_COLORS[view.objectType as ObjectType]?.icon ?? '▪';
  const typeLabel = SHORT_TYPE_LABELS[view.objectType as ObjectType] ?? view.objectType;
  const schemaColor = getSchemaColor(view.schema);
  const nodeTitle = `${view.schema}.${view.label}`;

  const summaryLine = view.isTransformNode
    ? `${view.rows.length} traced ports`
    : `${view.rows.length} traced columns`;

  const rowsBlockHeight = view.rows.length * COLUMN_ROW_HEIGHT;

  // Shared with CustomNode via resolveNodeHighlightStyle, so a node reads the same in both views.
  const { isHighlighted: highlighted, highlightColor, boxShadow, opacity, transform, zIndex } =
    resolveNodeHighlightStyle(data.highlighted, data.aiHighlight, data.dimmed);

  return (
    <>
      {data.aiBadge && <AiBadgeToolbar text={data.aiBadge.text} />}
      {data.aiNote && <AiNoteToolbar text={data.aiNote.text} />}
    <div
      className="rounded-lg border ln-node-card transition-all duration-300 ease-in-out"
      style={{
        position: 'relative',
        width: view.width || COLUMN_NODE_WIDTH,
        height: view.height,
        borderWidth: COLUMN_NODE_BORDER_WIDTH,
        borderColor: highlighted ? highlightColor : 'var(--ln-node-border)',
        borderLeftColor: highlighted ? highlightColor : schemaColor,
        borderLeftWidth: 6,
        backgroundColor: 'var(--ln-node-bg)',
        opacity,
        boxShadow,
        transform,
        zIndex,
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
          {nodeTitle}
        </span>
        {view.isTransformNode ? (
          <span className="text-[8px]" style={{ color: 'var(--ln-ai-or)', fontWeight: 700, letterSpacing: '0.03em', flexShrink: 0 }}>
            TRANSFORM
          </span>
        ) : (
          <span className="text-[8px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0 }}>{typeLabel}</span>
        )}
      </div>

      <div role={rowsVisible ? 'list' : undefined} style={{ position: 'relative', height: rowsBlockHeight, flexShrink: 0 }}>
        {rowsVisible ? (
          view.rows.map((row) => (
            <ColumnTraceRowLine
              key={row.name}
              row={row}
              nodeId={id}
              nodeTitle={nodeTitle}
              isTransformNode={view.isTransformNode}
              lineState={data.rowLineStates?.[row.name]}
              focused={focusedRow === row.name}
              onFocusStart={() => setFocusedRow(row.name)}
              onFocusEnd={() => setFocusedRow(null)}
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
    </>
  );
}

/**
 * Renders one traced column-trace node — an object's traced columns, or a transform's ports —
 * inside the React Flow canvas, one row per {@link ColumnTraceRow} with a handle pair on each
 * traced row.
 */
export const ColumnTraceNode = memo(ColumnTraceNodeComponent);
