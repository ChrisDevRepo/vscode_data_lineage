import { useEffect, useRef, useState } from 'react';
import type { LineageNode } from '../engine/types';
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

// ─── Root ─────────────────────────────────────────────────────────────────────

export function DetailApp() {
  const vscodeApi = useRef(acquireVsCodeApi());
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [statsState, setStatsState] = useState<TableStatsState>({ phase: 'idle' });

  // Sync VS Code theme kind onto <body> for CSS variables
  useEffect(() => {
    const kind = (window as unknown as { __THEME_KIND__?: number }).__THEME_KIND__;
    if (kind !== undefined) {
      document.body.setAttribute('data-vscode-theme-kind', String(kind));
    }
  }, []);

  useEffect(() => {
    function handler(e: MessageEvent) {
      const msg = e.data;
      if (!msg?.type) return;

      if (msg.type === 'detail-update') {
        // Reset stats when node changes
        setStatsState(prev => {
          const prev_node = detail?.node;
          if (prev_node?.id !== msg.node?.id) return { phase: 'idle' };
          return prev;
        });
        setDetail({
          node: msg.node,
          findQuery: msg.findQuery,
          config: msg.config ?? {
            isDbMode: false,
            statsEnabled: false,
            excludeExternalTables: true,
            standardModeEnabled: false,
          },
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
  });

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
