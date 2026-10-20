import { memo, type ReactNode } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { Tooltip } from './ui/Tooltip';
import { isIndirectOnly, type ColumnTransformClass } from '../engine/shared/bridgeContract';
import { COLUMN_EDGE_DIM_OPACITY } from '../engine/columnTraceView';
import type { ColumnLineState } from '../engine/columnTraceView';

/** Stroke width of a column-view edge lit by hover or selection. */
const LIT_STROKE_WIDTH = 1.6;

/** Stroke width of a column-view edge outside the lit set. */
const DIM_STROKE_WIDTH = 1;

/** Dash pattern of an edge that only shaped which rows arrive, never the value. */
const INDIRECT_DASH_PATTERN = '5 4';

/** Outer size, in px, of the marker chip centred on the edge path. */
const COLUMN_EDGE_CHIP_SIZE = 32;

/** Size, in px, of a glyph drawn inside the chip. */
const CHIP_GLYPH_SIZE = 20;

/** How many class glyphs the chip shows before the remainder collapses into a count. */
const CHIP_MAX_GLYPHS = 2;

/** Payload a column-view edge carries to its renderer. */
export interface ColumnTraceEdgeData extends Record<string, unknown> {
  /** Whether the value changed between the two endpoints. */
  state: ColumnLineState;
  /** Whether this edge is inside the lit set — the hovered column path, or the selected node's edges. */
  lit: boolean;
  /** Whether the edge is lit by a narrowing — a hovered or selected column path, or a selected node — so its marker chip takes the line's highlight. */
  focused?: boolean;
  /** Source column name as recorded, for the marker's hover text. */
  sourceColumn: string;
  /** Target column name as recorded, for the marker's hover text. */
  targetColumn: string;
  /** Transform classes the model recorded; absent on an unclassified edge. */
  transforms?: ColumnTransformClass[];
  /** One-clause model note for the edge; absent whenever the model offered none. */
  note?: string;
  /** Whether the edge is an object-level dependency rather than a column thread: drawn broken, since no column value crosses it, and never marked with a chip. */
  objectLevel?: boolean;
}

/** Display name of one transform class, as the tooltip's first line spells it. */
const COLUMN_TRANSFORM_CLASS_LABELS: Readonly<Record<ColumnTransformClass, string>> = {
  pass_through: 'Pass through',
  compute: 'Compute',
  aggregate: 'Aggregate',
  combine: 'Combine',
  filter: 'Filter',
};

/** The distinct non-identity classes an edge marks — one glyph and one label per class. */
function markedTransformClasses(transforms: readonly ColumnTransformClass[] | undefined): ColumnTransformClass[] {
  return [...new Set(transforms ?? [])].filter(c => c !== 'pass_through');
}

/** Builds the marker chip's tooltip text: the class names first, then the model's own one-clause note when it offered one, else the structural description of the line. */
function describeColumnEdge(data: Pick<ColumnTraceEdgeData, 'sourceColumn' | 'targetColumn' | 'transforms' | 'note'>): string {
  const classes = markedTransformClasses(data.transforms);
  if (classes.length === 0) {
    return data.note ?? `${data.sourceColumn} → ${data.targetColumn} — the value changes here.`;
  }
  const indirectOnly = isIndirectOnly(classes);
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

/** The mark drawn for one transform class. */
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

/** The mark drawn inside an unclassified chip: an open ring. */
function ColumnTransformGlyph() {
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

/** Renders one column-view edge and, where the trace recorded a transformation, its marker chip. */
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
  const { state, lit, focused, sourceColumn, targetColumn, transforms, note, objectLevel } = (data ?? {}) as ColumnTraceEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const opacity = lit ? 1 : COLUMN_EDGE_DIM_OPACITY;
  const classes = markedTransformClasses(transforms);
  const identityOnly = (transforms?.length ?? 0) > 0 && classes.length === 0;
  const indirect = !!objectLevel || isIndirectOnly(classes);
  const showChip = !objectLevel && !identityOnly && (state === 'transformation' || classes.length > 0);
  const shown = classes.slice(0, CHIP_MAX_GLYPHS);
  const overflow = classes.length - shown.length;
  const stroke = lit ? 'var(--ln-focus-border)' : 'var(--ln-edge-color)';
  const description = showChip ? describeColumnEdge({ sourceColumn, targetColumn, transforms, note }) : '';

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: lit ? LIT_STROKE_WIDTH : DIM_STROKE_WIDTH,
          opacity,
          ...(indirect ? { strokeDasharray: INDIRECT_DASH_PATTERN } : {}),
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
