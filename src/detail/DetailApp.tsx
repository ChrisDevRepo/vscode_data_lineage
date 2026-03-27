import { useEffect, useRef, useState } from 'react';
import type { LineageNode } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import type { TableStatsState } from '../components/TableDetailPanel';
import type { StatsMode } from '../engine/profilingEngine';
import { TableDetailPanel } from '../components/TableDetailPanel';
import { MonacoSqlView } from './MonacoSqlView';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DetailConfig {
  isDbMode: boolean;
  statsEnabled: boolean;
  excludeExternalTables: boolean;
  standardModeEnabled: boolean;
}

interface DetailState {
  node: LineageNode;
  findQuery?: string;
  config: DetailConfig;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DETAIL_CONFIG: DetailConfig = {
  isDbMode:              false,
  statsEnabled:          DEFAULT_CONFIG.tableStatistics.enabled,
  excludeExternalTables: DEFAULT_CONFIG.tableStatistics.excludeExternalTables,
  standardModeEnabled:   DEFAULT_CONFIG.tableStatistics.standardModeEnabled,
};

// ─── Root ─────────────────────────────────────────────────────────────────────

export function DetailApp() {
  const vscodeApi  = useRef(acquireVsCodeApi());
  const nodeIdRef  = useRef<string | undefined>(undefined);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [statsState, setStatsState] = useState<TableStatsState>({ phase: 'idle' });

  // Keep ref in sync so the stable message handler can read the current node id.
  nodeIdRef.current = detail?.node?.id;

  // Note: data-vscode-theme-kind is already set as CSS string by getDetailWebviewHtml.
  // themeChanged messages from the extension update it via the message handler below.

  useEffect(() => {
    function handler(e: MessageEvent) {
      const msg = e.data;
      if (!msg?.type) return;

      if (msg.type === 'detail-update') {
        setStatsState(prev => nodeIdRef.current !== msg.node?.id ? { phase: 'idle' } : prev);
        setDetail({
          node:      msg.node,
          findQuery: msg.findQuery,
          config:    msg.config ?? DEFAULT_DETAIL_CONFIG,
        });
      } else if (msg.type === 'table-stats-result') {
        setStatsState({ phase: 'result', stats: msg.stats, mode: msg.mode });
      } else if (msg.type === 'table-stats-error') {
        setStatsState({ phase: 'error', message: msg.message });
      } else if (msg.type === 'themeChanged') {
        document.body.setAttribute('data-vscode-theme-kind', String(msg.kind));
      }
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (!detail) {
    return (
      <div
        style={{
          padding: 20,
          color: 'var(--vscode-foreground)',
          fontSize: 13,
        }}
      >
        Select a node in the graph to view details.
      </div>
    );
  }

  const { node, findQuery, config } = detail;
  const isTable = node.type === 'table' || node.type === 'external';

  function handleRequestStats(mode: StatsMode) {
    vscodeApi.current.postMessage({
      type: 'table-stats-request',
      schema: node.schema,
      objectName: node.name,
      mode,
      columns: node.columns ?? [],
    });
    setStatsState({ phase: 'loading', mode });
  }

  function handleClose() {
    vscodeApi.current.postMessage({ type: 'close-detail' });
  }

  if (isTable) {
    return (
      <TableDetailPanel
        schema={node.schema}
        objectName={node.name}
        objectType={node.type as 'table' | 'external'}
        externalType={node.externalType}
        columns={node.columns ?? []}
        fks={node.fks ?? []}
        statsState={statsState}
        onClose={handleClose}
        onRequestStats={handleRequestStats}
        isDbMode={config.isDbMode}
        statsEnabled={config.statsEnabled}
        excludeExternalTables={config.excludeExternalTables}
        standardModeEnabled={config.standardModeEnabled}
        fillContainer
        findQuery={findQuery}
      />
    );
  }

  return <MonacoSqlView node={node} findQuery={findQuery} />;
}
