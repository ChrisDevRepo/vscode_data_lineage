import { memo, useState, useCallback, useRef, useEffect } from 'react';
import type { ColumnDef, ForeignKeyInfo, ObjectType } from '../engine/types';
import type { TableStats, StatsMode } from '../engine/profilingEngine';
import { TYPE_COLORS } from '../utils/schemaColors';
import { CloseIcon } from './ui/CloseIcon';
import { ColumnTable } from './ColumnTable';
import { ForeignKeysSection } from './ForeignKeysSection';
import { StatsSection } from './StatsSection';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TableStatsState =
  | { phase: 'idle' }
  | { phase: 'loading'; mode: StatsMode }
  | { phase: 'result'; stats: TableStats; mode: StatsMode }
  | { phase: 'error'; message: string };

export interface TableDetailPanelProps {
  schema: string;
  objectName: string;
  objectType: 'table' | 'external';
  externalType?: 'et' | 'file' | 'db';
  columns: ColumnDef[];
  fks: ForeignKeyInfo[];
  statsState: TableStatsState;
  onClose: () => void;
  onRequestStats: (mode: StatsMode) => void;
  isDbMode: boolean;
  statsEnabled: boolean;
  excludeExternalTables: boolean;
  standardModeEnabled: boolean;
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 400;

// ─── Main Component ───────────────────────────────────────────────────────────

export const TableDetailPanel = memo(function TableDetailPanel({
  schema,
  objectName,
  objectType,
  externalType,
  columns,
  fks,
  statsState,
  onClose,
  onRequestStats,
  isDbMode,
  statsEnabled,
  excludeExternalTables,
  standardModeEnabled,
}: TableDetailPanelProps) {
  const typeIcon = TYPE_COLORS[objectType as ObjectType]?.icon ?? '■';
  const typeLabel = externalType === 'file' ? 'FILE SOURCE'
    : externalType === 'db' ? 'CROSS-DATABASE'
    : objectType === 'external' ? 'EXTERNAL TABLE' : 'TABLE';
  const isVirtualExt = externalType === 'file' || externalType === 'db';

  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = startX.current - e.clientX;
    const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
    setPanelWidth(newWidth);
  }, []);

  const onMouseUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }, [onMouseMove]);

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [panelWidth, onMouseMove, onMouseUp]);

  return (
    <div
      style={{
        width: panelWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        background: 'var(--ln-bg)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        style={{
          width: 4,
          flexShrink: 0,
          cursor: 'col-resize',
          borderLeft: '1px solid var(--ln-border)',
          background: 'transparent',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ln-focus-border)'; }}
        onMouseLeave={e => { if (!dragging.current) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />

      {/* Panel content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 12px',
            background: 'var(--ln-sidebar-header-bg)',
            borderBottom: '1px solid var(--ln-border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <span style={{ color: 'var(--ln-fg-muted)', fontSize: 12 }}>{typeIcon}</span>
            <span
              className="font-mono text-xs truncate"
              style={{ color: 'var(--ln-sidebar-header-fg)', fontWeight: 600 }}
              title={schema ? `[${schema}].[${objectName}]` : objectName}
            >
              {schema ? <>[{schema}].[{objectName}]</> : objectName}
            </span>
          </div>
          <button
            onClick={onClose}
            className="opacity-60 hover:opacity-100 cursor-pointer flex-shrink-0 ml-2"
            style={{ color: 'var(--ln-fg)', background: 'none', border: 'none', padding: 0 }}
            title="Close"
          >
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Type label */}
          <div className="text-xs font-semibold tracking-wider" style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
            {typeLabel}
          </div>

          {/* Column table */}
          <ColumnTable columns={columns} isVirtualExt={isVirtualExt} />

          {/* Foreign Keys section */}
          {fks.length > 0 && <ForeignKeysSection fks={fks} />}

          {/* Statistics section — only shown for DB mode */}
          {isDbMode && statsEnabled && !isVirtualExt && !(excludeExternalTables && objectType === 'external') && (
            <StatsSection
              statsState={statsState}
              onRequestStats={onRequestStats}
              schema={schema}
              objectName={objectName}
              standardModeEnabled={standardModeEnabled}
            />
          )}
        </div>
      </div>
    </div>
  );
});
