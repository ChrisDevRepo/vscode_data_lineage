import { memo, useCallback, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  columnHandleId,
  columnRowKey,
  COLUMN_NODE_WIDTH,
  COLUMN_NODE_HEADER_HEIGHT,
  COLUMN_NODE_BORDER_WIDTH,
  COLUMN_ROW_HEIGHT,
  COLUMN_ROW_DIM_OPACITY,
  COLUMN_TRANSFORM_NODE_WIDTH,
  COLUMN_TRANSFORM_CIRCLE_DIAMETER,
  COLUMN_TRANSFORM_NAME_STRIP_HEIGHT,
  COLUMN_TRANSFORM_NODE_HEIGHT,
  COLUMN_TRANSFORM_PORT_SPREAD,
  type ColumnTraceRow,
  type ColumnLineState,
} from '../engine/columnTraceView';
import { useColumnHover } from '../contexts/ColumnHoverContext';
import { TYPE_COLORS, SHORT_TYPE_LABELS, getSchemaColor } from '../utils/schemaColors';
import { resolveNodeHighlightStyle } from '../utils/nodeHighlightVisuals';
import { AiBadgeToolbar, AiNoteToolbar } from './AiNodeAnnotations';
import { NodeRemoveButton, TraceControlsRail, TraceNeighborPickerToolbar } from './CustomNode';
import { useTraceNeighborPicker } from '../hooks/useTraceNeighborPicker';
import type { ColumnTraceNodeData, ObjectType } from '../engine/types';

function lineStateColor(state: ColumnLineState | undefined): string {
  if (state === 'transformation') return 'var(--ln-ai-bu)';
  if (state === 'passthrough') return 'var(--ln-fg-muted)';
  return 'var(--ln-fg-dim)';
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

/** Tint of a row on the active column thread — the lit-edge colour, softened behind the text. */
const THREAD_ROW_BACKGROUND = 'color-mix(in srgb, var(--ln-focus-border) 18%, transparent)';

function rowCenter(index: number): number {
  return COLUMN_NODE_HEADER_HEIGHT + index * COLUMN_ROW_HEIGHT + COLUMN_ROW_HEIGHT / 2;
}

/**
 * Handle anchor and circle geometry for a transform super node.
 *
 * @remarks
 * The circle is the node's whole body with a fixed size, so port handles fan across its arc — at
 * {@link COLUMN_TRANSFORM_PORT_SPREAD} apart while that fits, closer as more ports run through the
 * hub — so every handle sits ON the circle and each edge meets the visible stroke, not the box edge.
 */
function transformPortGeometry(portCount: number, width: number, height: number) {
  const cx = width / 2;
  const cy = (height - COLUMN_TRANSFORM_NAME_STRIP_HEIGHT) / 2;
  const radius = COLUMN_TRANSFORM_CIRCLE_DIAMETER / 2;
  const arcSpan = radius * 0.86;
  const spread = portCount > 1 ? Math.min(COLUMN_TRANSFORM_PORT_SPREAD, (2 * arcSpan) / (portCount - 1)) : 0;
  const first = cy - ((portCount - 1) * spread) / 2;
  return { cx, cy, radius, portY: (index: number) => first + index * spread };
}

/** Half the rendered handle box (`w-2 h-2`), subtracted so the anchor point sits at its centre. */
const HANDLE_HALF = 4;

/**
 * Absolute offset of one row's edge-attachment handle.
 *
 * @remarks
 * A transform node's ports fan across the circle arc, so `left` places the handle at that row's arc
 * x — what makes the line meet the visible stroke rather than the invisible box edge. A table card's
 * ports sit on the row centre alone; either way the handle itself stays invisible.
 */
function portHandleStyle(view: ColumnTraceNodeData['view'], index: number, side: 'source' | 'target'): CSSProperties {
  if (!view.isTransformNode) return { top: rowCenter(index) };
  const width = view.width || COLUMN_TRANSFORM_NODE_WIDTH;
  const height = view.height || COLUMN_TRANSFORM_NODE_HEIGHT;
  const { cx, cy, radius, portY } = transformPortGeometry(view.rows.length, width, height);
  const y = portY(index);
  const dx = Math.sqrt(Math.max(radius * radius - (y - cy) ** 2, 0));
  return { top: y - HANDLE_HALF, left: (side === 'source' ? cx + dx : cx - dx) - HANDLE_HALF };
}

function ColumnTraceRowLine({
  row,
  nodeId,
  nodeTitle,
  lineState,
  focused,
  isTabStop,
  registerRef,
  onKeyDown,
  onFocusStart,
  onFocusEnd,
}: {
  row: ColumnTraceRow;
  nodeId: string;
  nodeTitle: string;
  lineState: ColumnLineState | undefined;
  focused: boolean;
  isTabStop: boolean;
  registerRef: (name: string, el: HTMLDivElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, name: string) => void;
  onFocusStart: () => void;
  onFocusEnd: () => void;
}) {
  const { hoveredPath, onColumnHover, onColumnSelect, pinnedRow } = useColumnHover();
  const rowKey = columnRowKey(nodeId, row.name);
  const isHoveredRow = !!hoveredPath?.has(rowKey);
  const isDeemphasised = !!hoveredPath && !isHoveredRow;
  const isPinnedRow = pinnedRow === rowKey;

  const style: CSSProperties = {
    height: COLUMN_ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 8px',
    opacity: isDeemphasised ? COLUMN_ROW_DIM_OPACITY : 1,
    backgroundColor: isHoveredRow ? THREAD_ROW_BACKGROUND : 'transparent',
    boxShadow: focused ? 'inset 0 0 0 2px var(--ln-focus-border)'
      : isPinnedRow ? 'inset 0 0 0 2px var(--ln-highlight-yellow)'
      : isHoveredRow ? 'inset 3px 0 0 var(--ln-focus-border)'
      : undefined,
    transition: ROW_TRANSITION,
  };

  const ariaLabel = `${nodeTitle} column ${row.name}${row.dataType ? `, ${row.dataType}` : ''}`;

  return (
    <div
      ref={el => registerRef(row.name, el)}
      style={style}
      role="listitem"
      tabIndex={isTabStop ? 0 : -1}
      aria-label={ariaLabel}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onColumnSelect(nodeId, row.name);
          return;
        }
        onKeyDown(event, row.name);
      }}
      onClick={event => { event.stopPropagation(); onColumnSelect(nodeId, row.name); }}
      onMouseEnter={() => onColumnHover(nodeId, row.name)}
      onMouseLeave={() => onColumnHover(nodeId, null)}
      aria-current={isPinnedRow ? 'true' : undefined}
      onFocus={() => { onFocusStart(); onColumnHover(nodeId, row.name); }}
      onBlur={() => { onFocusEnd(); onColumnHover(nodeId, null); }}
    >
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
      <span className="text-[10px]" style={{ color: 'var(--ln-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isHoveredRow ? 600 : 400 }}>
        {row.name}
      </span>
      {row.dataType && (
        <span className="text-[9px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {row.dataType}
        </span>
      )}
    </div>
  );
}

/** Process cog in the Lucide "settings" silhouette, lightly filled so it reads at 18px. */
function GearGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillOpacity={0.18}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" fill="var(--ln-bg-elevated)" fillOpacity={1} />
    </svg>
  );
}

/**
 * The transform super node: a circle-and-gear hub for a procedure or scalar function.
 *
 * @remarks
 * The circle is the whole node with no card drawn around it, so its stroke carries the selection
 * colour; it keeps its id, click/context-menu wiring and invisible port handles so neighbours, SQL
 * and the column thread behave exactly as on a column card. The name strip sits under the circle.
 */
function TransformNodeBody({ view, nodeTitle, strokeColor, boxShadow }: {
  view: ColumnTraceNodeData['view'];
  nodeTitle: string;
  /** Circle stroke — the schema colour, or the highlight colour while the node is selected. */
  strokeColor: string;
  /** Selection glow, drawn on the circle; no card box surrounds it. */
  boxShadow: string | undefined;
}) {
  const width = view.width || COLUMN_TRANSFORM_NODE_WIDTH;
  const height = view.height || COLUMN_TRANSFORM_NODE_HEIGHT;
  const { cx, cy, radius } = transformPortGeometry(view.rows.length, width, height);
  const schemaColor = getSchemaColor(view.schema);

  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: cx - radius,
          top: cy - radius,
          width: radius * 2,
          height: radius * 2,
          borderRadius: '50%',
          border: `1px solid ${strokeColor}`,
          background: `color-mix(in srgb, ${schemaColor} 10%, var(--ln-bg-elevated))`,
          boxShadow,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ln-fg-muted)',
          pointerEvents: 'none',
        }}
      >
        <GearGlyph />
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: COLUMN_TRANSFORM_NAME_STRIP_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 4px',
        }}
      >
        <span className="text-[10px]" style={{ color: 'var(--ln-fg)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nodeTitle}
        </span>
      </div>
    </>
  );
}

function ColumnTraceNodeComponent({ id, data }: { id: string; data: ColumnTraceNodeData }) {
  const { view } = data;
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const { hoveredPath: threadPath, pinnedRow } = useColumnHover();
  const { picker, applyTraceAction, closePicker, selectPickerOption } = useTraceNeighborPicker(data.traceControls);

  const [activeRow, setActiveRow] = useState<string | null>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const registerRowRef = useCallback((name: string, el: HTMLDivElement | null) => {
    if (el) rowElements.current.set(name, el);
    else rowElements.current.delete(name);
  }, []);

  const rowNames = view.rows.map(row => row.name);
  const tabStopRow = activeRow && rowNames.includes(activeRow) ? activeRow : rowNames[0];

  const handleRowKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>, name: string) => {
    const names = view.rows.map(row => row.name);
    const from = names.indexOf(name);
    if (from < 0) return;
    const to =
      event.key === 'ArrowDown' ? Math.min(from + 1, names.length - 1)
      : event.key === 'ArrowUp' ? Math.max(from - 1, 0)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? names.length - 1
      : -1;
    if (to < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = names[to];
    setActiveRow(target);
    rowElements.current.get(target)?.focus();
  }, [view.rows]);

  const icon = TYPE_COLORS[view.objectType as ObjectType]?.icon ?? '▪';
  const typeLabel = SHORT_TYPE_LABELS[view.objectType as ObjectType] ?? view.objectType;
  const schemaColor = getSchemaColor(view.schema);
  const nodeTitle = `${view.schema}.${view.label}`;

  const rowsBlockHeight = view.rows.length * COLUMN_ROW_HEIGHT;

  const offThread = !!threadPath && !view.rows.some(r => threadPath.has(columnRowKey(id, r.name)));
  const ownsPin = !!pinnedRow && view.rows.some(r => columnRowKey(id, r.name) === pinnedRow);
  const onPinnedThread = !!pinnedRow && !!threadPath && !offThread;
  const { isHighlighted: highlighted, highlightColor, boxShadow, opacity, zIndex } =
    resolveNodeHighlightStyle(ownsPin ? 'yellow' : onPinnedThread || data.highlighted, data.aiHighlight, data.dimmed || offThread);

  return (
    <>
      {picker && (
        <TraceNeighborPickerToolbar picker={picker} onClose={closePicker} onSelect={selectPickerOption} />
      )}
      {data.aiBadge && <AiBadgeToolbar {...data.aiBadge} />}
      {data.aiNote && <AiNoteToolbar text={data.aiNote.text} />}
    {/* The trace +/- buttons sit outside the card edge, so they live on this unclipped box; the dim
        sits here too, so an off-thread card's buttons fade with it. */}
    <div
      className="transition duration-300 ease-in-out"
      style={{
        position: 'relative',
        width: view.width || (view.isTransformNode ? COLUMN_TRANSFORM_NODE_WIDTH : COLUMN_NODE_WIDTH),
        height: view.height,
        opacity,
        zIndex,
      }}
    >
      <TraceControlsRail traceControls={data.traceControls} onAction={applyTraceAction} />
    <div
      className={view.isTransformNode ? 'transition-all duration-300 ease-in-out' : 'rounded-lg border ln-node-card transition-all duration-300 ease-in-out'}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        ...(view.isTransformNode ? {} : {
          borderWidth: COLUMN_NODE_BORDER_WIDTH,
          borderColor: highlighted ? highlightColor : 'var(--ln-node-border)',
          borderLeftColor: highlighted ? highlightColor : schemaColor,
          borderLeftWidth: 6,
          backgroundColor: 'var(--ln-node-bg)',
          boxShadow,
        }),
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {data.showRemoveButton && <NodeRemoveButton id={id} onRemove={data.onRemoveFromView} />}
      {view.isTransformNode ? (
        <TransformNodeBody
          view={view}
          nodeTitle={nodeTitle}
          strokeColor={highlighted ? highlightColor : schemaColor}
          boxShadow={boxShadow}
        />
      ) : (
        <>
          <div
            style={{
              height: COLUMN_NODE_HEADER_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
              flexShrink: 0,
              backgroundColor: 'var(--ln-bg-elevated)',
              borderBottom: '2px solid var(--ln-border-light)',
            }}
          >
            <span className="text-[11px]" aria-hidden="true" style={{ color: 'var(--ln-fg-muted)', lineHeight: 1 }}>{icon}</span>
            <span className="text-[10px]" style={{ color: 'var(--ln-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
              {nodeTitle}
            </span>
            <span className="text-[8px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0 }}>{typeLabel}</span>
          </div>

          <div role="list" style={{ position: 'relative', height: rowsBlockHeight, flexShrink: 0 }}>
            {view.rows.map((row) => (
              <ColumnTraceRowLine
                key={row.name}
                row={row}
                nodeId={id}
                nodeTitle={nodeTitle}
                lineState={data.rowLineStates?.[row.name]}
                focused={focusedRow === row.name}
                isTabStop={row.name === tabStopRow}
                registerRef={registerRowRef}
                onKeyDown={handleRowKeyDown}
                onFocusStart={() => { setFocusedRow(row.name); setActiveRow(row.name); }}
                onFocusEnd={() => setFocusedRow(null)}
              />
            ))}
          </div>
        </>
      )}

      {view.rows.map((row, i) => (
        <Handle
          key={`t-${row.name}`}
          type="target"
          position={Position.Left}
          id={columnHandleId(row.name, 'target')}
          className="w-2! h-2! ln-handle"
          style={portHandleStyle(view, i, 'target')}
        />
      ))}
      {view.rows.map((row, i) => (
        <Handle
          key={`s-${row.name}`}
          type="source"
          position={Position.Right}
          id={columnHandleId(row.name, 'source')}
          className="w-2! h-2! ln-handle"
          style={portHandleStyle(view, i, 'source')}
        />
      ))}
    </div>
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
