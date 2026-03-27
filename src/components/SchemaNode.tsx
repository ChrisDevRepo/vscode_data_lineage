import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SchemaNodeData } from '../engine/types';
import { SCHEMA_NODE_WIDTH, SCHEMA_NODE_HEIGHT } from '../engine/graphBuilder';
import { TYPE_COLORS, TYPE_LABELS } from '../utils/schemaColors';
import type { ObjectType } from '../engine/types';

export const SchemaNode = memo(function SchemaNode({ data }: NodeProps) {
  const d = data as SchemaNodeData;
  const breakdown = Object.entries(d.typeBreakdown)
    .filter(([, count]) => count && count > 0)
    .map(([type, count]) => {
      const icon = TYPE_COLORS[type as ObjectType]?.icon ?? type[0].toUpperCase();
      return `${icon}${count}`;
    })
    .join('  ');

  return (
    <div
      style={{
        width: SCHEMA_NODE_WIDTH,
        height: SCHEMA_NODE_HEIGHT,
        border: `2px solid ${d.color}`,
        borderRadius: 10,
        background: 'var(--ln-bg-elevated)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: 'var(--ln-node-shadow)',
      }}
    >
      {/* Header bar with schema color */}
      <div
        style={{
          background: d.color,
          padding: '4px 8px',
          fontSize: 11,
          fontWeight: 700,
          color: '#fff',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          letterSpacing: '0.02em',
        }}
        title={d.schemaName}
      >
        {d.schemaName}
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '4px 6px',
          gap: 2,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--ln-fg)', lineHeight: 1 }}>
            {d.objectCount}
          </span>
          <span style={{ fontSize: 10, color: 'var(--ln-fg-muted)' }}>objects</span>
        </div>
        {breakdown && (
          <span
            style={{ fontSize: 10, color: 'var(--ln-fg-muted)', letterSpacing: '0.03em', cursor: 'default' }}
            title={Object.entries(d.typeBreakdown)
              .filter(([, count]) => count && count > 0)
              .map(([type, count]) => `${TYPE_LABELS[type as ObjectType] ?? type}: ${count}`)
              .join('\n')}
          >
            {breakdown}
          </span>
        )}
      </div>

      <Handle type="target" position={Position.Left} style={{ background: d.color, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ background: d.color, width: 8, height: 8 }} />
    </div>
  );
});
