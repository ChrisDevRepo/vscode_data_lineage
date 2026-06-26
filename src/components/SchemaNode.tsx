import React, { memo } from 'react';
import { Handle, Position, NodeToolbar, type NodeProps } from '@xyflow/react';
import type { SchemaNodeData, ObjectType } from '../engine/types';
import { SCHEMA_NODE_WIDTH, SCHEMA_NODE_HEIGHT } from '../engine/graphBuilder';
import { TYPE_COLORS, TYPE_LABELS } from '../utils/schemaColors';

type SchemaNodeUiData = SchemaNodeData & {
  onExpandSchema?: (schemaName: string) => void;
  onMakeSchemaCenter?: (schemaName: string) => void;
};

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
export const SchemaNode = memo(function SchemaNode({ data, selected }: NodeProps) {
  const d = data as SchemaNodeUiData;
  const isExpandedSchemaViewCluster = d.isExpandedSchemaViewCluster === true;
  const canExpand = typeof d.onExpandSchema === 'function';
  const canExpandOnly = typeof d.onMakeSchemaCenter === 'function';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canExpand || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    d.onExpandSchema?.(d.schemaName);
  };

  // Expanded schema view clusters are secondary navigation containers beside the expanded object nodes.
  const clusterBackground = `color-mix(in srgb, ${d.color} 12%, var(--ln-bg-elevated))`;
  const clusterHeaderBackground = `color-mix(in srgb, ${d.color} 68%, var(--ln-bg-elevated))`;
  const clusterBorderColor = `color-mix(in srgb, ${d.color} 48%, var(--ln-border))`;

  /** Filters out types with zero counts to keep the display clean. */
  const breakdownEntries = Object.entries(d.typeBreakdown ?? {}).filter(([, count]) => count && count > 0);
  
  /** Generates a compact string representation of the object type breakdown. */
  const breakdown = breakdownEntries
    .map(([type, count]) => {
      const icon = TYPE_COLORS[type as ObjectType]?.icon ?? type[0].toUpperCase();
      return `${icon}${count}`;
    })
    .join('  ');

  // On a selected cluster, surface its actions as an attached toolbar (replaces the old right-click menu).
  const clusterToolbar = (canExpand || canExpandOnly) ? (
    <NodeToolbar position={Position.Top} align="center" offset={8} isVisible={!!selected}>
      <div className="ln-schema-toolbar" onClick={(e) => e.stopPropagation()}>
        {canExpand && (
          <button type="button" className="ln-schema-toolbar__btn" onClick={() => d.onExpandSchema?.(d.schemaName)}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5M9 3.75v16.5M4.5 4.5h15v15h-15v-15Z" />
            </svg>
            Expand
          </button>
        )}
        {canExpandOnly && (
          <button type="button" className="ln-schema-toolbar__btn" onClick={() => d.onMakeSchemaCenter?.(d.schemaName)}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75v16.5M3.75 12h16.5M7.5 7.5h9v9h-9v-9Z" />
            </svg>
            Expand Only
          </button>
        )}
      </div>
    </NodeToolbar>
  ) : null;

  return (
    <>
      {clusterToolbar}
      <div
        className={isExpandedSchemaViewCluster ? 'ln-schema-cluster' : undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-label={canExpand ? `Expand schema ${d.schemaName}` : `Schema ${d.schemaName}`}
        onKeyDown={handleKeyDown}
        style={{
          width: SCHEMA_NODE_WIDTH,
          height: SCHEMA_NODE_HEIGHT,
          boxSizing: 'border-box',
          border: `${isExpandedSchemaViewCluster ? 1 : 2}px ${isExpandedSchemaViewCluster ? 'dashed' : 'solid'} ${isExpandedSchemaViewCluster ? clusterBorderColor : d.color}`,
          borderRadius: 10,
          background: isExpandedSchemaViewCluster ? clusterBackground : 'var(--ln-bg-elevated)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          cursor: 'pointer',
          boxShadow: isExpandedSchemaViewCluster ? 'var(--ln-node-shadow-dimmed)' : 'var(--ln-node-shadow)',
        }}
      >
        {/* Header bar with schema color */}
        <div
          style={{
            background: isExpandedSchemaViewCluster ? clusterHeaderBackground : d.color,
            padding: '4px 8px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--ln-button-fg)',
            letterSpacing: '0.02em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 4,
          }}
        >
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d.schemaName}
          </span>
          {canExpand && (
            <span style={{ flexShrink: 0, fontSize: 11, lineHeight: 1, opacity: 0.9 }} aria-hidden="true">
              ⊞
            </span>
          )}
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
    </>
  );
});
