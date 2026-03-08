import { Fragment, useState, useCallback, useMemo } from 'react';
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

// ─── Formatting Helpers ─────────────────────────────────────────────────────

/** Format a number with thousands separators and 1 decimal place. */
function formatDecimal(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Format a raw min/max string — if numeric, add thousands separators. */
function formatValue(raw: string | undefined): string {
  if (!raw) return '–';
  const n = Number(raw);
  if (!isNaN(n)) return formatDecimal(n);
  return raw;
}

/** Format a count with percentage of total rows. */
function formatCount(count: number, rowCount: number): string {
  const formatted = count.toLocaleString();
  if (rowCount > 0) return `${formatted} (${((count / rowCount) * 100).toFixed(1)}%)`;
  return formatted;
}

/** Color for Null% text — only highlight problematic values. */
function nullQualityColor(pct: number): string {
  if (pct > 20) return 'var(--ln-validation-error-border)';
  if (pct >= 5) return 'var(--ln-warning-fg)';
  return 'var(--ln-fg)';
}

// ─── Labeled Detail Grid (Standard mode) ────────────────────────────────────

/** Check whether a column has any standard-mode detail to show. */
function hasDetail(col: ColumnStats): boolean {
  return col.min !== undefined || col.minLength !== undefined;
}

/**
 * Labeled key-value grid for expanded column detail.
 * Every metric has a plain English label — no abbreviations.
 */
function DetailGrid({ col, rowCount }: { col: ColumnStats; rowCount: number }) {
  const pairs: Array<{ label: string; value: string }> = [];

  if (col.min !== undefined && col.mean !== undefined) {
    // Numeric: Range, Mean, Std Dev, Zeros
    pairs.push({ label: 'Range', value: `${formatValue(col.min)} – ${formatValue(col.max)}` });
    pairs.push({ label: 'Mean', value: formatDecimal(col.mean) });
    if (col.stdDev !== undefined) pairs.push({ label: 'Std Dev', value: formatDecimal(col.stdDev) });
    if (col.zeroCount !== undefined && col.zeroCount > 0) {
      pairs.push({ label: 'Zeros', value: formatCount(col.zeroCount, rowCount) });
    }
  } else if (col.min !== undefined) {
    // DateTime: Earliest, Latest
    pairs.push({ label: 'Earliest', value: col.min });
    pairs.push({ label: 'Latest', value: col.max ?? '' });
  }

  if (col.minLength !== undefined) {
    // String: Length, Empty
    const lenVal = col.minLength === col.maxLength
      ? `${col.minLength}` : `${col.minLength} – ${col.maxLength}`;
    pairs.push({ label: 'Length', value: lenVal });
    if (col.emptyCount !== undefined && col.emptyCount > 0) {
      pairs.push({ label: 'Empty', value: formatCount(col.emptyCount, rowCount) });
    }
  }

  if (pairs.length === 0) return null;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: pairs.length <= 1 ? 'auto 1fr' : 'auto 1fr auto 1fr',
      gap: '1px 10px',
      padding: '2px 0 4px 14px',
    }}>
      {pairs.map((p, i) => (
        <Fragment key={i}>
          <span className="text-xs"
            style={{ color: 'var(--ln-fg-dim)', whiteSpace: 'nowrap' }}>
            {p.label}
          </span>
          <span className="font-mono text-xs" style={{
            color: 'var(--ln-fg)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={p.value}>
            {p.value}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

// ─── Sort Logic ──────────────────────────────────────────────────────────────

type SortKey = 'ordinal' | 'name' | 'null' | 'distinct';

/** Attach original index so we can restore ordinal sort. */
type IndexedCol = ColumnStats & { _idx: number };

function sortColumns(cols: IndexedCol[], key: SortKey, dir: 'asc' | 'desc'): IndexedCol[] {
  if (key === 'ordinal') return dir === 'asc' ? cols : [...cols].reverse();
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
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'ordinal', dir: 'asc' });
  const [expandedAll, setExpandedAll] = useState(false);
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set());

  const toggleSort = useCallback((key: SortKey) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: (key === 'name' || key === 'ordinal') ? 'asc' : 'desc' }
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
      if (!prev) setExpandedCols(new Set());
      return !prev;
    });
  }, []);

  const { profiled, skipped } = useMemo(() => {
    const p: IndexedCol[] = [];
    const s: ColumnStats[] = [];
    stats.columns.forEach((col, i) => {
      if (col.skipped) s.push(col);
      else p.push({ ...col, _idx: i });
    });
    return { profiled: p, skipped: s };
  }, [stats.columns]);

  const sortedProfiled = useMemo(() => sortColumns(profiled, sort.key, sort.dir), [profiled, sort]);
  const isStandard = mode === 'standard';
  const hdrStyle: React.CSSProperties = { color: 'var(--ln-fg-muted)', cursor: 'pointer', userSelect: 'none' };

  const isDetailVisible = (colName: string) => {
    if (expandedAll) return !expandedCols.has(colName);
    return expandedCols.has(colName);
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
        <div style={hdrStyle} onClick={() => {
          if (sort.key === 'ordinal') toggleSort('name');
          else if (sort.key === 'name') toggleSort('ordinal');
          else toggleSort('ordinal');
        }}>
          Column{sort.key === 'name' && <SortArrow dir={sort.dir} />}
          {sort.key === 'ordinal' && <span style={{ fontSize: '0.55rem', marginLeft: 2, opacity: 0.7 }}>#</span>}
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
              <div className="font-mono" style={{
                ...cellClip,
                textAlign: 'right',
                color: col.nullPercent !== null ? nullQualityColor(col.nullPercent) : 'var(--ln-fg-dim)',
                fontSize: col.nullPercent === null ? '0.65rem' : undefined,
              }}>
                {col.nullPercent === null ? 'NN' : `${col.nullPercent.toFixed(1)}%`}
              </div>
              <div className="font-mono" style={{ ...cellClip, textAlign: 'right' }}>
                {col.distinctCount.toLocaleString()}
                <UniquenessIndicator value={col.uniqueness} distinctCount={col.distinctCount} />
              </div>
            </div>

            {/* Detail — labeled key-value grid (standard mode, collapsible) */}
            {showDetail && <DetailGrid col={col} rowCount={stats.rowCount} />}

            {/* Completeness bar */}
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

      {/* Skipped columns */}
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
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold tracking-wider flex items-center gap-2"
          style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
          <span>STATISTICS</span>
          {isLoading && <Spinner />}
        </div>
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
