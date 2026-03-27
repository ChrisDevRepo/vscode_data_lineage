import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TYPE_COLORS, TYPE_LABELS, getSchemaColor, getVirtualExtColor } from '../utils/schemaColors';
import type { ObjectType } from '../engine/types';

export type CustomNodeData = {
  label: string;
  schema: string;
  fullName: string;
  objectType: ObjectType;
  inDegree: number;
  outDegree: number;
  dimmed?: boolean;
  highlighted?: boolean | 'yellow';
  externalType?: 'et' | 'file' | 'db';
  externalUrl?: string;
  externalDatabase?: string;
  /** Badge chip shown on the node (top-right corner). Set by advanced bookmarks / AI views. */
  aiBadge?: { text: string; color: string };
  /** Hex color override for border and glow — overrides schema color when set. */
  aiHighlight?: string;
  /** When true, shows the "×" remove-from-view button (advanced bookmark mode only). */
  showRemoveButton?: boolean;
  /** Callback fired when user clicks the "×" remove-from-view button. */
  onRemoveFromView?: (nodeId: string) => void;
};

function CustomNodeComponent({ id, data }: { id: string; data: CustomNodeData }) {
  const style = TYPE_COLORS[data.objectType] || TYPE_COLORS.table;
  const isVirtual = data.externalType === 'file' || data.externalType === 'db';
  // ⬢ filled = ET (real catalog object); ⬡ hollow = file/db virtual (no metadata)
  const displayIcon = isVirtual ? '⬡' : data.externalType === 'et' ? '⬢' : style.icon;
  const schemaColor = isVirtual ? getVirtualExtColor() : getSchemaColor(data.schema);
  const dimmed = data.dimmed === true;
  const highlighted = data.highlighted === true || data.highlighted === 'yellow';
  const isYellowHighlight = data.highlighted === 'yellow';

  const highlightColor = data.aiHighlight
    ? data.aiHighlight
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
  const tooltipText = tooltipLines.join('\n');

  return (
    <div
      className="rounded-lg border-2 transition-all duration-300 ease-in-out ln-node-tooltip"
      data-tooltip={tooltipText}
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
                ? `0 0 0 3px ${data.aiHighlight}55, 0 6px 16px ${data.aiHighlight}44`
                : '0 0 0 4px var(--ln-highlight-blue-glow), 0 8px 20px var(--ln-highlight-blue-shadow)')
          : data.aiHighlight
          ? `0 0 0 3px ${data.aiHighlight}55, 0 6px 16px ${data.aiHighlight}44`
          : dimmed
          ? 'var(--ln-node-shadow-dimmed)'
          : 'var(--ln-node-shadow)',
        transform: highlighted ? 'scale(1.05)' : 'scale(1)',
        zIndex: highlighted ? 1000 : 1,
      }}
    >
      {data.aiBadge && (
        <div
          className="absolute text-[8px] font-semibold px-1 rounded ln-node-badge"
          style={{
            top: 2,
            right: data.showRemoveButton ? 20 : 2,
            maxWidth: 60,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            background: data.aiBadge.color,
            color: '#fff',
            lineHeight: '13px',
            zIndex: 10,
          }}
          title={data.aiBadge.text}
        >
          {data.aiBadge.text}
        </div>
      )}
      {data.showRemoveButton && (
        <button
          className="absolute flex items-center justify-center text-[9px] rounded ln-node-remove-btn"
          style={{ top: 2, right: 2, width: 14, height: 14, lineHeight: 1, zIndex: 10 }}
          onClick={(e) => { e.stopPropagation(); data.onRemoveFromView?.(id); }}
          title="Remove from view"
        >
          ×
        </button>
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
  );
}

export const CustomNode = memo(CustomNodeComponent);
