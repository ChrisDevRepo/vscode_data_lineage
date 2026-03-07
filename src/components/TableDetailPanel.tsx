import { memo, useState, useCallback, useRef, useEffect } from 'react';
import type { ColumnDef, ForeignKeyInfo, ObjectType } from '../engine/types';
import type { TableStats, StatsMode } from '../engine/profilingEngine';
import { TYPE_COLORS } from '../utils/schemaColors';
import { CloseIcon } from './ui/CloseIcon';

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
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 400;

// ─── Spinner ─────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 inline-block" style={{ color: 'var(--ln-fg-muted)' }}
      xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ─── Stats Results ────────────────────────────────────────────────────────────

function StatsResults({ stats, mode }: { stats: TableStats; mode: StatsMode }) {
  return (
    <div className="text-xs" style={{ color: 'var(--ln-fg)' }}>
      {/* Summary badges */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        <span className="px-2 py-0.5 rounded text-xs font-mono"
          style={{ background: 'var(--ln-bg-elevated)', border: '1px solid var(--ln-border-light)', color: 'var(--ln-fg)' }}>
          {stats.rowCount.toLocaleString()} rows
        </span>
        {stats.sampled && stats.samplePercent !== undefined && (
          <span className="px-2 py-0.5 rounded text-xs"
            style={{ background: 'var(--ln-warning-bg)', border: '1px solid var(--ln-warning-border)', color: 'var(--ln-warning-fg)' }}>
            sampled {stats.samplePercent}%
          </span>
        )}
        <span className="px-2 py-0.5 rounded text-xs"
          style={{ background: 'var(--ln-bg-elevated)', border: '1px solid var(--ln-border-light)', color: 'var(--ln-fg-muted)' }}>
          {stats.columns.filter(c => !c.skipped).length} profiled
        </span>
      </div>

      {/* Per-column stats table */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
            <th className="text-left pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)', width: '40%' }}>Column</th>
            <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Distinct</th>
            <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Null%</th>
            {mode === 'detail' && (
              <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Min / Max</th>
            )}
          </tr>
        </thead>
        <tbody>
          {stats.columns.map(col => (
            <tr key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
              <td className="py-0.5 pr-1 truncate font-mono" style={{ color: 'var(--ln-fg)', maxWidth: '0' }}>
                {col.skipped
                  ? <span style={{ color: 'var(--ln-fg-dim)' }}>{col.name}</span>
                  : col.name
                }
              </td>
              <td className="py-0.5 text-right font-mono" style={{ color: 'var(--ln-fg)' }}>
                {col.skipped ? <span style={{ color: 'var(--ln-fg-dim)' }}>—</span> : col.distinctCount.toLocaleString()}
              </td>
              <td className="py-0.5 text-right font-mono" style={{ color: 'var(--ln-fg)' }}>
                {col.skipped
                  ? <span style={{ color: 'var(--ln-fg-dim)' }}>—</span>
                  : col.nullPercent === null
                    ? 'NOT NULL'
                    : `${col.nullPercent.toFixed(1)}%`
                }
              </td>
              {mode === 'detail' && (
                <td className="py-0.5 text-right font-mono text-xs" style={{ color: 'var(--ln-fg-muted)' }}>
                  {col.skipped ? <span style={{ color: 'var(--ln-fg-dim)' }}>—</span>
                    : col.min !== undefined ? `${col.min} / ${col.max}`
                    : col.minLength !== undefined ? `${col.minLength} / ${col.maxLength} len`
                    : '—'
                  }
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── FK Section ──────────────────────────────────────────────────────────────

function ForeignKeysSection({ fks }: { fks: ForeignKeyInfo[] }) {
  return (
    <div style={{ borderTop: '1px solid var(--ln-border)', paddingTop: 10 }}>
      <div className="text-xs font-semibold tracking-wider mb-2"
        style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
        FOREIGN KEYS
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>Constraint</th>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>Column(s)</th>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>References</th>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>On Delete</th>
          </tr>
        </thead>
        <tbody>
          {fks.map(fk => (
            <tr key={fk.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }} title={fk.name}>
                {fk.name}
              </td>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }} title={fk.columns.join(', ')}>
                {fk.columns.join(', ')}
              </td>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }}
                title={`[${fk.refSchema}].[${fk.refTable}](${fk.refColumns.join(', ')})`}>
                [{fk.refSchema}].[{fk.refTable}]
              </td>
              <td className="py-0.5 text-xs font-mono" style={{ color: 'var(--ln-fg-dim)' }}>
                {fk.onDelete}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
}: TableDetailPanelProps) {
  const typeIcon = TYPE_COLORS[objectType as ObjectType]?.icon ?? '■';
  const typeLabel = externalType === 'file' ? 'FILE SOURCE'
    : externalType === 'db' ? 'CROSS-DATABASE'
    : objectType === 'external' ? 'EXTERNAL TABLE' : 'TABLE';
  const isVirtualExt = externalType === 'file' || externalType === 'db';
  const isLoading = statsState.phase === 'loading';

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
          {columns.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>No column metadata available.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
                  <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)', width: '38%' }}>Name</th>
                  <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)', width: '30%' }}>Type</th>
                  <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)', width: '18%' }}>Null</th>
                  <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>Flags</th>
                </tr>
              </thead>
              <tbody>
                {columns.map(col => {
                  const flags = [
                    col.extra || '',
                    col.unique ? 'UQ' : '',
                    col.check ? 'CK' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <tr key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
                      <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }} title={col.name}>
                        {col.name}
                      </td>
                      <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }} title={col.type}>
                        {col.type}
                      </td>
                      <td className="py-0.5 text-xs" style={{ color: col.nullable === 'NULL' ? 'var(--ln-fg-dim)' : 'var(--ln-fg-muted)' }}>
                        {col.nullable === 'NULL' ? 'null' : ''}
                      </td>
                      <td className="py-0.5 text-xs font-mono" style={{ color: 'var(--ln-fg-dim)' }}>
                        {flags}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Foreign Keys section */}
          {fks.length > 0 && <ForeignKeysSection fks={fks} />}

          {/* Statistics section — only shown for DB mode */}
          {isDbMode && statsEnabled && !isVirtualExt && (
            <div style={{ borderTop: '1px solid var(--ln-border)', paddingTop: 10 }}>
              <div className="text-xs font-semibold tracking-wider mb-2 flex items-center justify-between"
                style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
                <span>STATISTICS</span>
                {isLoading && <Spinner />}
              </div>

              {/* Quick / Detail buttons */}
              <div className="flex gap-1.5 mb-3">
                <button
                  disabled={isLoading}
                  onClick={() => onRequestStats('quick')}
                  className="text-xs px-2.5 py-1 rounded cursor-pointer disabled:opacity-50"
                  style={{
                    background: statsState.phase === 'result' && statsState.mode === 'quick'
                      ? 'var(--ln-button-bg)' : 'var(--ln-button-secondary-bg)',
                    color: statsState.phase === 'result' && statsState.mode === 'quick'
                      ? 'var(--ln-button-fg)' : 'var(--ln-button-secondary-fg)',
                    border: '1px solid var(--ln-border-light)',
                  }}
                >
                  Quick Stats
                </button>
                <button
                  disabled={isLoading}
                  onClick={() => onRequestStats('detail')}
                  className="text-xs px-2.5 py-1 rounded cursor-pointer disabled:opacity-50"
                  style={{
                    background: statsState.phase === 'result' && statsState.mode === 'detail'
                      ? 'var(--ln-button-bg)' : 'var(--ln-button-secondary-bg)',
                    color: statsState.phase === 'result' && statsState.mode === 'detail'
                      ? 'var(--ln-button-fg)' : 'var(--ln-button-secondary-fg)',
                    border: '1px solid var(--ln-border-light)',
                  }}
                >
                  Detail Stats
                </button>
              </div>

              {/* Stats state */}
              {statsState.phase === 'loading' && (
                <div className="text-xs" style={{ color: 'var(--ln-fg-muted)' }}>
                  Running {statsState.mode} profiling…
                </div>
              )}
              {statsState.phase === 'error' && (
                <div className="text-xs px-2 py-1.5 rounded"
                  style={{
                    background: 'var(--ln-validation-error-bg)',
                    border: '1px solid var(--ln-validation-error-border)',
                    color: 'var(--ln-fg)',
                  }}>
                  {statsState.message}
                </div>
              )}
              {statsState.phase === 'result' && (
                <StatsResults stats={statsState.stats} mode={statsState.mode} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
