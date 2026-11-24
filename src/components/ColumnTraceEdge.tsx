import { memo, type ReactNode } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { Tooltip } from './ui/Tooltip';
import { COLUMN_TRANSFORM_DIRECTION, type ColumnTransformClass } from '../engine/shared/bridgeContract';
import { COLUMN_EDGE_DIM_OPACITY } from '../engine/columnTraceView';
import type { ColumnLineState } from '../engine/columnTraceView';

/** Stroke width of a column-view edge lit by hover or selection. */
const LIT_STROKE_WIDTH = 1.6;

/** Stroke width of a column-view edge outside the lit set. */
const DIM_STROKE_WIDTH = 1;

/**
 * Dash pattern of an object-level line: no column value crosses it, and the combined line of
 * columns on the indirect side of the trace (e.g. a WHERE or JOIN predicate column, or a co-input
 * off the traced chain) is one.
 */
const INDIRECT_DASH_PATTERN = '5 4';

/** Outer size, in px, of the marker chip centred on the edge path. */
const COLUMN_EDGE_CHIP_SIZE = 32;

/** Size, in px, of a glyph drawn inside the chip. */
const CHIP_GLYPH_SIZE = 20;

/** How many class glyphs the chip shows before the remainder collapses into a count. */
const CHIP_MAX_GLYPHS = 2;

/**
 * Payload a column-view edge carries to its renderer; indexed to satisfy React Flow's edge-data
 * constraint. `lit` is resolved by the canvas, which owns the hovered column path.
 */
export interface ColumnTraceEdgeData extends Record<string, unknown> {
  /** Whether the value changed between the two endpoints. */
  state: ColumnLineState;
  /** Inside the lit set: the hovered column path, or the selected node's edges. */
  lit: boolean;
  /** Lit by a narrowing (hovered or selected column path or node): the chip takes the highlight. */
  focused?: boolean;
  /** Source column name as recorded, for the marker's hover text. */
  sourceColumn: string;
  /** Target column name as recorded, for the marker's hover text. */
  targetColumn: string;
  /** Transform classes the model recorded; absent on an unclassified edge. */
  transforms?: ColumnTransformClass[];
  /** One-clause model note for the edge; absent whenever the model offered none. */
  note?: string;
  /**
   * Object-level dependency rather than a column thread: drawn broken (no column value crosses it).
   * Marked with a chip only when it is the combined line of indirect columns (`transforms` set).
   */
  objectLevel?: boolean;
  /** Indirect columns a combined object-level line stands for, named in its tooltip. */
  columns?: string[];
}

/** Display name of a transform class, as the first line of the chip tooltip; user-facing. */
export const COLUMN_TRANSFORM_CLASS_LABELS: Readonly<Record<ColumnTransformClass, string>> = {
  pass_through: 'Pass through',
  compute: 'Compute',
  aggregate: 'Aggregate',
  combine: 'Combine',
  filter: 'Filter',
};

/**
 * The distinct classes an edge marks — one glyph and one label per class. A column edge leaves
 * identity unmarked; a combined line keeps `pass_through`, since there it names a value source off
 * the traced path.
 */
function markedTransformClasses(transforms: readonly ColumnTransformClass[] | undefined, combinedLine: boolean): ColumnTransformClass[] {
  const classes = [...new Set(transforms ?? [])];
  return combinedLine ? classes : classes.filter(c => c !== 'pass_through');
}

/**
 * Tooltip text of the marker chip: the class names, then the model's one-clause note when it gave
 * one, else the structural description.
 *
 * A `pass_through`-only column edge never reaches here (it renders no chip). A combined line of
 * indirect columns (`columns` set) names them; the fallback says they shape the row set, or, when a
 * value class rides on the line, only that they are used off the traced path.
 * Exported so the contract is testable without hover.
 * @internal
 */
export function describeColumnEdge(data: Pick<ColumnTraceEdgeData, 'sourceColumn' | 'targetColumn' | 'transforms' | 'note' | 'columns'>): string {
  const classes = markedTransformClasses(data.transforms, !!data.columns);
  if (data.columns) {
    const columns = data.columns.join(', ');
    const role = classes.some(c => COLUMN_TRANSFORM_DIRECTION[c] === 'DIRECT') ? 'used here, off the traced path' : 'shapes which rows reach here';
    return `${classes.map(c => COLUMN_TRANSFORM_CLASS_LABELS[c]).join(' + ')}:\n${data.note ? `${columns}\n${data.note}` : `${columns} — ${role}.`}`;
  }
  if (classes.length === 0) {
    return data.note ?? `${data.sourceColumn} → ${data.targetColumn} — the value changes here.`;
  }
  const detail = data.note ?? `${data.sourceColumn} → ${data.targetColumn} — the value changes here.`;
  return `${classes.map(c => COLUMN_TRANSFORM_CLASS_LABELS[c]).join(' + ')}:\n${detail}`;
}

function GlyphSvg({ transformClass, children }: { transformClass: ColumnTransformClass; children: ReactNode }) {
  return (
    <svg
      width={CHIP_GLYPH_SIZE}
      height={CHIP_GLYPH_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-transform-class={transformClass}
    >
      {children}
    </svg>
  );
}

/**
 * Mark drawn for one transform class, as inline SVG (the webview ships no icon library): arrow
 * copies, `fx` computes, sigma aggregates, overlapping circles join, funnel filters. Stroked
 * primitives in the shared 24-unit box, so they read as one family; DIRECT vs INDIRECT is the
 * line's dash, never the chip.
 */
function TransformClassGlyph({ transformClass }: { transformClass: ColumnTransformClass }) {
  switch (transformClass) {
    case 'pass_through':
      return (
        <GlyphSvg transformClass={transformClass}>
          <path d="M4 12h14" />
          <path d="M14 8l4 4-4 4" />
        </GlyphSvg>
      );
    case 'compute':
      return (
        <GlyphSvg transformClass={transformClass}>
          <text
            x="12"
            y="12"
            textAnchor="middle"
            dominantBaseline="central"
            fill="currentColor"
            stroke="none"
            fontSize="15"
            fontStyle="italic"
            fontWeight="600"
            fontFamily="var(--vscode-font-family, sans-serif)"
          >
            fx
          </text>
        </GlyphSvg>
      );
    case 'aggregate':
      return (
        <GlyphSvg transformClass={transformClass}>
          <path d="M18 5H6l7 7-7 7h12" />
        </GlyphSvg>
      );
    case 'combine':
      return (
        <GlyphSvg transformClass={transformClass}>
          <circle cx="9" cy="12" r="6" />
          <circle cx="15" cy="12" r="6" />
        </GlyphSvg>
      );
    case 'filter':
      return (
        <GlyphSvg transformClass={transformClass}>
          <path d="M4 5h16l-6.5 7.2V19l-3-2.4v-4.4L4 5Z" />
        </GlyphSvg>
      );
  }
}

/**
 * Open ring drawn in an unclassified chip. It has no orientation, so it cannot read as a direction,
 * and stays unfilled because the legend uses a filled dot for a view. r=7 in the 24-unit box lands
 * as a ~5.8px ring in the 20px glyph box.
 * @internal
 */
export function ColumnTransformGlyph() {
  return (
    <svg
      width={CHIP_GLYPH_SIZE}
      height={CHIP_GLYPH_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

/**
 * Renders one column-view edge and, where the trace recorded a transformation, its marker chip.
 *
 * A custom edge, not React Flow's `label` (inert text, no pointer callback), because the chip is
 * the hover trigger; the bare line does nothing. A model-classified edge shows one glyph per class
 * (capped, the rest collapsed into a count), an unclassified one the neutral ring, and a
 * `pass_through`-only edge no chip.
 */
export const ColumnTraceEdge = memo(function ColumnTraceEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const { state, lit, focused, sourceColumn, targetColumn, transforms, note, columns, objectLevel } = (data ?? {}) as ColumnTraceEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const opacity = lit ? 1 : COLUMN_EDGE_DIM_OPACITY;
  const classes = markedTransformClasses(transforms, !!columns);
  const identityOnly = (transforms?.length ?? 0) > 0 && classes.length === 0;
  const showChip = objectLevel ? classes.length > 0 : !identityOnly && (state === 'transformation' || classes.length > 0);
  const shown = classes.slice(0, CHIP_MAX_GLYPHS);
  const overflow = classes.length - shown.length;
  const stroke = lit ? 'var(--ln-focus-border)' : 'var(--ln-edge-color)';
  const description = showChip ? describeColumnEdge({ sourceColumn, targetColumn, transforms, note, columns }) : '';

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: lit ? LIT_STROKE_WIDTH : DIM_STROKE_WIDTH,
          opacity,
          ...(objectLevel ? { strokeDasharray: INDIRECT_DASH_PATTERN } : {}),
        }}
      />
      {showChip && (
        <EdgeLabelRenderer>
          <Tooltip
            content={description}
            placement="top"
            delay={200}
            multiline
            asChild
          >
            <div
              className="nodrag nopan ln-column-edge-chip"
              tabIndex={0}
              aria-label={description}
              data-focused={focused ? 'true' : undefined}
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                minWidth: COLUMN_EDGE_CHIP_SIZE,
                height: COLUMN_EDGE_CHIP_SIZE,
                padding: shown.length > 1 ? '0 5px' : 0,
                gap: shown.length > 1 ? 1 : 0,
                opacity,
                pointerEvents: 'all',
              }}
            >
              {shown.length > 0
                ? shown.map(c => <TransformClassGlyph key={c} transformClass={c} />)
                : <ColumnTransformGlyph />}
              {overflow > 0 && (
                <span aria-hidden="true" style={{ fontSize: 10, fontWeight: 700, lineHeight: 1 }}>
                  +{overflow}
                </span>
              )}
            </div>
          </Tooltip>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
