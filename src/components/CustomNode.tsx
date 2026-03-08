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
};

function CustomNodeComponent({ data }: { data: CustomNodeData }) {
  const style = TYPE_COLORS[data.objectType] || TYPE_COLORS.table;
  const isVirtual = data.externalType === 'file' || data.externalType === 'db';
  // ⬢ filled = ET (real catalog object); ⬡ hollow = file/db virtual (no metadata)
  const displayIcon = isVirtual ? '⬡' : data.externalType === 'et' ? '⬢' : style.icon;
  const schemaColor = isVirtual ? getVirtualExtColor() : getSchemaColor(data.schema);
  const dimmed = data.dimmed === true;
  const highlighted = data.highlighted === true || data.highlighted === 'yellow';
  const isYellowHighlight = data.highlighted === 'yellow';

  const highlightColor = isYellowHighlight ? 'var(--ln-highlight-yellow)' : 'var(--ln-highlight-blue)';

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
              : '0 0 0 4px var(--ln-highlight-blue-glow), 0 8px 20px var(--ln-highlight-blue-shadow)')
          : dimmed
          ? 'var(--ln-node-shadow-dimmed)'
          : 'var(--ln-node-shadow)',
        transform: highlighted ? 'scale(1.05)' : 'scale(1)',
        zIndex: highlighted ? 1000 : 1,
      }}
    >
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
