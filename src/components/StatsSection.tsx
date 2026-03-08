import { useState, useCallback, useMemo } from 'react';
import type { TableStats, ColumnStats, StatsMode } from '../engine/profilingEngine';
import type { TableStatsState } from './TableDetailPanel';
import { Button } from './ui/Button';
import { CompletenessBar, UniquenessIndicator, TypeBadge } from './StatsMicroCharts';

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

// ─── Sort Arrow ──────────────────────────────────────────────────────────────

function SortArrow({ dir }: { dir: 'asc' | 'desc' }) {
  return <span style={{ fontSize: '0.6rem', marginLeft: 2 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
}

// ─── Chevron Icon ────────────────────────────────────────────────────────────

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" style={{ transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <path d="M3 1L7 5L3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Type-Adaptive Detail ────────────────────────────────────────────────────

function DetailCell({ col, rowCount }: { col: ColumnStats; rowCount: number }) {
  const segments: React.ReactNode[] = [];

  // Numeric: Range: min … max  |  μ mean  σ stddev  |  N zeros
  if (col.min !== undefined && col.mean !== undefined) {
    segments.push(<span key="range">{col.min} … {col.max}</span>);
    const stats = [`μ${compactNumber(col.mean)}`];
    if (col.stdDev !== undefined) stats.push(`σ${compactNumber(col.stdDev)}`);
    segments.push(<span key="stats">{stats.join('  ')}</span>);
    if (col.zeroCount !== undefined && col.zeroCount > 0) {
      segments.push(<span key="zeros">{col.zeroCount.toLocaleString()} zeros</span>);
    }
  }
  // DateTime: min … max
  else if (col.min !== undefined) {
    segments.push(<span key="range">{col.min} … {col.max}</span>);
  }

  // String: len N–M  |  N empty (P%)
  if (col.minLength !== undefined) {
    const lenStr = col.minLength === col.maxLength ? `len ${col.minLength}` : `len ${col.minLength}–${col.maxLength}`;
    segments.push(<span key="len">{lenStr}</span>);
    if (col.emptyCount !== undefined && col.emptyCount > 0) {
      const pct = rowCount > 0 ? ` (${((col.emptyCount / rowCount) * 100).toFixed(1)}%)` : '';
      segments.push(<span key="empty">{col.emptyCount.toLocaleString()} empty{pct}</span>);
    }
  }

  if (segments.length === 0) return null;

  const sep = <span style={{ color: 'var(--ln-fg-dim)', margin: '0 6px' }}>|</span>;

  return (
    <span className="font-mono" style={{ color: 'var(--ln-fg-muted)', fontSize: '0.65rem', whiteSpace: 'nowrap' }}>
      {segments.map((seg, i) => (
        <span key={i}>{i > 0 && sep}{seg}</span>
      ))}
    </span>
  );
}

/** Check whether a column has any standard-mode detail to show. */
function hasDetail(col: ColumnStats): boolean {
  return col.min !== undefined || col.minLength !== undefined;
}

function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─── Sort Logic ──────────────────────────────────────────────────────────────

type SortKey = 'name' | 'null' | 'distinct';

function sortColumns(cols: ColumnStats[], key: SortKey, dir: 'asc' | 'desc'): ColumnStats[] {
  const sorted = [...cols];
  const mult = dir === 'asc' ? 1 : -1;
  sorted.sort((a, b) => {
    switch (key) {
      case 'name': return mult * a.name.localeCompare(b.name);
      case 'null': {
        const aN = a.nullPercent ?? -1;
        const bN = b.nullPercent ?? -1;
        return mult * (aN - bN);
      }
      case 'distinct': return mult * (a.distinctCount - b.distinctCount);
      default: return 0;
    }
  });
  return sorted;
}

// ─── Grid Layout ─────────────────────────────────────────────────────────────

/**
 * 4-column grid: Name | Type | Null% | Distinct — always visible (Quick baseline).
 * Standard detail renders as a collapsible full-width row below each column,
 * toggled per-row or all-at-once via "Expand All".
 */
const GRID_COLS = 'minmax(60px, 1fr) 38px 46px minmax(70px, auto)';

const cellClip: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// ─── Stats Results Grid ─────────────────────────────────────────────────────

function StatsResults({ stats, mode }: {
  stats: TableStats;
  mode: StatsMode;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [expandedAll, setExpandedAll] = useState(false);
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set());

  const toggleSort = useCallback((key: SortKey) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' }
    );
  }, []);

  const toggleCol = useCallback((name: string) => {
    setExpandedCols(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setExpandedAll(prev => {
      if (!prev) setExpandedCols(new Set()); // clear individual overrides when expanding all
      return !prev;
    });
  }, []);

  const { profiled, skipped } = useMemo(() => {
    const p: ColumnStats[] = [];
    const s: ColumnStats[] = [];
    for (const col of stats.columns) {
      if (col.skipped) s.push(col);
      else p.push(col);
    }
    return { profiled: p, skipped: s };
  }, [stats.columns]);

  const sortedProfiled = useMemo(() => sortColumns(profiled, sort.key, sort.dir), [profiled, sort]);
  const isStandard = mode === 'standard';
  const hdrStyle: React.CSSProperties = { color: 'var(--ln-fg-muted)', cursor: 'pointer', userSelect: 'none' };

  // Determine if a column's detail is visible
  const isDetailVisible = (colName: string) => {
    if (expandedAll) return !expandedCols.has(colName); // expanded all, individual toggle collapses
    return expandedCols.has(colName); // collapsed all, individual toggle expands
  };

  return (
    <div className="text-xs" style={{ color: 'var(--ln-fg)' }}>
      {/* Summary line */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2" style={{ color: 'var(--ln-fg-muted)' }}>
        <span className="font-mono" style={{ color: 'var(--ln-fg)', fontWeight: 600, fontSize: '0.8rem' }}>
          {stats.rowCount.toLocaleString()} rows
        </span>
        <span>·</span>
        <span>{profiled.length} of {stats.columns.length} profiled</span>
        <span>·</span>
        {stats.sampled && stats.samplePercent !== undefined ? (
          <span style={{ color: 'var(--ln-warning-fg)', fontWeight: 500 }}>
            Sampled {stats.samplePercent}%
          </span>
        ) : (
          <span>Full scan</span>
        )}
        {/* Expand/Collapse All toggle — standard mode only */}
        {isStandard && (
          <>
            <span>·</span>
            <span
              style={{ color: 'var(--ln-text-link)', cursor: 'pointer', userSelect: 'none' }}
              onClick={toggleAll}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAll(); } }}
            >
              {expandedAll ? 'Collapse all' : 'Expand all'}
            </span>
          </>
        )}
      </div>

      {/* Header row */}
      <div
        className="font-medium pb-1"
        style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: '0 6px', borderBottom: '1px solid var(--ln-border)' }}
      >
        <div style={hdrStyle} onClick={() => toggleSort('name')}>
          Column{sort.key === 'name' && <SortArrow dir={sort.dir} />}
        </div>
        <div style={{ color: 'var(--ln-fg-muted)' }}>Type</div>
        <div style={{ ...hdrStyle, textAlign: 'right' }} onClick={() => toggleSort('null')}>
          Null%{sort.key === 'null' && <SortArrow dir={sort.dir} />}
        </div>
        <div style={{ ...hdrStyle, textAlign: 'right' }} onClick={() => toggleSort('distinct')}>
          Distinct{sort.key === 'distinct' && <SortArrow dir={sort.dir} />}
        </div>
      </div>

      {/* Body rows */}
      {sortedProfiled.map(col => {
        const showDetail = isStandard && hasDetail(col) && isDetailVisible(col.name);
        const canExpand = isStandard && hasDetail(col);
        return (
          <div key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
            {/* Metrics grid */}
            <div
              className="py-1"
              style={{
                display: 'grid',
                gridTemplateColumns: GRID_COLS,
                gap: '0 6px',
                alignItems: 'center',
                cursor: canExpand ? 'pointer' : 'default',
              }}
              onClick={canExpand ? () => toggleCol(col.name) : undefined}
              role={canExpand ? 'button' : undefined}
              tabIndex={canExpand ? 0 : undefined}
              onKeyDown={canExpand ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCol(col.name); } } : undefined}
            >
              <div className="font-mono flex items-center gap-1" style={{ ...cellClip, minWidth: 0 }} title={col.name}>
                {canExpand && (
                  <span style={{ flexShrink: 0, color: 'var(--ln-fg-dim)' }}>
                    <ChevronIcon expanded={showDetail} />
                  </span>
                )}
                <span style={cellClip}>{col.name}</span>
              </div>
              <div style={{ textAlign: 'center' }}><TypeBadge typeStr={col.type} /></div>
              <div className="font-mono" style={{ ...cellClip, textAlign: 'right' }}>
                {col.nullPercent === null
                  ? <span style={{ color: 'var(--ln-fg-dim)', fontSize: '0.65rem' }}>NN</span>
                  : `${col.nullPercent.toFixed(1)}%`
                }
              </div>
              <div className="font-mono" style={{ ...cellClip, textAlign: 'right' }}>
                {col.distinctCount.toLocaleString()}
                <UniquenessIndicator value={col.uniqueness} distinctCount={col.distinctCount} />
              </div>
            </div>

            {/* Detail row — standard mode, collapsible */}
            {showDetail && (
              <div style={{ paddingLeft: 14, paddingBottom: 1 }}>
                <DetailCell col={col} rowCount={stats.rowCount} />
              </div>
            )}

            {/* Completeness bar — always visible */}
            <div className="flex items-center" style={{ paddingBottom: 3 }}>
              <div style={{ flex: 1 }}>
                <CompletenessBar value={col.completeness} />
              </div>
              <span className="font-mono" style={{ width: 32, textAlign: 'right', fontSize: '0.6rem', color: 'var(--ln-fg-dim)', flexShrink: 0 }}>
                {Math.round(col.completeness * 100)}%
              </span>
            </div>
          </div>
        );
      })}

      {/* Skipped columns section */}
      {skipped.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="text-xs" style={{
            color: 'var(--ln-fg-dim)',
            borderBottom: '1px solid var(--ln-border-light)',
            paddingBottom: 2,
            marginBottom: 4,
            letterSpacing: '0.05em',
          }}>
            Not profiled ({skipped.length})
          </div>
          {skipped.map(col => (
            <div key={col.name} className="flex items-center gap-2 py-0.5" style={{ color: 'var(--ln-fg-dim)' }}>
              <span className="font-mono truncate" style={{ flex: 1, minWidth: 0 }} title={col.name}>
                {col.name}
              </span>
              <TypeBadge typeStr={col.type} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stats Section ───────────────────────────────────────────────────────────

interface StatsSectionProps {
  statsState: TableStatsState;
  onRequestStats: (mode: StatsMode) => void;
  standardModeEnabled: boolean;
}

export function StatsSection({ statsState, onRequestStats, standardModeEnabled }: StatsSectionProps) {
  const isLoading = statsState.phase === 'loading';

  return (
    <div style={{ borderTop: '1px solid var(--ln-border)', paddingTop: 10 }}>
      {/* Header: STATISTICS label + mode buttons */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold tracking-wider flex items-center gap-2"
          style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
          <span>STATISTICS</span>
          {isLoading && <Spinner />}
        </div>

        {/* Mode buttons */}
        <div className="flex gap-1">
          <Button
            variant={statsState.phase === 'result' && statsState.mode === 'quick' ? 'primary' : 'ghost'}
            className="text-xs px-2 py-0.5"
            disabled={isLoading}
            onClick={() => onRequestStats('quick')}
          >
            Quick
          </Button>
          {standardModeEnabled && (
            <Button
              variant={statsState.phase === 'result' && statsState.mode === 'standard' ? 'primary' : 'ghost'}
              className="text-xs px-2 py-0.5"
              disabled={isLoading}
              onClick={() => onRequestStats('standard')}
            >
              Standard
            </Button>
          )}
        </div>
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
  );
}
