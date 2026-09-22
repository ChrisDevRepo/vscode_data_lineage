import { memo } from 'react';
import { Handle, Position, NodeToolbar } from '@xyflow/react';
import { TYPE_COLORS, TYPE_LABELS, SHORT_TYPE_LABELS, getSchemaColor, getExternalNodeColor } from '../utils/schemaColors';
import { resolveNodeHighlightStyle } from '../utils/nodeHighlightVisuals';
import { Tooltip } from './ui/Tooltip';
import { AiBadgeToolbar, AiNoteToolbar } from './AiNodeAnnotations';
import { CloseIcon } from './ui/CloseIcon';
import { useTraceNeighborPicker } from '../hooks/useTraceNeighborPicker';
import type { CustomNodeData, TraceNeighborOption, TraceNodeControls } from '../engine/types';
import type { NeighborSide } from '../engine/graphGuards';

/** User action supported by the interactive trace node controls. */
export type TraceNeighborAction = 'add' | 'prune';

/** Picker state for adding or pruning one inbound or outbound neighbor set. */
export type TraceNeighborPicker = {
  action: TraceNeighborAction;
  side: NeighborSide;
  options: TraceNeighborOption[];
};

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

/** One add/prune control on a trace node; hidden when that side has no neighbors at all. */
export function TraceActionButton({
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
  // Smart-hide: suppress only when the side has nothing to act on; otherwise show it grayed with a tooltip.
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

/** Bottom toolbar listing neighbor options for the active add/prune picker. */
export function TraceNeighborPickerToolbar({
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

/** Render the × control that removes a node from the active allowlist-backed view. */
export function NodeRemoveButton({ id, onRemove }: { id: string; onRemove?: (nodeId: string) => void }) {
  return (
    <Tooltip content="Remove from view" placement="top" asChild>
      <button
        aria-label="Remove from view"
        className="absolute flex items-center justify-center text-[9px] rounded-sm ln-node-remove-btn"
        style={{ top: 2, right: 2, width: 14, height: 14, lineHeight: 1, zIndex: 10 }}
        onClick={(e) => { e.stopPropagation(); onRemove?.(id); }}
      >
        ×
      </button>
    </Tooltip>
  );
}

/** Render the four add/prune neighbor buttons for a node's in/out trace sides; nothing without trace controls. */
export function TraceControlsRail({
  traceControls,
  onAction,
}: {
  traceControls: TraceNodeControls | undefined;
  onAction: (action: TraceNeighborAction, side: NeighborSide, options: TraceNeighborOption[]) => void;
}) {
  if (!traceControls) return null;
  return (
    <>
      <TraceActionButton action="add" side="in" options={traceControls.in.add} hasContext={traceControls.in.neighborCount > 0} disabledReason={traceControls.in.addDisabledReason} onAction={onAction} />
      <TraceActionButton action="prune" side="in" options={traceControls.in.prune} hasContext={traceControls.in.visibleNeighborCount > 0} disabledReason={traceControls.in.pruneDisabledReason} onAction={onAction} />
      <TraceActionButton action="add" side="out" options={traceControls.out.add} hasContext={traceControls.out.neighborCount > 0} disabledReason={traceControls.out.addDisabledReason} onAction={onAction} />
      <TraceActionButton action="prune" side="out" options={traceControls.out.prune} hasContext={traceControls.out.visibleNeighborCount > 0} disabledReason={traceControls.out.pruneDisabledReason} onAction={onAction} />
    </>
  );
}

function CustomNodeComponent({ id, data }: { id: string; data: CustomNodeData }) {
  const style = TYPE_COLORS[data.objectType] || TYPE_COLORS.table;
  const isExternal = data.objectType === 'external';
  const isVirtual = data.externalType === 'file' || data.externalType === 'db';
  const displayIcon = isVirtual ? '⬡' : data.externalType === 'et' ? '⬢' : style.icon;
  const schemaColor = isExternal ? getExternalNodeColor() : (data.schemaColor ?? getSchemaColor(data.schema));
  const { isHighlighted: highlighted, highlightColor, boxShadow, opacity, transform, zIndex } =
    resolveNodeHighlightStyle(data.highlighted, data.aiHighlight, data.dimmed);

  const tooltipLines: string[] = [];
  if (data.externalType === 'file' && data.externalUrl) tooltipLines.push(data.externalUrl);
  else if (data.externalType === 'db' && data.externalDatabase) tooltipLines.push(`${data.externalDatabase}.${data.label}`);
  else tooltipLines.push(`${data.schema}.${data.label}`);
  tooltipLines.push(`Object Type: ${TYPE_LABELS[data.objectType]}${isVirtual ? (data.externalType === 'file' ? ' (File Source)' : ' (Cross-Database)') : ''}`);
  tooltipLines.push(`In: ${data.inDegree} | Out: ${data.outDegree}`);

  const tooltipContent: string = tooltipLines.join('\n');

  const { picker, applyTraceAction, closePicker, selectPickerOption } = useTraceNeighborPicker(data.traceControls);

  return (
    <>
      {picker && (
        <TraceNeighborPickerToolbar picker={picker} onClose={closePicker} onSelect={selectPickerOption} />
      )}
      {data.aiBadge && <AiBadgeToolbar {...data.aiBadge} />}
      {data.aiNote && <AiNoteToolbar text={data.aiNote.text} />}
      <Tooltip content={tooltipContent} placement="top" multiline maxWidth={300} asChild>
        <div
          className="rounded-lg border-2 transition-all duration-300 ease-in-out ln-node-card"
          style={{
            position: 'relative',
            borderColor: highlighted ? highlightColor : 'var(--ln-node-border)',
            borderLeftColor: highlighted ? highlightColor : schemaColor,
            borderLeftWidth: 6,
            backgroundColor: 'var(--ln-node-bg)',
            opacity,
            width: 180,
            height: 70,
            boxShadow,
            transform,
            zIndex,
          }}
        >
          {data.showRemoveButton && <NodeRemoveButton id={id} onRemove={data.onRemoveFromView} />}
          <TraceControlsRail traceControls={data.traceControls} onAction={applyTraceAction} />
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
