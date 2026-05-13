import { memo, type ReactNode } from 'react';
import { Handle, Position, NodeToolbar } from '@xyflow/react';
import { TYPE_COLORS, TYPE_LABELS, getSchemaColor, getExternalNodeColor } from '../utils/schemaColors';
import { Tooltip } from './ui/Tooltip';
import type { ObjectType } from '../engine/types';

/**
 * The business data associated with a single node in the React Flow canvas.
 */
export type CustomNodeData = {
  /** The human-readable name of the object. */
  label: string;
  /** The database schema the object belongs to. */
  schema: string;
  /** The fully qualified name (Schema.Label). */
  fullName: string;
  /** The type of database object (table, view, etc.). */
  objectType: ObjectType;
  /** The number of incoming edges. */
  inDegree: number;
  /** The number of outgoing edges. */
  outDegree: number;
  /** If true, the node is rendered with reduced opacity. */
  dimmed?: boolean;
  /** If true or 'yellow', the node is rendered with a highlight border and glow. */
  highlighted?: boolean | 'yellow';
  /** Specific type for external references. */
  externalType?: 'et' | 'file' | 'db';
  /** URL for file-based external sources. */
  externalUrl?: string;
  /** Database name for cross-database references. */
  externalDatabase?: string;
  /**
   * A small text badge displayed above the node.
   * Typically used for AI reasoning steps or bookmark categories.
   */
  aiBadge?: { text: string };
  /**
   * A descriptive note displayed below the node.
   * Provides deep business logic or transformation context.
   */
  aiNote?: { text: string };
  /**
   * Custom color and shadow configuration for AI-driven highlights.
   */
  aiHighlight?: { color: string; glow: string; shadow: string };
  /** Column flows for this node from an active CT session, keyed by hop analysis. */
  ctColumnFlows?: { fromCol: string; toCol: string }[];
  /** Whether to show a 'Remove' button on the node (used in Advanced Bookmarks). */
  showRemoveButton?: boolean;
  /** Callback to remove this node from the current view. */
  onRemoveFromView?: (nodeId: string) => void;
};

/**
 * A highly customized React Flow node component that renders database objects.
 *
 * @remarks
 * This component handles complex visual states including:
 * - Schema-based color coding (left border).
 * - Object-type iconography.
 * - Multi-layered highlights (Blue, Yellow, and AI-custom).
 * - Toolbars for AI-generated annotations and badges.
 * - Interactive elements like the 'Remove from View' button.
 * - High-fidelity tooltips showing qualified names and connectivity metrics.
 *
 * It utilize standard React Flow `Handle` components for edge anchoring.
 *
 * @param props - Component props containing the node ID and business data.
 */
function CustomNodeComponent({ id, data }: { id: string; data: CustomNodeData }) {
  const style = TYPE_COLORS[data.objectType] || TYPE_COLORS.table;
  const isExternal = data.objectType === 'external';
  const isVirtual = data.externalType === 'file' || data.externalType === 'db';
  // ⬢ filled = ET (real catalog object); ⬡ hollow = file/db virtual (no metadata)
  const displayIcon = isVirtual ? '⬡' : data.externalType === 'et' ? '⬢' : style.icon;
  const schemaColor = isExternal ? getExternalNodeColor() : getSchemaColor(data.schema);
  const dimmed = data.dimmed === true;
  const highlighted = data.highlighted === true || data.highlighted === 'yellow';
  const isYellowHighlight = data.highlighted === 'yellow';

  const highlightColor = data.aiHighlight
    ? data.aiHighlight.color
    : isYellowHighlight ? 'var(--ln-highlight-yellow)' : 'var(--ln-highlight-blue)';

  const tooltipLines = [];
  if (data.externalType === 'file' && data.externalUrl) {
    tooltipLines.push(data.externalUrl);
  } else if (data.externalType === 'db' && data.externalDatabase) {
    tooltipLines.push(`${data.externalDatabase}.${data.label}`);
  } else {
    tooltipLines.push(`${data.schema}.${data.label}`);
  }
  tooltipLines.push(`Object Type: ${TYPE_LABELS[data.objectType]}${isVirtual ? (data.externalType === 'file' ? ' (File Source)' : ' (Cross-Database)') : ''}`);
  tooltipLines.push(`In: ${data.inDegree} | Out: ${data.outDegree}`);

  const tooltipContent: string | ReactNode = data.ctColumnFlows?.length
    ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tooltipLines.map((line, i) => <div key={i}>{line}</div>)}
        <div style={{ borderTop: '1px solid var(--vscode-widget-border, #555)', margin: '3px 0' }} />
        <div style={{ fontWeight: 600, fontSize: '0.85em', color: 'var(--ln-fg-muted)' }}>Column trace:</div>
        {data.ctColumnFlows.map((f, i) => (
          <div key={i} style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
            {f.fromCol} → {f.toCol}
          </div>
        ))}
      </div>
    )
    : tooltipLines.join('\n');

  return (
    <>
      {/* AI badge — monochrome chip above node */}
      {data.aiBadge && (
        <NodeToolbar position={Position.Top} align="center" offset={2} isVisible>
          <Tooltip content={data.aiBadge.text} placement="top">
            <div className="ln-ai-badge">
              {data.aiBadge.text}
            </div>
          </Tooltip>
        </NodeToolbar>
      )}
      {/* AI note — title line visible, full text on hover */}
      {data.aiNote && (
        <NodeToolbar position={Position.Bottom} align="center" offset={2} isVisible>
          <Tooltip content={data.aiNote.text} placement="bottom" multiline maxWidth={400} delay={300}>
            <div className="ln-ai-note-label">
              {data.aiNote.text.split('\n')[0]}
            </div>
          </Tooltip>
        </NodeToolbar>
      )}
      <Tooltip content={tooltipContent} placement="top" multiline maxWidth={300} asChild>
      <div
        className="rounded-lg border-2 transition-all duration-300 ease-in-out ln-node-card"
        style={{
          position: 'relative',
          borderColor: highlighted ? highlightColor : 'var(--ln-node-border)',
          borderLeftColor: highlighted ? highlightColor : schemaColor,
          borderLeftWidth: 6,
          backgroundColor: 'var(--ln-node-bg)',
          opacity: dimmed ? 0.25 : 1,
          width: 180,
          height: 70,
          boxShadow: highlighted
            ? (isYellowHighlight
                ? '0 0 0 4px var(--ln-highlight-yellow-glow), 0 8px 20px var(--ln-highlight-yellow-shadow)'
                : data.aiHighlight
                  ? `0 0 0 5px ${data.aiHighlight.glow}, 0 8px 20px ${data.aiHighlight.shadow}`
                  : '0 0 0 4px var(--ln-highlight-blue-glow), 0 8px 20px var(--ln-highlight-blue-shadow)')
            : data.aiHighlight
            ? `0 0 0 5px ${data.aiHighlight.glow}, 0 8px 20px ${data.aiHighlight.shadow}`
            : dimmed
            ? 'var(--ln-node-shadow-dimmed)'
            : 'var(--ln-node-shadow)',
          transform: highlighted ? 'scale(1.05)' : 'scale(1)',
          zIndex: highlighted ? 1000 : 1,
        }}
      >
        {data.showRemoveButton && (
          <Tooltip content="Remove from view" placement="top" asChild>
            <button
              aria-label="Remove from view"
              className="absolute flex items-center justify-center text-[9px] rounded ln-node-remove-btn"
              style={{ top: 2, right: 2, width: 14, height: 14, lineHeight: 1, zIndex: 10 }}
              onClick={(e) => { e.stopPropagation(); data.onRemoveFromView?.(id); }}
            >
              ×
            </button>
          </Tooltip>
        )}
        <Handle type="target" position={Position.Left} className="!w-2 !h-2 ln-handle" />

        <div className="px-3 pt-1 pb-1 flex flex-col h-full">
          {/* Type symbol and stats on same line */}
          <div className="flex items-center justify-between gap-1.5 whitespace-nowrap" style={{ lineHeight: 1 }}>
            <span
              className="text-base font-medium whitespace-nowrap leading-none"
              style={{ color: 'var(--ln-fg-muted)' }}
            >
              {displayIcon}
            </span>
            <span className="text-[9px] flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--ln-fg-muted)' }}>
              {data.inDegree}↓ {data.outDegree}↑
            </span>
          </div>

          {/* Object name */}
          <div
            className="text-[11px] overflow-hidden text-ellipsis whitespace-nowrap mt-0.5"
            style={{ color: 'var(--ln-fg)' }}
          >
            {data.label}
          </div>

          {/* Schema name */}
          <div
            className="text-[9px] overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ color: 'var(--ln-fg-muted)', lineHeight: 1.1 }}
          >
            {data.externalType === 'file' ? 'File Source' : data.externalType === 'db' ? `↗ ${data.externalDatabase || 'Cross-DB'}` : data.schema}
          </div>
        </div>

        <Handle type="source" position={Position.Right} className="!w-2 !h-2 ln-handle" />
      </div>
      </Tooltip>
    </>
  );
}

/**
 * An optimized, memoized version of the `CustomNodeComponent`.
 */
export const CustomNode = memo(CustomNodeComponent);
