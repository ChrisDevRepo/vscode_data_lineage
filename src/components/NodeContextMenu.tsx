import { memo, useState, useEffect, useRef, type ReactNode } from 'react';
import {
  useFloating,
  useInteractions,
  useDismiss,
  flip,
  shift,
  offset,
} from '@floating-ui/react';
import { FloatingPortal } from '@floating-ui/react';
import type { ObjectType } from '../engine/types';
import type { RemoveAction } from '../engine/modeCapabilities';
import { disabledControl } from './ui/disabledControl';
import { escapeRegexLiteral } from '../utils/sql';

/** Cursor-anchored Floating UI wiring shared by every right-click menu in the canvas. */
function useContextMenuFloating(x: number, y: number, onClose: () => void) {
  const virtualRef = useRef({
    getBoundingClientRect() {
      return { x, y, width: 0, height: 0, top: y, right: x, bottom: y, left: x };
    },
  });

  useEffect(() => {
    virtualRef.current.getBoundingClientRect = () => ({
      x, y, width: 0, height: 0, top: y, right: x, bottom: y, left: x,
    });
  }, [x, y]);

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
    middleware: [
      offset(2),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  useEffect(() => {
    refs.setReference(virtualRef.current);
  }, [refs]);

  const dismiss = useDismiss(context, { referencePress: true });
  const { getFloatingProps } = useInteractions([dismiss]);

  return { refs, floatingStyles, getFloatingProps };
}

interface NodeContextMenuProps {
  /** X-coordinate for the menu origin. */
  x: number;
  /** Y-coordinate for the menu origin. */
  y: number;
  /** ID of the node the menu was opened for. */
  nodeId: string;
  /** Name of the database object. */
  nodeName: string;
  /** Schema of the database object. */
  schema: string;
  /** The specific type of database object (e.g. table, view, proc). */
  objectType: ObjectType;
  /** Optional subtype for external references. */
  externalType?: 'et' | 'file' | 'db';
  /** URL or path for file-based external references. */
  externalUrl?: string;
  /** Full qualified name for cross-database references. */
  fullName?: string;
  /** Whether a trace/path mode is currently active. */
  isTracing: boolean;
  /** Callback fired when the menu is closed. */
  onClose: () => void;
  /** Callback to initiate a level-based trace from this node. */
  onTrace: (nodeId: string) => void;
  /** Callback to initiate pathfinding from this node. */
  onFindPath: (nodeId: string) => void;
  /** Callback to open the DDL viewer for this node. */
  onViewDdl: (nodeId: string) => void;
  /** Callback to show the detailed info bar for this node. */
  onShowDetails: (nodeId: string) => void;
  /**
   * What "remove from what is on screen" does for this node, from
   * {@link import('../engine/modeCapabilities').resolveRemoveAction} — the single Remove item
   * this menu renders always shown, disabled with its reason when refused, never omitted.
   */
  removeAction: RemoveAction;
  /** Callback to add a new exclusion rule based on this node's name (`removeAction.kind === 'exclude'`). */
  onExcludeNode?: (pattern: string) => void;
  /** Callback to prune this node from the active trace (`removeAction.kind === 'trace-prune'`). */
  onTracePruneNode?: (nodeId: string) => void;
  /** Callback to remove this node from the active curated/bookmark view (`removeAction.kind === 'curated-remove'`). */
  onCuratedRemoveNode?: (nodeId: string) => void;
  /** Callback to collapse this node's schema in Expanded Schema View. */
  onCollapseSchema?: (schema: string) => void;
}

/** Shared row styling for a full-width menu button, dimmed and inert when `disabled`. */
function MenuButton({ onClick, disabled, reason, children }: { onClick: () => void; disabled?: boolean; reason?: string; children: ReactNode }) {
  const trigger = disabledControl(onClick, disabled, reason);
  return (
    <button
      onClick={trigger.onClick}
      disabled={trigger.disabled}
      title={trigger.tooltip}
      aria-disabled={disabled}
      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${disabled ? 'opacity-50 cursor-not-allowed ln-text-dim' : 'ln-list-item'}`}
    >
      {children}
    </button>
  );
}

const REMOVE_ICON = 'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636';

/** Label the single Remove item shows for each {@link RemoveAction} kind. */
function removeActionLabel(action: RemoveAction): string {
  switch (action.kind) {
    case 'exclude': return 'Exclude from view';
    case 'trace-prune': return 'Remove from trace';
    case 'curated-remove': return 'Remove from view';
    case 'refuse': return 'Remove';
  }
}

/**
 * A context menu for graph nodes, providing quick access to lineage and inspection tools.
 *
 * It uses Floating UI to position itself at the cursor coordinates and handles:
 * - Initiating Trace and Pathfinding modes.
 * - Opening DDL and Table Detail views.
 * - Copying qualified names to the clipboard.
 * - Removing the node from whatever scope currently owns it.
 *
 * @param props - The component props.
 * @returns A portal-rendered React component.
 */
export const NodeContextMenu = memo(function NodeContextMenu({
  x,
  y,
  nodeId,
  nodeName,
  schema,
  objectType,
  externalType,
  externalUrl,
  fullName,
  isTracing,
  onClose,
  onTrace,
  onFindPath,
  onViewDdl,
  onShowDetails,
  removeAction,
  onExcludeNode,
  onTracePruneNode,
  onCuratedRemoveNode,
  onCollapseSchema,
}: NodeContextMenuProps) {
  const [copyFailed, setCopyFailed] = useState(false);
  const { refs, floatingStyles, getFloatingProps } = useContextMenuFloating(x, y, onClose);

  const isExternal = externalType === 'file' || externalType === 'db';
  const effectiveRemoveAction: RemoveAction = removeAction.kind === 'exclude' && isExternal
    ? { kind: 'refuse', reason: 'External references cannot be excluded here' }
    : removeAction;

  const handleRemove = () => {
    if (effectiveRemoveAction.kind === 'exclude') {
      onExcludeNode?.(`^${escapeRegexLiteral(schema)}\\.${escapeRegexLiteral(nodeName)}$`);
    } else if (effectiveRemoveAction.kind === 'trace-prune') {
      onTracePruneNode?.(nodeId);
    } else if (effectiveRemoveAction.kind === 'curated-remove') {
      onCuratedRemoveNode?.(nodeId);
    }
    onClose();
  };

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, zIndex: 50, boxShadow: 'var(--ln-dropdown-shadow)' }}
        className="rounded-lg py-1 min-w-[180px] ln-dropdown"
        {...getFloatingProps()}
      >
        <div className="px-3 py-1.5 text-xs truncate ln-text-muted ln-border-bottom">
          {schema}.{nodeName}
        </div>

        {!isTracing && (
          <>
            <button
              onClick={() => { onTrace(nodeId); onClose(); }}
              className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5" />
              </svg>
              Trace Levels
            </button>
            <button
              onClick={() => { onFindPath(nodeId); onClose(); }}
              className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
              </svg>
              Find Path
            </button>
            <div className="my-1 ln-border-top" />
          </>
        )}

        {(objectType === 'table' || objectType === 'external') ? (
          <button
            onClick={() => { onViewDdl(nodeId); onClose(); }}
            className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125v1.5m2.25-2.625c.621 0 1.125.504 1.125 1.125v1.5m-2.25 0v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M11.25 15v-1.5" />
            </svg>
            Show Table Details
          </button>
        ) : (
          <button
            onClick={() => { onViewDdl(nodeId); onClose(); }}
            className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
            Show DDL
          </button>
        )}

        <button
          onClick={() => { onShowDetails(nodeId); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          Show Details
        </button>

        {onCollapseSchema && (
          <>
            <div className="my-1 ln-border-top" />
            <button
              onClick={() => { onCollapseSchema(schema); onClose(); }}
              className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M4.5 4.5h15v15h-15v-15Z" />
              </svg>
              Collapse schema
            </button>
          </>
        )}

        <div className="my-1 ln-border-top" />
        <MenuButton onClick={handleRemove} disabled={effectiveRemoveAction.kind === 'refuse'} reason={effectiveRemoveAction.kind === 'refuse' ? effectiveRemoveAction.reason : undefined}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d={REMOVE_ICON} />
          </svg>
          {removeActionLabel(effectiveRemoveAction)}
        </MenuButton>

        <div className="my-1 ln-border-top" />

        <button
          onClick={() => {
            const copyText = externalType === 'file' ? (externalUrl ?? nodeName)
              : externalType === 'db' ? (fullName ?? `[${schema}].[${nodeName}]`)
              : `[${schema}].[${nodeName}]`;
            (navigator.clipboard?.writeText(copyText) ?? Promise.reject(new Error('Clipboard unavailable')))
              .then(() => onClose())
              .catch((_err) => { setCopyFailed(true); setTimeout(() => setCopyFailed(false), 2000); });
          }}
          className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
          </svg>
          {copyFailed ? 'Copy failed' : 'Copy Qualified Name'}
        </button>
      </div>
    </FloatingPortal>
  );
});

interface SchemaContextMenuProps {
  /** X-coordinate for the menu origin. */
  x: number;
  /** Y-coordinate for the menu origin. */
  y: number;
  /** Schema name the right-clicked cluster represents. */
  schema: string;
  /** Whether this schema is currently expanded in Expanded Schema View. */
  isExpanded: boolean;
  /** Reason Expand/Collapse is disabled this render, or `undefined` when allowed. */
  disabledReason?: string;
  /** Callback fired when the menu is closed. */
  onClose: () => void;
  /** Expands this schema in Expanded Schema View. */
  onExpand: (schema: string) => void;
  /** Collapses this schema out of Expanded Schema View. */
  onCollapse: (schema: string) => void;
}

/** Right-click menu for a Schema View cluster: Expand/Collapse, the one action a schema box owns. */
export const SchemaContextMenu = memo(function SchemaContextMenu({
  x,
  y,
  schema,
  isExpanded,
  disabledReason,
  onClose,
  onExpand,
  onCollapse,
}: SchemaContextMenuProps) {
  const { refs, floatingStyles, getFloatingProps } = useContextMenuFloating(x, y, onClose);

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, zIndex: 50, boxShadow: 'var(--ln-dropdown-shadow)' }}
        className="rounded-lg py-1 min-w-[180px] ln-dropdown"
        {...getFloatingProps()}
      >
        <div className="px-3 py-1.5 text-xs truncate ln-text-muted ln-border-bottom">{schema}</div>
        <MenuButton onClick={() => { (isExpanded ? onCollapse : onExpand)(schema); onClose(); }} disabled={!!disabledReason} reason={disabledReason}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d={isExpanded ? 'M5 12h14M4.5 4.5h15v15h-15v-15Z' : 'M12 4.5v15m7.5-7.5h-15'} />
          </svg>
          {isExpanded ? 'Collapse schema' : 'Expand schema'}
        </MenuButton>
      </div>
    </FloatingPortal>
  );
});
