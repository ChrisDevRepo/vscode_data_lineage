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
  COLUMN_TRANSFORM_NODE_MIN_HEIGHT,
  COLUMN_TRANSFORM_PORT_SPREAD,
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

/**
 * Row hover/focus transition.
 *
 * @remarks
 * Not conditioned on the reduced-motion preference here: `index.css` drops every transition under
 * both VS Code's `workbench.reduceMotion` class and the OS `prefers-reduced-motion` query, so a
 * second check in the render path could only disagree with the rule that actually applies.
 */
const ROW_TRANSITION = 'background-color 120ms ease, opacity 120ms ease';

/** Diameter of the gear circle drawn for a transform super node. */
const TRANSFORM_CIRCLE_INSET = 14;

/** Height of the name strip beneath a transform super node's circle. */
const TRANSFORM_NAME_STRIP_HEIGHT = 20;

function rowCenter(index: number): number {
  return COLUMN_NODE_HEADER_HEIGHT + index * COLUMN_ROW_HEIGHT + COLUMN_ROW_HEIGHT / 2;
}

/**
 * Handle anchor and gear-circle geometry for a transform super node.
 *
 * @remarks
 * The circle is the node's whole body, so the invisible port handles are fanned across its arc —
 * each column edge through the hub lands at its own point on the circle instead of stacking at one
 * midpoint. The vertical spread is clamped to the arc's usable span so every handle sits ON the
 * circle; `left` places the handle at the arc's x for that row, which is what makes the line meet
 * the visible stroke rather than stopping at the invisible box edge.
 */
function transformPortGeometry(portCount: number, width: number, height: number) {
  const cx = width / 2;
  const usableHeight = height - TRANSFORM_NAME_STRIP_HEIGHT;
  const cy = usableHeight / 2;
  const radius = Math.min(width, usableHeight) / 2 - TRANSFORM_CIRCLE_INSET / 2;
  const arcSpan = radius * 0.86;
  const first = cy - ((portCount - 1) * COLUMN_TRANSFORM_PORT_SPREAD) / 2;
  return { cx, cy, radius, portY: (index: number) => {
    const raw = first + index * COLUMN_TRANSFORM_PORT_SPREAD;
    return Math.min(cy + arcSpan, Math.max(cy - arcSpan, raw));
  } };
}

function ColumnTraceRowLine({
  row,
  nodeId,
  nodeTitle,
  isTransformNode,
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
  isTransformNode: boolean;
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
    backgroundColor: isHoveredRow ? 'var(--ln-hover-bg)' : 'transparent',
    // Focus only — a pointer user already has the hover background and weight to go by, and
    // painting the focus indicator on hover would also let a mouse move clear a keyboard position.
    // The pinned row is the exception: it is a standing selection, not a transient position, and it
    // carries the same yellow the object view gives a clicked node.
    boxShadow: focused ? 'inset 0 0 0 2px var(--ln-focus-border)'
      : isPinnedRow ? 'inset 0 0 0 2px var(--ln-highlight-yellow)'
      : undefined,
    transition: ROW_TRANSITION,
  };

  // Both glyphs are aria-hidden, so the row's own label is the only thing announced; it names the
  // object as well as the column, since a bare column name is ambiguous across a multi-node trace.
  const ariaLabel = `${nodeTitle} column ${row.name}${row.dataType ? `, ${row.dataType}` : ''}`;

  return (
    <div
      ref={el => registerRef(row.name, el)}
      style={style}
      role="listitem"
      // Roving tabindex: the node is one tab stop and the arrow keys move within it. Making every
      // row focusable put one stop per column in the page order, so a forty-column table cost forty
      // presses to tab past — and a trace holds many such nodes.
      tabIndex={isTabStop ? 0 : -1}
      aria-label={ariaLabel}
      onKeyDown={event => onKeyDown(event, row.name)}
      // Claimed before the canvas sees it: React Flow would otherwise read the same click as a node
      // click and select the object, replacing the column thread with the object's neighbourhood.
      onClick={event => { event.stopPropagation(); onColumnSelect(nodeId, row.name); }}
      onMouseEnter={() => onColumnHover(nodeId, row.name)}
      onMouseLeave={() => onColumnHover(nodeId, null)}
      aria-current={isPinnedRow ? 'true' : undefined}
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
      {row.dataType && (
        <span className="text-[9px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {row.dataType}
        </span>
      )}
    </div>
  );
}

/** State-of-the-art cog: one stroked gear body plus its hub, reading as "machine logic" at 22px. */
function GearGlyph() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r={3.2} />
      <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4L5.5 5.5" />
    </svg>
  );
}

/**
 * The transform super node: a circle-and-gear hub standing in for the port card a procedure used to
 * render as. The circle is the whole node — no card is drawn around it, since a procedure is a
 * process rather than an object holding columns, so its stroke carries the selection colour.
 *
 * @remarks
 * Every interaction survives the reshaping — the node keeps its id, its click and context-menu
 * wiring, and its (invisible) port handles, so neighbours, SQL and the column thread all behave
 * exactly as on the port card; only the visibility changes. The name strip sits under the circle,
 * and the AI badge/note toolbars keep their slots above and below the node box.
 */
function TransformNodeBody({ view, nodeTitle, strokeColor, boxShadow }: {
  view: ColumnTraceNodeData['view'];
  nodeTitle: string;
  /** Circle stroke — the schema colour, or the highlight colour while the node is selected. */
  strokeColor: string;
  /** Selection glow, on the circle rather than on a box that is no longer drawn. */
  boxShadow: string | undefined;
}) {
  const width = view.width || COLUMN_TRANSFORM_NODE_WIDTH;
  const height = view.height || COLUMN_TRANSFORM_NODE_MIN_HEIGHT;
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
          border: `1.5px solid ${strokeColor}`,
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
          height: TRANSFORM_NAME_STRIP_HEIGHT,
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
  const rowsVisible = data.rowsVisible !== false;
  const { hoveredPath: threadPath, pinnedRow } = useColumnHover();

  // Which row currently holds the node's single tab stop. Null until the user moves within the
  // node, so the first row is the default entry point and a re-render never steals the position.
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const registerRowRef = useCallback((name: string, el: HTMLDivElement | null) => {
    if (el) rowElements.current.set(name, el);
    else rowElements.current.delete(name);
  }, []);

  const rowNames = view.rows.map(row => row.name);
  // A row that has since disappeared from the view must not take the tab stop with it.
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
    // Claimed before the canvas sees it: React Flow binds the arrow keys to pan the viewport, which
    // would scroll the graph out from under a keyboard user stepping through a node's columns.
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

  const summaryLine = view.isTransformNode
    ? `${view.rows.length} traced ports`
    : `${view.rows.length} traced columns`;

  const rowsBlockHeight = view.rows.length * COLUMN_ROW_HEIGHT;

  // A column thread carries the same answer one level down as an object selection does: the objects
  // it runs through are the answer and the rest is context, so an object off the thread takes the
  // object view's dim rather than staying at full weight with only its rows faded.
  const offThread = !!threadPath && !view.rows.some(r => threadPath.has(columnRowKey(id, r.name)));
  // The card holding the clicked row takes the object view's yellow click-highlight, so a click at
  // column level reads exactly like a click at object level one level up.
  const ownsPin = !!pinnedRow && view.rows.some(r => columnRowKey(id, r.name) === pinnedRow);
  // Shared with CustomNode via resolveNodeHighlightStyle, so a node reads the same in both views.
  const { isHighlighted: highlighted, highlightColor, boxShadow, opacity, transform, zIndex } =
    resolveNodeHighlightStyle(ownsPin ? 'yellow' : data.highlighted, data.aiHighlight, data.dimmed || offThread);

  return (
    <>
      {data.aiBadge && <AiBadgeToolbar {...data.aiBadge} />}
      {data.aiNote && <AiNoteToolbar text={data.aiNote.text} />}
    <div
      className={view.isTransformNode ? 'transition-all duration-300 ease-in-out' : 'rounded-lg border ln-node-card transition-all duration-300 ease-in-out'}
      style={{
        position: 'relative',
        width: view.width || (view.isTransformNode ? COLUMN_TRANSFORM_NODE_WIDTH : COLUMN_NODE_WIDTH),
        height: view.height,
        // A procedure is a process, not a table: the circle IS the node, so it carries no card
        // chrome around it — the box stays as the layout and port geometry only, and the circle's
        // own stroke takes the selection colour the card border would have taken.
        ...(view.isTransformNode ? {} : {
          borderWidth: COLUMN_NODE_BORDER_WIDTH,
          borderColor: highlighted ? highlightColor : 'var(--ln-node-border)',
          borderLeftColor: highlighted ? highlightColor : schemaColor,
          borderLeftWidth: 6,
          backgroundColor: 'var(--ln-node-bg)',
          boxShadow,
        }),
        opacity,
        transform,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
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
              // A double-weight divider is the boundary between the object the card is about and the
              // columns it carries — the two halves of the card read as separate zones, not as one
              // list with a title.
              borderBottom: '2px solid var(--ln-border-strong, var(--ln-border-light))',
            }}
          >
            <span className="text-[11px]" aria-hidden="true" style={{ color: 'var(--ln-fg-muted)', lineHeight: 1 }}>{icon}</span>
            <span className="text-[10px]" style={{ color: 'var(--ln-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
              {nodeTitle}
            </span>
            <span className="text-[8px]" style={{ color: 'var(--ln-fg-muted)', flexShrink: 0 }}>{typeLabel}</span>
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
                  isTabStop={row.name === tabStopRow}
                  registerRef={registerRowRef}
                  onKeyDown={handleRowKeyDown}
                  onFocusStart={() => { setFocusedRow(row.name); setActiveRow(row.name); }}
                  onFocusEnd={() => setFocusedRow(null)}
                />
              ))
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="text-[9px]" style={{ color: 'var(--ln-fg-muted)' }}>{summaryLine}</span>
              </div>
            )}
          </div>
        </>
      )}

      {view.rows.map((row, i) => {
        // A transform super node's ports fan across the circle arc; a table card's ports sit on its
        // rows. Either way the handle is invisible — it is only the edge attachment point.
        const portStyle: CSSProperties = view.isTransformNode
          ? (() => {
              const width = view.width || COLUMN_TRANSFORM_NODE_WIDTH;
              const { cx, radius, portY } = transformPortGeometry(view.rows.length, width, view.height);
              const y = portY(i);
              const dx = Math.sqrt(Math.max(radius * radius - (y - (view.height - TRANSFORM_NAME_STRIP_HEIGHT) / 2) ** 2, 0));
              return { top: y - 4, left: cx - dx - 4 };
            })()
          : { top: rowCenter(i) };
        return (
          <Handle
            key={`t-${row.name}`}
            type="target"
            position={Position.Left}
            id={columnHandleId(row.name, 'target')}
            className="w-2! h-2! ln-handle"
            style={portStyle}
          />
        );
      })}
      {view.rows.map((row, i) => {
        const portStyle: CSSProperties = view.isTransformNode
          ? (() => {
              const width = view.width || COLUMN_TRANSFORM_NODE_WIDTH;
              const { cx, radius, portY } = transformPortGeometry(view.rows.length, width, view.height);
              const y = portY(i);
              const cy = (view.height - TRANSFORM_NAME_STRIP_HEIGHT) / 2;
              const dx = Math.sqrt(Math.max(radius * radius - (y - cy) ** 2, 0));
              return { top: y - 4, left: cx + dx - 4 };
            })()
          : { top: rowCenter(i) };
        return (
          <Handle
            key={`s-${row.name}`}
            type="source"
            position={Position.Right}
            id={columnHandleId(row.name, 'source')}
            className="w-2! h-2! ln-handle"
            style={portStyle}
          />
        );
      })}
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
