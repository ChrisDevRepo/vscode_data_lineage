import { useEffect, useRef, useState } from 'react';
import type { LineageNode } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import type { TableStatsState } from '../components/TableDetailPanel';
import type { StatsMode } from '../engine/profilingEngine';
import { TableDetailPanel } from '../components/TableDetailPanel';
import { MonacoSqlView } from './MonacoSqlView';

/**
 * Configuration options for the detail view, typically synchronized from VS Code settings.
 */
interface DetailConfig {
  /** Whether the active session is connected to a live database. */
  isDbMode: boolean;
  /** Whether table statistics (row counts, distributions) are enabled. */
  statsEnabled: boolean;
  /** Whether to skip statistics generation for external tables. */
  excludeExternalTables: boolean;
  /** Whether standard profiling mode is enabled. */
  standardModeEnabled: boolean;
}

/**
 * Represents the complete state of the detail panel for a specific node.
 */
interface DetailState {
  /** The lineage node being inspected. */
  node: LineageNode;
  /** An optional search query used for highlighting text within DDL or column lists. */
  findQuery?: string;
  /** The current configuration for the detail view. */
  config: DetailConfig;
}

/** Default configuration used when no explicit config is provided by the extension host. */
const DEFAULT_DETAIL_CONFIG: DetailConfig = {
  isDbMode:              false,
  statsEnabled:          DEFAULT_CONFIG.tableStatistics.enabled,
  excludeExternalTables: DEFAULT_CONFIG.tableStatistics.excludeExternalTables,
  standardModeEnabled:   DEFAULT_CONFIG.tableStatistics.standardModeEnabled,
};

/** 
 * Persistent reference to the VS Code Webview API.
 * This is acquired once per webview lifecycle.
 */
const _vscodeApi = acquireVsCodeApi();

// Expose the VS Code API globally for components that cannot use hooks (e.g., class-based ErrorBoundaries).
window.vscode = _vscodeApi;

// Register global crash handlers to ensure webview errors are bubbled up to the extension's log channel.
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  _vscodeApi.postMessage({ type: 'error', error: `[Detail] Unhandled rejection: ${msg}` });
});
window.addEventListener('error', (event) => {
  _vscodeApi.postMessage({ type: 'error', error: `[Detail] Uncaught error: ${event.message}` });
});

/**
 * Root component for the Data Lineage Detail Webview.
 * 
 * This component manages the lifecycle of the detail panel, including:
 * - IPC communication with the VS Code extension host.
 * - Switching between DDL (Monaco) and Column (Table) views.
 * - Managing table statistics (profiling) state.
 * - Synchronizing theme changes with VS Code.
 * 
 * @returns The rendered detail panel or a placeholder message if no node is selected.
 */
export function DetailApp() {
  const vscodeApi  = useRef(_vscodeApi);
  const nodeIdRef  = useRef<string | undefined>(undefined);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [statsState, setStatsState] = useState<TableStatsState>({ phase: 'idle' });
  const [detailMode, setDetailMode] = useState<'columns' | 'ddl'>('ddl');

  // Keep ref in sync so the stable message handler can read the current node id.
  nodeIdRef.current = detail?.node?.id;

  useEffect(() => {
    /** 
     * Handles incoming messages from the VS Code extension host.
     */
    function handler(e: MessageEvent) {
      const msg = e.data;
      if (!msg?.type) return;

      if (msg.type === 'detail-update') {
        // Reset statistics state if we've switched to a different node.
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
    // Signal to the host that the detail view is ready to receive data.
    vscodeApi.current.postMessage({ type: 'detail-ready' });
    return () => window.removeEventListener('message', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset toggle to DDL view when switching to a different node.
  useEffect(() => { setDetailMode('ddl'); }, [detail?.node?.id]);

  if (!detail) {
    return (
      <div
        style={{
          padding: 20,
          color: 'var(--ln-fg)',
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

  /** 
   * Dispatches a request to the host to profile the current table/view.
   */
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

  /** 
   * Signals the host to close the detail panel.
   */
  function handleClose() {
    vscodeApi.current.postMessage({ type: 'close-detail' });
  }

  // Render for Tables/External Tables (Columns only, no DDL toggle).
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

  // Render for Views/Functions that have both DDL and Column metadata.
  if (hasColumnsAndDdl) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="ln-detail-tab-bar">
          <button
            onClick={() => setDetailMode('ddl')}
            className={`ln-detail-tab-button${detailMode === 'ddl' ? ' active' : ''}`}
          >DDL</button>
          <button
            onClick={() => setDetailMode('columns')}
            className={`ln-detail-tab-button${detailMode === 'columns' ? ' active' : ''}`}
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

  // Render for Stored Procedures and simple functions (DDL only).
  return <MonacoSqlView node={node} findQuery={findQuery} />;
}
