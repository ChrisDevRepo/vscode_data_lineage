import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SchemaNodeData, ObjectType } from '../engine/types';
import { SCHEMA_NODE_WIDTH, SCHEMA_NODE_HEIGHT } from '../engine/graphBuilder';
import { TYPE_COLORS, TYPE_LABELS } from '../utils/schemaColors';
import { Tooltip } from './ui/Tooltip';

/**
 * A specialized React Flow node component for representing a database schema in the overview mode.
 *
 * @remarks
 * This component visualizes a schema as a consolidated node, displaying:
 * 1. The schema name in a colored header.
 * 2. The total count of objects within that schema.
 * 3. A breakdown of object types (e.g., Tables, Views) using icons and counts.
 *
 * It uses {@link Tooltip} to show a detailed breakdown on hover and includes handles for graph connections.
 * It is designed to work with the `@xyflow/react` (React Flow) library.
 *
 * @param props - Standard React Flow {@link NodeProps}.
 * @returns A {@link React.JSX.Element} representing the schema node.
 */
export const SchemaNode = memo(function SchemaNode({ data }: NodeProps) {
  const d = data as SchemaNodeData;
  
  /** Filters out types with zero counts to keep the display clean. */
  const breakdownEntries = Object.entries(d.typeBreakdown ?? {}).filter(([, count]) => count && count > 0);
  
  /** Generates a compact string representation of the object type breakdown. */
  const breakdown = breakdownEntries
    .map(([type, count]) => {
      const icon = TYPE_COLORS[type as ObjectType]?.icon ?? type[0].toUpperCase();
      return `${icon}${count}`;
    })
    .join('  ');

  /** Generates the tooltip text content. */
  const tooltip = [
    d.schemaName,
    ...breakdownEntries.map(([type, count]) => `${count} ${TYPE_LABELS[type as ObjectType] ?? type}`),
  ].join('\n');

  return (
    <Tooltip content={tooltip} multiline placement="top" asChild>
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
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--ln-button-fg)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            letterSpacing: '0.02em',
          }}
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
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--ln-fg)', lineHeight: 1 }}>
              {d.objectCount}
            </span>
            <span style={{ fontSize: 9, color: 'var(--ln-fg-muted)' }}>objects</span>
          </div>
          {breakdown && (
            <span
              style={{ fontSize: 9, color: 'var(--ln-fg-muted)', letterSpacing: '0.03em', cursor: 'default' }}
            >
              {breakdown}
            </span>
          )}
        </div>

        <Handle type="target" position={Position.Left} style={{ background: d.color, width: 8, height: 8 }} />
        <Handle type="source" position={Position.Right} style={{ background: d.color, width: 8, height: 8 }} />
      </div>
    </Tooltip>
  );
});
