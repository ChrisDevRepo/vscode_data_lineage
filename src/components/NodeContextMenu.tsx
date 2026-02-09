import { memo } from 'react';
import type { ObjectType } from '../engine/types';

interface NodeContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  nodeName: string;
  schema: string;
  objectType: ObjectType;
  isTracing: boolean;
  onClose: () => void;
  onTrace: (nodeId: string) => void;
  onViewDdl: (nodeId: string) => void;
  onShowDetails: (nodeId: string) => void;
}

export const NodeContextMenu = memo(function NodeContextMenu({
  x,
  y,
  nodeId,
  nodeName,
  schema,
  objectType,
  isTracing,
  onClose,
  onTrace,
  onViewDdl,
  onShowDetails,
}: NodeContextMenuProps) {
  return (
    <>
      {/* Fullscreen backdrop — click anywhere to close */}
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />

      <div
        className="fixed rounded-lg shadow-xl py-1 z-50 min-w-[180px] ln-modal"
        style={{ left: x, top: y }}
      >
        <div className="px-3 py-1.5 text-xs truncate ln-text-dim ln-border-bottom">
          {schema}.{nodeName}
        </div>

        {!isTracing && (
          <>
            <button
              onClick={() => { onTrace(nodeId); onClose(); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5" />
              </svg>
              Start Trace
            </button>
            <div className="my-1 ln-border-top" />
          </>
        )}

        <button
          onClick={() => { onViewDdl(nodeId); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
          title="View DDL definition"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          View DDL
        </button>

        <button
          onClick={() => { onShowDetails(nodeId); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
          title="Show node details in info bar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          Show Details
        </button>

        <div className="my-1 ln-border-top" />

        <button
          onClick={() => { navigator.clipboard.writeText(`[${schema}].[${nodeName}]`); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80 ln-text flex items-center gap-2"
          title="Copy [schema].[name] to clipboard"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
          </svg>
          Copy Qualified Name
        </button>
      </div>
    </>
  );
});
