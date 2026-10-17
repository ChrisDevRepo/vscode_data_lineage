import { memo } from 'react';
import type { ColumnDef, ForeignKeyInfo, ObjectType } from '../engine/types';
import type { TableStats, StatsMode } from '../engine/profilingEngine';
import { TYPE_COLORS } from '../utils/schemaColors';
import { CloseIcon } from './ui/CloseIcon';
import { Tooltip } from './ui/Tooltip';
import { ColumnTable } from './ColumnTable';
import { ForeignKeysSection } from './ForeignKeysSection';
import { StatsSection } from './StatsSection';


/** Represents the lifecycle and data state of table statistics profiling. */
export type TableStatsState =
  | { phase: 'idle' }
  | { phase: 'loading'; mode: StatsMode }
  | { phase: 'result'; stats: TableStats; mode: StatsMode }
  | { phase: 'error'; message: string };

/** Data, configuration, and callbacks required by {@link TableDetailPanel}. */
export interface TableDetailPanelProps {
  /** Database schema name (e.g., 'dbo'). */
  schema: string;
  /** Name of the table, view, or function. */
  objectName: string;
  /** The primary classification of the object. */
  objectType: 'table' | 'external' | 'view' | 'function';
  /** Optional subtype for external or virtual tables. */
  externalType?: 'et' | 'file' | 'db';
  /** List of columns with their data types and primary key status. */
  columns: ColumnDef[];
  /** Foreign key relationships where this table is the source. */
  fks: ForeignKeyInfo[];
  /** Current state of data profiling for this table. */
  statsState: TableStatsState;
  /** Callback to close the panel. */
  onClose: () => void;
  /** Callback to trigger a statistics profiling run. */
  onRequestStats: (mode: StatsMode) => void;
  /** Whether the application is connected to a live database. */
  isDbMode: boolean;
  /** Whether the statistics feature is enabled in user settings. */
  statsEnabled: boolean;
  /** Whether to suppress stats for external tables (polybase, etc.). */
  excludeExternalTables: boolean;
  /** Whether deep profiling (standard mode) is permitted. */
  standardModeEnabled: boolean;
  /** Term used to highlight matches in column names or references. */
  findQuery?: string;
  /** If true, hides non-essential columns (e.g., Null/Flags) for compact views. */
  compactColumns?: boolean;
}

/** Displays columns, foreign keys, and profiling metrics for the selected database object. */
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
  findQuery,
  compactColumns,
}: TableDetailPanelProps) {
  const typeIcon = TYPE_COLORS[objectType as ObjectType]?.icon ?? '■';
  const typeLabel = externalType === 'file' ? 'FILE SOURCE'
    : externalType === 'db' ? 'CROSS-DATABASE'
    : objectType === 'external' ? 'EXTERNAL TABLE'
    : objectType === 'view' ? 'VIEW'
    : objectType === 'function' ? 'FUNCTION'
    : 'TABLE';
  const isVirtualExt = externalType === 'file' || externalType === 'db';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        background: 'var(--ln-bg)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
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
            <Tooltip content={schema ? `[${schema}].[${objectName}]` : objectName} asChild>
              <span
                className="font-mono text-xs truncate"
                style={{ color: 'var(--ln-sidebar-header-fg)', fontWeight: 600 }}
              >
              {schema ? <>[{schema}].[{objectName}]</> : objectName}
            </span>
            </Tooltip>
          </div>
          <Tooltip content="Close">
            <button
              onClick={onClose}
              aria-label="Close detail panel"
              className="opacity-60 hover:opacity-100 cursor-pointer shrink-0 ml-2"
              style={{ color: 'var(--ln-fg)', background: 'none', border: 'none', padding: 0 }}
            >
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
          </Tooltip>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="ln-section-label">
            {typeLabel}
          </div>

          <ColumnTable columns={columns} isVirtualExt={isVirtualExt} findQuery={findQuery} compact={compactColumns} />

          {fks.length > 0 && <ForeignKeysSection fks={fks} findQuery={findQuery} />}

          {isDbMode && statsEnabled && !isVirtualExt && !(excludeExternalTables && objectType === 'external') && (
            <StatsSection
              statsState={statsState}
              onRequestStats={onRequestStats}
              standardModeEnabled={standardModeEnabled}
            />
          )}
        </div>
      </div>
    </div>
  );
});
