import { memo, type ReactNode } from 'react';
import { Handle, Position, NodeToolbar } from '@xyflow/react';
import { TYPE_COLORS, TYPE_LABELS, getSchemaColor, getExternalNodeColor } from '../utils/schemaColors';
import { Tooltip } from './ui/Tooltip';
import type { ObjectType } from '../engine/types';

export type CtTooltipFlow = { neighborNode: string; direction: 'in' | 'out'; fromCol: string; toCol: string };

/** Returns sorted unique columns for table-style CT tooltip display. */
export function buildTableTraceColumns(flows: CtTooltipFlow[]): string[] {
  const cols = new Set<string>();
  for (const f of flows) {
    if (f.fromCol) cols.add(f.fromCol);
    if (f.toCol) cols.add(f.toCol);
  }
  return Array.from(cols).sort((a, b) => a.localeCompare(b));
}

/** Groups CT flows by neighbor with deterministic ordering and de-duplication. */
export function groupCtFlowsByNeighbor(flows: CtTooltipFlow[]): Array<{ neighborNode: string; rows: CtTooltipFlow[] }> {
  const groups = new Map<string, CtTooltipFlow[]>();
  for (const f of flows) {
    if (!groups.has(f.neighborNode)) groups.set(f.neighborNode, []);
    const arr = groups.get(f.neighborNode)!;
    if (!arr.some(x => x.direction === f.direction && x.fromCol === f.fromCol && x.toCol === f.toCol)) {
      arr.push(f);
    }
  }
  return Array.from(groups.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((neighborNode) => ({ neighborNode, rows: groups.get(neighborNode) ?? [] }));
}

/**
 * The business data associated with a single node in the React Flow canvas.
 */
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
  schemaColor?: string;
  aiBadge?: { text: string };
  aiNote?: { text: string };
  aiHighlight?: { color: string; glow: string; shadow: string };
  ctColumnFlows?: CtTooltipFlow[];
  showRemoveButton?: boolean;
  onRemoveFromView?: (nodeId: string) => void;
};

function CustomNodeComponent({ id, data }: { id: string; data: CustomNodeData }) {
  const style = TYPE_COLORS[data.objectType] || TYPE_COLORS.table;
  const isExternal = data.objectType === 'external';
  const isVirtual = data.externalType === 'file' || data.externalType === 'db';
  const displayIcon = isVirtual ? '⬡' : data.externalType === 'et' ? '⬢' : style.icon;
  const schemaColor = isExternal ? getExternalNodeColor() : (data.schemaColor ?? getSchemaColor(data.schema));
  const dimmed = data.dimmed === true;
  const highlighted = data.highlighted === true || data.highlighted === 'yellow';
  const isYellowHighlight = data.highlighted === 'yellow';

  const highlightColor = data.aiHighlight
    ? data.aiHighlight.color
    : isYellowHighlight ? 'var(--ln-highlight-yellow)' : 'var(--ln-highlight-blue)';

  const tooltipLines: string[] = [];
  if (data.externalType === 'file' && data.externalUrl) tooltipLines.push(data.externalUrl);
  else if (data.externalType === 'db' && data.externalDatabase) tooltipLines.push(`${data.externalDatabase}.${data.label}`);
  else tooltipLines.push(`${data.schema}.${data.label}`);
  tooltipLines.push(`Object Type: ${TYPE_LABELS[data.objectType]}${isVirtual ? (data.externalType === 'file' ? ' (File Source)' : ' (Cross-Database)') : ''}`);
  tooltipLines.push(`In: ${data.inDegree} | Out: ${data.outDegree}`);

  const buildCtTooltipContent = (): ReactNode => {
    if (!data.ctColumnFlows?.length) return tooltipLines.join('\n');

    if (data.objectType === 'table') {
      const cols = buildTableTraceColumns(data.ctColumnFlows);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tooltipLines.map((line, i) => <div key={i}>{line}</div>)}
          <div style={{ borderTop: '1px solid var(--vscode-widget-border, #555)', margin: '3px 0' }} />
          <div style={{ fontWeight: 600, fontSize: '0.85em', color: 'var(--ln-fg-muted)' }}>Trace columns:</div>
          {cols.map((c) => (
            <div key={c} style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{c}</div>
          ))}
        </div>
      );
    }

    const grouped = groupCtFlowsByNeighbor(data.ctColumnFlows);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tooltipLines.map((line, i) => <div key={i}>{line}</div>)}
        <div style={{ borderTop: '1px solid var(--vscode-widget-border, #555)', margin: '3px 0' }} />
        <div style={{ fontWeight: 600, fontSize: '0.85em', color: 'var(--ln-fg-muted)' }}>Column trace:</div>
        {grouped.map(({ neighborNode, rows }) => (
          <div key={neighborNode} style={{ marginTop: 3 }}>
            <div style={{ fontWeight: 600, fontSize: '0.8em', color: 'var(--ln-fg-muted)' }}>{neighborNode}</div>
            {rows.map((r, i) => (
              <div key={`${neighborNode}-${r.direction}-${r.fromCol}-${r.toCol}-${i}`} style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
                {r.direction === 'in' ? `${r.fromCol} → ${r.toCol}` : `${r.toCol} ← ${r.fromCol}`}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const tooltipContent: string | ReactNode = buildCtTooltipContent();

  return (
    <>
      {data.aiBadge && (
        <NodeToolbar position={Position.Top} align="center" offset={2} isVisible>
          <Tooltip content={data.aiBadge.text} placement="top">
            <div className="ln-ai-badge">{data.aiBadge.text}</div>
          </Tooltip>
        </NodeToolbar>
      )}
      {data.aiNote && (
        <NodeToolbar position={Position.Bottom} align="center" offset={2} isVisible>
          <Tooltip content={data.aiNote.text} placement="bottom" multiline maxWidth={400} delay={300}>
            <div className="ln-ai-note-label">{data.aiNote.text.split('\n')[0]}</div>
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
            <div className="flex items-center justify-between gap-1.5 whitespace-nowrap" style={{ lineHeight: 1 }}>
              <span className="text-base font-medium whitespace-nowrap leading-none" style={{ color: 'var(--ln-fg-muted)' }}>{displayIcon}</span>
              <span className="text-[9px] flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--ln-fg-muted)' }}>{data.inDegree}↓ {data.outDegree}↑</span>
            </div>
            <div className="text-[11px] overflow-hidden text-ellipsis whitespace-nowrap mt-0.5" style={{ color: 'var(--ln-fg)' }}>{data.label}</div>
            <div className="text-[9px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: 'var(--ln-fg-muted)', lineHeight: 1.1 }}>
              {data.externalType === 'file' ? 'File Source' : data.externalType === 'db' ? `↗ ${data.externalDatabase || 'Cross-DB'}` : data.schema}
            </div>
          </div>
          <Handle type="source" position={Position.Right} className="!w-2 !h-2 ln-handle" />
        </div>
      </Tooltip>
    </>
  );
}

export const CustomNode = memo(CustomNodeComponent);
