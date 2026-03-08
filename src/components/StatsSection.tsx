import { useState, useCallback, useEffect } from 'react';
import type { TableStats, StatsMode, TopValue } from '../engine/profilingEngine';
import type { TableStatsState } from './TableDetailPanel';
import { Button } from './ui/Button';
import { CompletenessBar, UniquenessIndicator, TopNChart } from './StatsMicroCharts';
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

// ─── Expanded Column Detail ──────────────────────────────────────────────────

interface ExpandedDetailProps {
  col: TableStats['columns'][0];
  schema: string;
  objectName: string;
  rowCount: number;
  topValues?: TopValue[];
  topNLoading?: boolean;
  onLoadTopN: () => void;
}

function ExpandedDetail({ col, rowCount, topValues, topNLoading, onLoadTopN }: ExpandedDetailProps) {
  return (
    <div className="text-xs" style={{ padding: '4px 0 4px 16px', color: 'var(--ln-fg-muted)' }}>
      {/* Completeness bar */}
      <div className="flex items-center gap-2 mb-1">
        <span style={{ width: 70 }}>Complete</span>
        <div style={{ flex: 1 }}><CompletenessBar value={col.completeness} /></div>
        <span className="font-mono" style={{ width: 36, textAlign: 'right' }}>{Math.round(col.completeness * 100)}%</span>
      </div>

      {/* Uniqueness */}
      <div className="flex items-center gap-2 mb-1">
        <span style={{ width: 70 }}>Unique</span>
        <span className="font-mono">{(col.uniqueness * 100).toFixed(1)}%</span>
        <UniquenessIndicator value={col.uniqueness} distinctCount={col.distinctCount} />
      </div>

      {/* Mean / StdDev (numeric) */}
      {col.mean !== undefined && (
        <div className="flex items-center gap-2 mb-1">
          <span style={{ width: 70 }}>Mean</span>
          <span className="font-mono">{col.mean.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          {col.stdDev !== undefined && (
            <span className="font-mono" style={{ color: 'var(--ln-fg-dim)' }}>
              ± {col.stdDev.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
      )}

      {/* Min / Max */}
      {col.min !== undefined && (
        <div className="flex items-center gap-2 mb-1">
          <span style={{ width: 70 }}>Range</span>
          <span className="font-mono">{col.min} … {col.max}</span>
        </div>
      )}

      {/* String length */}
      {col.minLength !== undefined && (
        <div className="flex items-center gap-2 mb-1">
          <span style={{ width: 70 }}>Length</span>
          <span className="font-mono">{col.minLength} – {col.maxLength}</span>
        </div>
      )}

      {/* Zero count (nullable numeric) */}
      {col.zeroCount !== undefined && (
        <div className="flex items-center gap-2 mb-1">
          <span style={{ width: 70 }}>Zeros</span>
          <span className="font-mono">{col.zeroCount.toLocaleString()}</span>
          {rowCount > 0 && <span className="font-mono" style={{ color: 'var(--ln-fg-dim)' }}>({((col.zeroCount / rowCount) * 100).toFixed(1)}%)</span>}
        </div>
      )}

      {/* Empty string count */}
      {col.emptyCount !== undefined && (
        <div className="flex items-center gap-2 mb-1">
          <span style={{ width: 70 }}>Empty</span>
          <span className="font-mono">{col.emptyCount.toLocaleString()}</span>
          {rowCount > 0 && <span className="font-mono" style={{ color: 'var(--ln-fg-dim)' }}>({((col.emptyCount / rowCount) * 100).toFixed(1)}%)</span>}
        </div>
      )}

      {/* Top-N values */}
      {topValues ? (
        <div className="mt-1">
          <div className="mb-1" style={{ color: 'var(--ln-fg-dim)' }}>Top values</div>
          <TopNChart values={topValues} />
        </div>
      ) : (
        <div className="mt-1">
          <Button
            variant="ghost"
            className="text-xs px-2 py-0.5"
            onClick={onLoadTopN}
            disabled={topNLoading}
          >
            {topNLoading ? 'Loading…' : 'Load Top-5'}
          </Button>
        </div>
      )}
    </div>
  );
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

  const toggleExpand = useCallback((colName: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(colName)) next.delete(colName);
      else next.add(colName);
      return next;
    });
  }, []);

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
            <th className="text-left pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)', width: '6%' }}></th>
            <th className="text-left pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)', width: '34%' }}>Column</th>
            <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Distinct</th>
            <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Null%</th>
            {mode === 'standard' && (
              <th className="text-right pb-1 font-medium" style={{ color: 'var(--ln-fg-muted)' }}>Range</th>
            )}
          </tr>
        </thead>
        <tbody>
          {stats.columns.map(col => {
            const isExpanded = expanded.has(col.name);
            const canExpand = !col.skipped;
            return (
              <tr key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
                <td colSpan={mode === 'standard' ? 5 : 4} style={{ padding: 0 }}>
                  {/* Main row */}
                  <div
                    className="flex items-center"
                    style={{ cursor: canExpand ? 'pointer' : 'default' }}
                    onClick={() => canExpand && toggleExpand(col.name)}
                    role={canExpand ? 'button' : undefined}
                    aria-expanded={canExpand ? isExpanded : undefined}
                    tabIndex={canExpand ? 0 : undefined}
                    onKeyDown={canExpand ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(col.name); } } : undefined}
                  >
                    {/* Chevron */}
                    <div className="py-0.5" style={{ width: '6%', color: 'var(--ln-fg-dim)', visibility: canExpand ? 'visible' : 'hidden' }}>
                      <ChevronIcon expanded={isExpanded} />
                    </div>

                    {/* Column name + completeness bar */}
                    <div className="py-0.5 pr-1" style={{ width: '34%', minWidth: 0 }}>
                      <div className="truncate font-mono" style={{ color: col.skipped ? 'var(--ln-fg-dim)' : 'var(--ln-fg)' }} title={col.name}>
                        {col.name}
                      </div>
                      {!col.skipped && <CompletenessBar value={col.completeness} />}
                    </div>

                    {/* Distinct + uniqueness */}
                    <div className="py-0.5 text-right font-mono" style={{ flex: 1, color: 'var(--ln-fg)' }}>
                      {col.skipped ? <span style={{ color: 'var(--ln-fg-dim)' }}>—</span> : (
                        <>
                          {col.distinctCount.toLocaleString()}
                          <UniquenessIndicator value={col.uniqueness} distinctCount={col.distinctCount} />
                        </>
                      )}
                    </div>

                    {/* Null% */}
                    <div className="py-0.5 text-right font-mono" style={{ flex: 1, color: 'var(--ln-fg)' }}>
                      {col.skipped
                        ? <span style={{ color: 'var(--ln-fg-dim)' }}>—</span>
                        : col.nullPercent === null
                          ? <span style={{ color: 'var(--ln-fg-dim)' }}>NOT NULL</span>
                          : `${col.nullPercent.toFixed(1)}%`
                      }
                    </div>

                    {/* Range (standard mode) */}
                    {mode === 'standard' && (
                      <div className="py-0.5 text-right font-mono text-xs" style={{ flex: 1, color: 'var(--ln-fg-muted)' }}>
                        {col.skipped ? <span style={{ color: 'var(--ln-fg-dim)' }}>—</span>
                          : col.min !== undefined ? `${col.min} … ${col.max}`
                          : col.minLength !== undefined ? `${col.minLength}–${col.maxLength} len`
                          : '—'
                        }
                      </div>
                    )}
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && !col.skipped && (
                    <ExpandedDetail
                      col={col}
                      schema={schema}
                      objectName={objectName}
                      rowCount={stats.rowCount}
                      topValues={topNData[col.name]}
                      topNLoading={topNLoading.has(col.name)}
                      onLoadTopN={() => onLoadTopN(col.name)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
      <div className="text-xs font-semibold tracking-wider mb-2 flex items-center justify-between"
        style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
        <span>STATISTICS</span>
        {isLoading && <Spinner />}
      </div>

      {/* Mode buttons */}
      <div className="flex gap-1.5 mb-3">
        <Button
          variant={statsState.phase === 'result' && statsState.mode === 'quick' ? 'primary' : 'ghost'}
          className="text-xs px-2.5 py-1"
          disabled={isLoading}
          onClick={() => onRequestStats('quick')}
        >
          Quick
        </Button>
        {standardModeEnabled && (
          <Button
            variant={statsState.phase === 'result' && statsState.mode === 'standard' ? 'primary' : 'ghost'}
            className="text-xs px-2.5 py-1"
            disabled={isLoading}
            onClick={() => onRequestStats('standard')}
          >
            Standard
          </Button>
        )}
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
