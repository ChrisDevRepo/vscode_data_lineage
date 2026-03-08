import { useState, useCallback, useEffect, useMemo } from 'react';
import type { TableStats, ColumnStats, StatsMode, TopValue } from '../engine/profilingEngine';
import type { TableStatsState } from './TableDetailPanel';
import { Button } from './ui/Button';
import { CompletenessBar, UniquenessIndicator, TopNChart, TypeBadge } from './StatsMicroCharts';
import { useVsCode } from '../contexts/VsCodeContext';

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

// ─── Chevron Icon ─────────────────────────────────────────────────────────────

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <path d="M3 1L7 5L3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Sort Arrow ──────────────────────────────────────────────────────────────

function SortArrow({ dir }: { dir: 'asc' | 'desc' }) {
  return <span style={{ fontSize: '0.6rem', marginLeft: 2 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
}

// ─── Type-Adaptive Detail ────────────────────────────────────────────────────

function DetailCell({ col, rowCount }: { col: ColumnStats; rowCount: number }) {
  const parts: string[] = [];

  // Numeric: min … max  μ mean σ stddev
  if (col.min !== undefined && col.mean !== undefined) {
    parts.push(`${col.min} … ${col.max}`);
    const fmtMean = compactNumber(col.mean);
    parts.push(`μ${fmtMean}`);
    if (col.stdDev !== undefined) parts.push(`σ${compactNumber(col.stdDev)}`);
    if (col.zeroCount !== undefined && col.zeroCount > 0) {
      parts.push(`${col.zeroCount.toLocaleString()} zeros`);
    }
  }
  // DateTime: min … max (no mean/stddev)
  else if (col.min !== undefined) {
    parts.push(`${col.min} … ${col.max}`);
  }

  // String: length range + empty count
  if (col.minLength !== undefined) {
    const lenStr = col.minLength === col.maxLength ? `len ${col.minLength}` : `len ${col.minLength}–${col.maxLength}`;
    parts.push(lenStr);
    if (col.emptyCount !== undefined && col.emptyCount > 0) {
      const pct = rowCount > 0 ? ` (${((col.emptyCount / rowCount) * 100).toFixed(1)}%)` : '';
      parts.push(`${col.emptyCount.toLocaleString()} empty${pct}`);
    }
  }

  if (parts.length === 0) return null;

  return (
    <span className="font-mono" style={{ color: 'var(--ln-fg-muted)', whiteSpace: 'nowrap' }}>
      {parts.join('  ')}
    </span>
  );
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

// ─── Stats Results Table ─────────────────────────────────────────────────────

function StatsResults({ stats, mode, schema, objectName, topNData, topNLoading, onLoadTopN }: {
  stats: TableStats;
  mode: StatsMode;
  schema: string;
  objectName: string;
  topNData: Record<string, TopValue[]>;
  topNLoading: Set<string>;
  onLoadTopN: (colName: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });

  const toggleExpand = useCallback((colName: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(colName)) next.delete(colName);
      else next.add(colName);
      return next;
    });
  }, []);

  const toggleSort = useCallback((key: SortKey) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' }
    );
  }, []);

  // Partition: profiled vs skipped
  const { profiled, skipped } = useMemo(() => {
    const p: ColumnStats[] = [];
    const s: ColumnStats[] = [];
    for (const col of stats.columns) {
      if (col.skipped) s.push(col);
      else p.push(col);
    }
    return { profiled: p, skipped: s };
  }, [stats.columns]);

  // Sort profiled columns
  const sortedProfiled = useMemo(() => sortColumns(profiled, sort.key, sort.dir), [profiled, sort]);

  const isStandard = mode === 'standard';

  // Header cell style helper
  const hdr = (clickKey: SortKey): React.CSSProperties => ({
    color: 'var(--ln-fg-muted)',
    cursor: 'pointer',
    userSelect: 'none',
  });

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
      </div>

      {/* Column grid */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
            <th className="text-left pb-1 font-medium" style={{ width: 14 }}></th>
            <th className="text-left pb-1 font-medium" style={hdr('name')} onClick={() => toggleSort('name')}>
              Column{sort.key === 'name' && <SortArrow dir={sort.dir} />}
            </th>
            <th className="text-left pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)', width: 38 }}>Type</th>
            <th className="text-right pb-1 font-medium" style={{ ...hdr('null'), width: 52 }} onClick={() => toggleSort('null')}>
              Null%{sort.key === 'null' && <SortArrow dir={sort.dir} />}
            </th>
            <th className="text-right pb-1 font-medium" style={{ ...hdr('distinct'), width: 90 }} onClick={() => toggleSort('distinct')}>
              Distinct{sort.key === 'distinct' && <SortArrow dir={sort.dir} />}
            </th>
            {isStandard && (
              <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Detail</th>
            )}
          </tr>
        </thead>
        <tbody>
          {sortedProfiled.map(col => {
            const isExpanded = expanded.has(col.name);
            return (
              <tr key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
                <td colSpan={isStandard ? 6 : 5} style={{ padding: 0 }}>
                  {/* Row 1: metrics */}
                  <div
                    className="flex items-center"
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleExpand(col.name)}
                    role="button"
                    aria-expanded={isExpanded}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(col.name); } }}
                  >
                    {/* Chevron */}
                    <div className="py-1" style={{ width: 14, flexShrink: 0, color: 'var(--ln-fg-dim)' }}>
                      <ChevronIcon expanded={isExpanded} />
                    </div>

                    {/* Column name */}
                    <div className="py-1 pr-1 truncate font-mono" style={{ flex: '1 1 30%', minWidth: 0 }} title={col.name}>
                      {col.name}
                    </div>

                    {/* Type badge */}
                    <div className="py-1" style={{ width: 38, flexShrink: 0, textAlign: 'center' }}>
                      <TypeBadge typeStr={col.type} />
                    </div>

                    {/* Null% */}
                    <div className="py-1 text-right font-mono" style={{ width: 52, flexShrink: 0 }}>
                      {col.nullPercent === null
                        ? <span style={{ color: 'var(--ln-fg-dim)', fontSize: '0.65rem' }}>NN</span>
                        : `${col.nullPercent.toFixed(1)}%`
                      }
                    </div>

                    {/* Distinct + uniqueness */}
                    <div className="py-1 text-right font-mono" style={{ width: 90, flexShrink: 0 }}>
                      {col.distinctCount.toLocaleString()}
                      <UniquenessIndicator value={col.uniqueness} distinctCount={col.distinctCount} />
                    </div>

                    {/* Detail (standard only) */}
                    {isStandard && (
                      <div className="py-1 text-right" style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <DetailCell col={col} rowCount={stats.rowCount} />
                      </div>
                    )}
                  </div>

                  {/* Row 2: completeness bar */}
                  <div className="flex items-center" style={{ paddingLeft: 14, paddingRight: 0, paddingBottom: 3 }}>
                    <div style={{ flex: 1 }}>
                      <CompletenessBar value={col.completeness} />
                    </div>
                    <span className="font-mono" style={{ width: 36, textAlign: 'right', fontSize: '0.6rem', color: 'var(--ln-fg-dim)' }}>
                      {Math.round(col.completeness * 100)}%
                    </span>
                  </div>

                  {/* Expanded: Top-5 only */}
                  {isExpanded && (
                    <div className="text-xs" style={{ padding: '2px 0 4px 14px', color: 'var(--ln-fg-muted)' }}>
                      {topNData[col.name] ? (
                        <div>
                          <div className="mb-1" style={{ color: 'var(--ln-fg-dim)' }}>Top values</div>
                          <TopNChart values={topNData[col.name]} />
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          className="text-xs px-2 py-0.5"
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onLoadTopN(col.name); }}
                          disabled={topNLoading.has(col.name)}
                        >
                          {topNLoading.has(col.name) ? 'Loading…' : 'Load Top-5'}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

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
  schema: string;
  objectName: string;
  standardModeEnabled: boolean;
}

export function StatsSection({ statsState, onRequestStats, schema, objectName, standardModeEnabled }: StatsSectionProps) {
  const vscodeApi = useVsCode();
  const isLoading = statsState.phase === 'loading';

  const [topNData, setTopNData] = useState<Record<string, TopValue[]>>({});
  const [topNLoading, setTopNLoading] = useState<Set<string>>(new Set());

  const handleLoadTopN = useCallback((colName: string) => {
    const rowCount = statsState.phase === 'result' ? statsState.stats.rowCount : 0;
    setTopNLoading(prev => new Set(prev).add(colName));
    vscodeApi.postMessage({
      type: 'table-stats-topn-request',
      schema,
      objectName,
      columnName: colName,
      rowCount,
    });
  }, [vscodeApi, schema, objectName, statsState]);

  // Listen for Top-N results
  const handleTopNMessage = useCallback((event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === 'table-stats-topn-result') {
      setTopNData(prev => ({ ...prev, [msg.columnName]: msg.values }));
      setTopNLoading(prev => { const next = new Set(prev); next.delete(msg.columnName); return next; });
    } else if (msg.type === 'table-stats-topn-error') {
      setTopNLoading(prev => { const next = new Set(prev); next.delete(msg.columnName); return next; });
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleTopNMessage);
    return () => window.removeEventListener('message', handleTopNMessage);
  }, [handleTopNMessage]);

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
        <StatsResults
          stats={statsState.stats}
          mode={statsState.mode}
          schema={schema}
          objectName={objectName}
          topNData={topNData}
          topNLoading={topNLoading}
          onLoadTopN={handleLoadTopN}
        />
      )}
    </div>
  );
}
