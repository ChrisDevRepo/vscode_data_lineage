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

/** Outer size, in px, of the marker chip centred on the edge path. */
export const COLUMN_EDGE_CHIP_SIZE = 32;

/** Size, in px, of a glyph drawn inside the chip. */
const CHIP_GLYPH_SIZE = 20;

/** How many class glyphs the chip shows before the remainder collapses into a count. */
const CHIP_MAX_GLYPHS = 2;

/**
 * Payload a column-view edge carries to its renderer.
 *
 * @remarks
 * Indexed to satisfy React Flow's edge-data constraint. `lit` is resolved by the canvas, which
 * owns the hovered column path, so the edge renders the effect without recomputing it.
 */
export interface ColumnTraceEdgeData extends Record<string, unknown> {
  /** Whether the value changed between the two endpoints. */
  state: ColumnLineState;
  /** Whether this edge is inside the lit set — the hovered column path, or the selected node's edges. */
  lit: boolean;
  /** Source column name as recorded, for the marker's hover text. */
  sourceColumn: string;
  /** Target column name as recorded, for the marker's hover text. */
  targetColumn: string;
  /** Transform classes the model recorded; absent on an unclassified edge. */
  transforms?: ColumnTransformClass[];
  /** One-clause model note for the edge; absent whenever the model offered none. */
  note?: string;
}

/**
 * Display name of one transform class, as the tooltip's first line spells it.
 *
 * @remarks
 * The legend row for column flow was removed: the chip's tooltip is now the only surface that
 * names the class, so these strings are load-bearing on hover alone.
 */
export const COLUMN_TRANSFORM_CLASS_LABELS: Readonly<Record<ColumnTransformClass, string>> = {
  pass_through: 'Pass through',
  compute: 'Compute',
  aggregate: 'Aggregate',
  combine: 'Combine',
  filter: 'Filter',
};

/**
 * Builds the marker chip's tooltip text: the class names first, then the model's own one-clause
 * note when it offered one, else the structural description of the line.
 *
 * @remarks
 * A `pass_through`-only edge never reaches here — it renders no chip, because identity is what an
 * unmarked line already says. `filter`/`combine` are INDIRECT: no value crosses the edge, so the
 * structural fallback says what the edge does to the row set rather than claiming a value changed.
 * Exported so the tooltip contract is testable without simulating hover.
 */
export function describeColumnEdge(data: Pick<ColumnTraceEdgeData, 'sourceColumn' | 'targetColumn' | 'transforms' | 'note'>): string {
  const classes = (data.transforms ?? []).filter(c => c !== 'pass_through');
  if (classes.length === 0) {
    return `${data.sourceColumn} → ${data.targetColumn} — the value changes here.`;
  }
  const indirectOnly = classes.every(c => COLUMN_TRANSFORM_DIRECTION[c] === 'INDIRECT');
  const detail = data.note
    ?? `${data.sourceColumn} → ${data.targetColumn} — ${indirectOnly ? 'shapes which rows reach here.' : 'the value changes here.'}`;
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
 * The mark drawn for one transform class.
 *
 * @remarks
 * Hand-authored rather than imported — the webview ships no icon library, and every other symbol
 * in it is an inline SVG or a Unicode glyph. Each class gets its own convention-bearing shape so
 * the five read apart at a glance: the identity arrow copies, the curve computes, the sigma
 * aggregates, the converging pair joins, the funnel filters. All are stroked primitives in the
 * shared 24-unit box so they render as one family at chip scale.
 */
export function TransformClassGlyph({ transformClass }: { transformClass: ColumnTransformClass }) {
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
          <path d="M4 18C9 18 8 6 12 6s3 12 8 12" />
        </GlyphSvg>
      );
    case 'aggregate':
      return (
        <GlyphSvg transformClass={transformClass}>
          <path d="M17 6H7l6.5 6L7 18h10" />
        </GlyphSvg>
      );
    case 'combine':
      return (
        <GlyphSvg transformClass={transformClass}>
          <path d="M4 6h6" />
          <path d="M4 18h6" />
          <path d="M10 6c5 0 4.5 6 10 6" />
          <path d="M10 18c5 0 4.5-6 10-6" />
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
 * The mark drawn inside an unclassified chip: an open ring, reading as "something happens here —
 * hover it".
 *
 * @remarks
 * Hand-authored rather than imported — the webview ships no icon library, and every other symbol
 * in it is an inline SVG or a Unicode glyph. The ring is an affordance, not a depiction: it
 * carries no orientation, so on a canvas where direction is the primary semantic it cannot be
 * misread as bidirectional the way an arrow pair can. An edge the model classified shows its class
 * glyphs instead; the ring remains the honest mark for a transformation with no classification.
 *
 * Unfilled on purpose — the object-type legend uses a filled dot for a view, and the two must not
 * converge. r=7 in a 24-unit box lands as a ~5.8px ring inside the 20px glyph box.
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
 * @remarks
 * A custom edge rather than React Flow's `label` prop because the marker has to be a hover target:
 * `label` renders inert text with no pointer callback, so the transformation could be seen but not
 * interrogated. The chip is the trigger — hovering the bare line does nothing, matching how every
 * comparable lineage tool exposes transform detail.
 *
 * The chip's content follows the classification: a model-classified edge shows one glyph per class
 * (capped, the remainder collapsed into a count), an unclassified transformation keeps the neutral
 * ring. A `pass_through`-only edge renders no chip at all — identity is what an unmarked line
 * already says, so marking it would spend the reader's attention to say nothing.
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
  const { state, lit, sourceColumn, targetColumn, transforms, note } = (data ?? {}) as ColumnTraceEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const opacity = lit ? 1 : COLUMN_EDGE_DIM_OPACITY;
  const classes = (transforms ?? []).filter(c => c !== 'pass_through');
  const identityOnly = (transforms?.length ?? 0) > 0 && classes.length === 0;
  const showChip = !identityOnly && (state === 'transformation' || classes.length > 0);
  const shown = classes.slice(0, CHIP_MAX_GLYPHS);
  const overflow = classes.length - shown.length;

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          strokeWidth: lit ? LIT_STROKE_WIDTH : DIM_STROKE_WIDTH,
          opacity,
        }}
      />
      {showChip && (
        <EdgeLabelRenderer>
          <Tooltip
            content={describeColumnEdge({ sourceColumn, targetColumn, transforms, note })}
            placement="top"
            delay={200}
            multiline
            asChild
          >
            <div
              className="nodrag nopan ln-column-edge-chip"
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
