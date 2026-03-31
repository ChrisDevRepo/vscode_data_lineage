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

// ─── VS Code API — acquired once at module load, never inside the component ───
// acquireVsCodeApi() throws if called more than once per webview session.
// Calling it inside useRef(acquireVsCodeApi()) evaluates the arg on every render.
const _vscodeApi = acquireVsCodeApi();
// Make available to ErrorBoundary (class component, can't use context)
window.vscode = _vscodeApi;

// Global error handlers — mirror main webview (index.tsx) so nothing is silent
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  console.error('[Detail] Unhandled rejection:', msg);
  _vscodeApi.postMessage({ type: 'error', error: `[Detail] Unhandled rejection: ${msg}` });
});
window.addEventListener('error', (event) => {
  console.error('[Detail] Uncaught error:', event.message);
  _vscodeApi.postMessage({ type: 'error', error: `[Detail] Uncaught error: ${event.message}` });
});

// ─── Root ─────────────────────────────────────────────────────────────────────

export function DetailApp() {
  const vscodeApi  = useRef(_vscodeApi);
  const nodeIdRef  = useRef<string | undefined>(undefined);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [statsState, setStatsState] = useState<TableStatsState>({ phase: 'idle' });
  const [detailMode, setDetailMode] = useState<'columns' | 'ddl'>('ddl');

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
    // Register listener BEFORE sending detail-ready — the extension's detail-update
    // response is async (IPC round-trip), but must find the listener already attached.
    window.addEventListener('message', handler);
    vscodeApi.current.postMessage({ type: 'detail-ready' });
    return () => window.removeEventListener('message', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset toggle to DDL view when switching to a different node
  useEffect(() => { setDetailMode('ddl'); }, [detail?.node?.id]);

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
  const hasColumnsAndDdl = !!(node.columns?.length && node.bodyScript);

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

  // Tables/externals: always show columns (no DDL toggle)
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

  // Views/TVFs with both columns and DDL: show toggle bar
  if (hasColumnsAndDdl) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{
          display: 'flex', gap: 4, padding: '6px 10px',
          borderBottom: '1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444))',
          background: 'var(--vscode-editor-background)',
        }}>
          <button
            onClick={() => setDetailMode('ddl')}
            style={{
              padding: '3px 10px', fontSize: 12, cursor: 'pointer', border: 'none', borderRadius: 3,
              background: detailMode === 'ddl' ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
              color: detailMode === 'ddl' ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
            }}
          >DDL</button>
          <button
            onClick={() => setDetailMode('columns')}
            style={{
              padding: '3px 10px', fontSize: 12, cursor: 'pointer', border: 'none', borderRadius: 3,
              background: detailMode === 'columns' ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
              color: detailMode === 'columns' ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
            }}
          >Columns</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {detailMode === 'columns' ? (
            <TableDetailPanel
              schema={node.schema}
              objectName={node.name}
              objectType={node.type as 'view' | 'function'}
              columns={node.columns ?? []}
              fks={[]}
              statsState={{ phase: 'idle' }}
              onClose={handleClose}
              onRequestStats={() => {}}
              isDbMode={false}
              statsEnabled={false}
              excludeExternalTables={false}
              standardModeEnabled={false}
              fillContainer
              findQuery={findQuery}
              compactColumns
            />
          ) : (
            <MonacoSqlView node={node} findQuery={findQuery} />
          )}
        </div>
      </div>
    );
  }

  // Procedures, scalar functions: DDL only
  return <MonacoSqlView node={node} findQuery={findQuery} />;
}
