import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { Tooltip } from './ui/Tooltip';
import { COLUMN_EDGE_DIM_OPACITY } from '../engine/columnTraceView';
import type { ColumnLineState } from '../engine/columnTraceView';

/** Stroke width of a column-view edge lit by hover or selection. */
const LIT_STROKE_WIDTH = 1.6;

/** Stroke width of a column-view edge outside the lit set. */
const DIM_STROKE_WIDTH = 1;

/** Outer size, in px, of the marker chip centred on the edge path. */
export const COLUMN_EDGE_CHIP_SIZE = 16;

/** Size, in px, of the glyph drawn inside the chip. */
const CHIP_GLYPH_SIZE = 10;

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
}

/**
 * The mark drawn inside the chip: an open ring, reading as "something happens here — hover it".
 *
 * @remarks
 * Hand-authored rather than imported — the webview ships no icon library, and every other symbol
 * in it is an inline SVG or a Unicode glyph. The ring is an affordance, not a depiction: it
 * carries no orientation, so on a canvas where direction is the primary semantic it cannot be
 * misread as bidirectional the way an arrow pair can. Its meaning is carried by the tooltip and
 * the legend row, which is why both are treated as load-bearing text.
 *
 * Unfilled on purpose — the object-type legend uses a filled dot for a view, and the two must not
 * converge. r=7 in a 24-unit box lands as a ~5.8px ring inside the 16px chip.
 *
 * Exported so the legend draws the same mark from the same source; a second copy would drift
 * from the canvas and leave the key describing a symbol the graph no longer shows.
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
 * Only `transformation` earns a chip. An unmarked line already reads as "unchanged", so marking
 * `passthrough` too would spend the reader's attention to say nothing, and `unknown` has nothing
 * to assert.
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
  const { state, lit, sourceColumn, targetColumn } = (data ?? {}) as ColumnTraceEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const opacity = lit ? 1 : COLUMN_EDGE_DIM_OPACITY;

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
      {state === 'transformation' && (
        <EdgeLabelRenderer>
          <Tooltip
            content={`${sourceColumn} → ${targetColumn} — the value changes here.`}
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
                width: COLUMN_EDGE_CHIP_SIZE,
                height: COLUMN_EDGE_CHIP_SIZE,
                opacity,
                pointerEvents: 'all',
              }}
            >
              <ColumnTransformGlyph />
            </div>
          </Tooltip>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
