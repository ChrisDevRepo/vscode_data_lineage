import { memo, useEffect, useState, type ReactNode } from 'react';
import { Handle, Position, NodeToolbar } from '@xyflow/react';
import { TYPE_COLORS, TYPE_LABELS, SHORT_TYPE_LABELS, getSchemaColor, getExternalNodeColor } from '../utils/schemaColors';
import { Tooltip } from './ui/Tooltip';
import { CloseIcon } from './ui/CloseIcon';
import type { ObjectType } from '../engine/types';
import type { NeighborSide } from '../engine/graphGuards';

/** One column-level flow row shown in a node tooltip. */
export type CtTooltipFlow = {
  /** Neighbor node that contributes or receives the traced column value. */
  neighborNode: string;
  /** Lineage side where the neighbor participates in the column trace. */
  direction: 'in' | 'out';
  /** Source-side column shown in the tooltip flow row. */
  fromCol: string;
  /** Target-side column shown in the tooltip flow row. */
  toCol: string;
};

/** One selectable direct neighbor for interactive trace add/prune controls. */
export type TraceNeighborOption = {
  /** Stable node ID passed back to trace edit handlers. */
  id: string;
  /** Display name shown in the neighbor picker. */
  label: string;
  /** Schema displayed with the neighbor label. */
  schema: string;
  /** Object kind used for compact type badges in the picker. */
  objectType: ObjectType;
};

/** User action supported by the interactive trace node controls. */
type TraceNeighborAction = 'add' | 'prune';

/** Per-node callbacks and candidate lists for interactive trace editing. */
export type TraceNodeControls = {
  /** Controls for upstream direct-neighbor trace edits. */
  in: TraceSideControls;
  /** Controls for downstream direct-neighbor trace edits. */
  out: TraceSideControls;
  /** Adds the selected direct neighbor to the current trace scope. */
  onAdd: (nodeId: string) => void;
  /** Removes the selected node from the current trace scope when safe. */
  onPrune: (nodeId: string) => void;
};

/** Add/prune candidates and disabled-copy for one lineage side of a node. */
export type TraceSideControls = {
  /** Direct neighbors that can be added on this side. */
  add: TraceNeighborOption[];
  /** Visible trace nodes that can be pruned on this side. */
  prune: TraceNeighborOption[];
  /** Reason add controls are disabled, or an empty string when enabled. */
  addDisabledReason: string;
  /** Reason prune controls are disabled, or an empty string when enabled. */
  pruneDisabledReason: string;
  /** Total direct neighbors on this side (drives hide-vs-disable for add). */
  neighborCount: number;
  /** Direct neighbors on this side already in the trace (drives hide-vs-disable for prune). */
  visibleNeighborCount: number;
};

type TraceNeighborPicker = {
  action: TraceNeighborAction;
  side: NeighborSide;
  options: TraceNeighborOption[];
};

/**
 * Returns sorted unique columns for table-style CT tooltip display.
 *
 * @param flows - Column-flow entries to transform.
 *
 * @returns Sorted unique column names across all from/to flow endpoints.
 */
export function buildTableTraceColumns(flows: CtTooltipFlow[]): string[] {
  const cols = new Set<string>();
  for (const f of flows) {
    if (f.fromCol) cols.add(f.fromCol);
    if (f.toCol) cols.add(f.toCol);
  }
  return Array.from(cols).sort((a, b) => a.localeCompare(b));
}

/**
 * Groups CT flows by neighbor with deterministic ordering and de-duplication.
 *
 * @param flows - Column-flow entries to transform.
 *
 * @returns One group per neighbor node with its de-duplicated flow rows, sorted by neighbor.
 */
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

function traceActionLabel(action: TraceNeighborAction, side: NeighborSide): string {
  return `${action === 'add' ? 'Add' : 'Prune'} ${side === 'in' ? 'inbound' : 'outbound'} neighbor`;
}

function traceActionTooltip(
  action: TraceNeighborAction,
  side: NeighborSide,
  options: TraceNeighborOption[],
  disabledReason: string,
): string {
  if (options.length === 0) return disabledReason;

  const label = traceActionLabel(action, side);
  return options.length === 1
    ? `${label}: ${options[0].schema}.${options[0].label}`
    : `${label}: choose one of ${options.length}`;
}

function TraceActionButton({
  action,
  side,
  options,
  hasContext,
  disabledReason,
  onAction,
}: {
  action: TraceNeighborAction;
  side: NeighborSide;
  options: TraceNeighborOption[];
  /** Whether this side has any relevant neighbor — when false the button is hidden, not grayed. */
  hasContext: boolean;
  disabledReason: string;
  onAction: (action: TraceNeighborAction, side: NeighborSide, options: TraceNeighborOption[]) => void;
}) {
  const enabled = options.length > 0;
  // Smart-hide: only suppress the control when the side has nothing to act on at all;
  // otherwise show it grayed with a tooltip explaining why the action is unavailable.
  if (!enabled && !hasContext) return null;

  const label = traceActionLabel(action, side);
  return (
    <Tooltip content={traceActionTooltip(action, side, options, disabledReason)} placement="top" asChild>
      <button
        type="button"
        aria-label={label}
        aria-disabled={!enabled}
        className={`ln-trace-node-action ln-trace-node-action--${side} ln-trace-node-action--${action}${enabled ? '' : ' ln-trace-node-action--disabled'}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!enabled) return;
          onAction(action, side, options);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="ln-trace-node-action__icon">
          {action === 'add' ? (
            <path d="M8 3v10M3 8h10" />
          ) : (
            <path d="M3 8h10" />
          )}
        </svg>
      </button>
    </Tooltip>
  );
}

function TraceNeighborPickerToolbar({
  picker,
  onClose,
  onSelect,
}: {
  picker: TraceNeighborPicker;
  onClose: () => void;
  onSelect: (option: TraceNeighborOption) => void;
}) {
  return (
    <NodeToolbar position={Position.Bottom} align="center" offset={22} isVisible>
      <div className="ln-trace-node-picker" onClick={(e) => e.stopPropagation()}>
        <div className="ln-trace-node-picker__header">
          <span>{picker.action === 'add' ? 'Add neighbor' : 'Prune neighbor'}</span>
          <button
            type="button"
            aria-label="Close"
            className="ln-trace-node-picker__close"
            onClick={onClose}
          >
            <CloseIcon className="w-3 h-3" />
          </button>
        </div>
        {picker.options.map(option => (
          <button
            key={option.id}
            type="button"
            className="ln-trace-node-picker__row"
            onClick={() => onSelect(option)}
          >
            <span className="ln-trace-node-picker__type">{SHORT_TYPE_LABELS[option.objectType]}</span>
            <span className="ln-trace-node-picker__name">[{option.schema}].{option.label}</span>
          </button>
        ))}
      </div>
    </NodeToolbar>
  );
}

/**
 * The business data associated with a single node in the React Flow canvas.
 */
export type CustomNodeData = {
  /** Display label rendered inside the node. */
  label: string;
  /** Schema name used for grouping, color selection, and tooltips. */
  schema: string;
  /** Fully qualified object name used by detail and debug surfaces. */
  fullName: string;
  /** Object kind that drives icon, color, and tooltip behavior. */
  objectType: ObjectType;
  /** Count of upstream dependencies shown in node metadata. */
  inDegree: number;
  /** Count of downstream dependents shown in node metadata. */
  outDegree: number;
  /** Whether the node is de-emphasized in the current scoped view. */
  dimmed?: boolean;
  /** Highlight state applied by search, trace, or AI presentation. */
  highlighted?: boolean | 'yellow';
  /** External reference subtype for file, database, or external-table nodes. */
  externalType?: 'et' | 'file' | 'db';
  /** File or URL target displayed for file-based external references. */
  externalUrl?: string;
  /** Database name displayed for cross-database external references. */
  externalDatabase?: string;
  /** Resolved schema color supplied by the parent graph projection. */
  schemaColor?: string;
  /** AI-authored badge rendered above the node. */
  aiBadge?: { text: string };
  /** AI-authored note rendered below the node. */
  aiNote?: { text: string };
  /** AI-authored highlight styling applied to the node border and glow. */
  aiHighlight?: { color: string; glow: string; shadow: string };
  /** Column-trace rows rendered in the node tooltip. */
  ctColumnFlows?: CtTooltipFlow[];
  /** Whether the scoped-view remove control is shown. */
  showRemoveButton?: boolean;
  /** Removes the node from the active allowlist-backed view. */
  onRemoveFromView?: (nodeId: string) => void;
  /** Interactive trace controls for adding or pruning direct neighbors. */
  traceControls?: TraceNodeControls;
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

  const [picker, setPicker] = useState<TraceNeighborPicker | null>(null);

  useEffect(() => {
    if (!data.traceControls) setPicker(null);
  }, [data.traceControls]);

  const applyTraceAction = (action: TraceNeighborAction, side: NeighborSide, options: TraceNeighborOption[]) => {
    if (!data.traceControls || options.length === 0) return;
    if (options.length === 1) {
      if (action === 'add') data.traceControls.onAdd(options[0].id);
      else data.traceControls.onPrune(options[0].id);
      setPicker(null);
      return;
    }
    setPicker(prev => (
      prev?.action === action && prev.side === side ? null : { action, side, options }
    ));
  };

  return (
    <>
      {picker && (
        <TraceNeighborPickerToolbar
          picker={picker}
          onClose={() => setPicker(null)}
          onSelect={(option) => {
            if (picker.action === 'add') data.traceControls?.onAdd(option.id);
            else data.traceControls?.onPrune(option.id);
            setPicker(null);
          }}
        />
      )}
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
                className="absolute flex items-center justify-center text-[9px] rounded-sm ln-node-remove-btn"
                style={{ top: 2, right: 2, width: 14, height: 14, lineHeight: 1, zIndex: 10 }}
                onClick={(e) => { e.stopPropagation(); data.onRemoveFromView?.(id); }}
              >
                ×
              </button>
            </Tooltip>
          )}
          {data.traceControls && (
            <>
              <TraceActionButton action="add" side="in" options={data.traceControls.in.add} hasContext={data.traceControls.in.neighborCount > 0} disabledReason={data.traceControls.in.addDisabledReason} onAction={applyTraceAction} />
              <TraceActionButton action="prune" side="in" options={data.traceControls.in.prune} hasContext={data.traceControls.in.visibleNeighborCount > 0} disabledReason={data.traceControls.in.pruneDisabledReason} onAction={applyTraceAction} />
              <TraceActionButton action="add" side="out" options={data.traceControls.out.add} hasContext={data.traceControls.out.neighborCount > 0} disabledReason={data.traceControls.out.addDisabledReason} onAction={applyTraceAction} />
              <TraceActionButton action="prune" side="out" options={data.traceControls.out.prune} hasContext={data.traceControls.out.visibleNeighborCount > 0} disabledReason={data.traceControls.out.pruneDisabledReason} onAction={applyTraceAction} />
            </>
          )}
          <Handle type="target" position={Position.Left} className="w-2! h-2! ln-handle" />
          <div className="px-3 pt-1 pb-1 flex flex-col h-full">
            <div className="flex items-center justify-between gap-1.5 whitespace-nowrap" style={{ lineHeight: 1 }}>
              <span className="text-base font-medium whitespace-nowrap leading-none" style={{ color: 'var(--ln-fg-muted)' }}>{displayIcon}</span>
              <span className="text-[9px] shrink-0 whitespace-nowrap" style={{ color: 'var(--ln-fg-muted)' }}>{data.inDegree}↓ {data.outDegree}↑</span>
            </div>
            <div className="text-[11px] overflow-hidden text-ellipsis whitespace-nowrap mt-0.5" style={{ color: 'var(--ln-fg)' }}>{data.label}</div>
            <div className="text-[9px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: 'var(--ln-fg-muted)', lineHeight: 1.1 }}>
              {data.externalType === 'file' ? 'File Source' : data.externalType === 'db' ? `↗ ${data.externalDatabase || 'Cross-DB'}` : data.schema}
            </div>
          </div>
          <Handle type="source" position={Position.Right} className="w-2! h-2! ln-handle" />
        </div>
      </Tooltip>
    </>
  );
}

/**
 * Renders an object or schema node inside the React Flow canvas.
 */
export const CustomNode = memo(CustomNodeComponent);
