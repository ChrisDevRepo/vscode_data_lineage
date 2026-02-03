import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TYPE_COLORS, TYPE_LABELS, isDarkTheme, getSchemaColor } from '../utils/schemaColors';
import type { ObjectType } from '../engine/types';

interface CustomNodeData {
  label: string;
  schema: string;
  fullName: string;
  objectType: ObjectType;
  inDegree: number;
  outDegree: number;
  dimmed?: boolean;
  highlighted?: boolean | 'yellow';
}

function CustomNodeComponent({ data }: { data: CustomNodeData }) {
  const style = TYPE_COLORS[data.objectType] || TYPE_COLORS.external;
  const dark = isDarkTheme();
  const schemaColor = getSchemaColor(data.schema);
  const dimmed = data.dimmed === true;
  const highlighted = data.highlighted === true || data.highlighted === 'yellow';
  const isYellowHighlight = data.highlighted === 'yellow';

  const tooltipText = [
    `${data.schema}.${data.label}`,
    `Object Type: ${TYPE_LABELS[data.objectType]}`,
    `In: ${data.inDegree} | Out: ${data.outDegree}`,
  ].filter(Boolean).join('\n');

  return (
    <div
      className="rounded-lg border-2 transition-all duration-300 ease-in-out ln-node-tooltip"
      data-tooltip={tooltipText}
      style={{
        borderColor: highlighted
          ? (isYellowHighlight ? '#eab308' : '#2563eb')
          : (dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'),
        borderLeftColor: highlighted
          ? (isYellowHighlight ? '#eab308' : '#2563eb')
          : schemaColor,
        borderLeftWidth: 6,
        backgroundColor: dark ? 'rgba(30,30,30,0.95)' : 'rgba(255,255,255,0.95)',
        opacity: dimmed ? 0.25 : 1,
        width: 180,
        height: 70,
        boxShadow: highlighted
          ? (isYellowHighlight 
              ? '0 0 0 4px rgba(234,179,8,0.4), 0 8px 20px rgba(234,179,8,0.3)'
              : '0 0 0 4px rgba(37,99,235,0.4), 0 8px 20px rgba(37,99,235,0.3)')
          : dimmed
          ? '0 1px 2px rgba(0,0,0,0.05)'
          : 'var(--ln-node-shadow)',
        transform: highlighted ? 'scale(1.05)' : 'scale(1)',
        zIndex: highlighted ? 1000 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-slate-400" />

      <div className="px-3 pt-1 pb-1 flex flex-col h-full">
        {/* Type symbol and stats on same line */}
        <div className="flex items-center justify-between gap-1.5 whitespace-nowrap" style={{ lineHeight: 1 }}>
          <span
            className="text-base font-medium whitespace-nowrap leading-none"
            style={{ color: dark ? '#9ca3af' : '#6b7280' }}
          >
            {style.icon}
          </span>
          <span className="text-[9px] flex-shrink-0 whitespace-nowrap" style={{ color: dark ? '#9ca3af' : '#4b5563' }}>
            {data.inDegree}↓ {data.outDegree}↑
          </span>
        </div>

        {/* Object name */}
        <div
          className="text-[11px] overflow-hidden text-ellipsis whitespace-nowrap mt-0.5"
          style={{
            color: dark ? '#ffffff' : '#1f2937',
          }}
        >
          {data.label}
        </div>

        {/* Schema name */}
        <div
          className="text-[9px] overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ color: dark ? '#9ca3af' : '#6b7280', lineHeight: 1.1 }}
        >
          {data.schema}
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-slate-400" />
    </div>
  );
}

export const CustomNode = memo(CustomNodeComponent);
