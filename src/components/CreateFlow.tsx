import { memo, useState, useCallback } from 'react';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { WizardPanel } from './ui/WizardPanel';
import { StatusMessage } from './ui/StatusMessage';
import { SchemaSelector } from './SchemaSelector';
import type { DacpacLoaderState } from '../hooks/useDacpacLoader';
import type { DacpacConnection, DatabaseConnection, StoredConnectionInfo } from '../engine/projectStore';
import { generateProjectName } from '../engine/projectStore';

/**
 * Props for the `CreateFlow` component.
 */
interface CreateFlowProps {
  /** The state object from the `useDacpacLoader` hook, managing the connection lifecycle. */
  loader: DacpacLoaderState;
  /** The global maximum node limit, used for displaying warnings in the schema selector. */
  maxNodes: number;
  /** Callback triggered to return to the previous screen (StartScreen). */
  onBack: () => void;
  /** 
   * Callback triggered to finalize project creation and start the visualization.
   * @param projectName - The user-defined or auto-generated name for the project.
   * @param connection - The connection metadata (Dacpac or Database).
   */
  onVisualize: (projectName: string, connection: DacpacConnection | DatabaseConnection | null) => void;
}

/**
 * A wizard-style component that guides the user through creating a new lineage visualization.
 * 
 * @remarks
 * The flow consists of two logical phases:
 * 1. **Source Selection**: The user chooses between opening a .dacpac file or connecting to a live database.
 * 2. **Configuration**: Once a source is partially loaded (Phase 1), the user can:
 *    - Define a project name (auto-generated if left blank).
 *    - Select specific schemas to include in the visualization.
 *    - View warnings if the selected scope exceeds the recommended node limit.
 * 
 * @param props - The component props.
 */
export const CreateFlow = memo(function CreateFlow({
  loader,
  maxNodes,
  onBack,
  onVisualize,
}: CreateFlowProps) {
  const [projectName, setProjectName] = useState('');

  // Auto-fill project name when schema preview arrives (Phase 1 done)
  const schemaOrModel = loader.schemaPreview ?? loader.model;
  const hasSource = !!schemaOrModel;
  const isPhase1Loading = loader.isLoading && !loader.schemaPreview && !loader.model;

  /**
   * Generates a default project name based on the current connection metadata.
   */
  const autoName = useCallback(() => {
    if (!loader.fileName) return '';
    if (loader.filePath) {
      const conn: DacpacConnection = {
        type: 'dacpac',
        path: loader.filePath,
        displayName: loader.fileName,
        schemas: Array.from(loader.selectedSchemas),
      };
      return generateProjectName(conn);
    }
    // DB path: sourceName = fileName; connectionInfo unused by generateProjectName
    const conn: DatabaseConnection = {
      type: 'database',
      connectionInfo: {} as StoredConnectionInfo,
      sourceName: loader.fileName,
      schemas: Array.from(loader.selectedSchemas),
    };
    return generateProjectName(conn);
  }, [loader.fileName, loader.filePath, loader.selectedSchemas]);

  // Fill name when source becomes available
  const displayName = projectName || autoName();

  /**
   * Handles the final 'Visualize' action.
   */
  const handleVisualize = useCallback(() => {
    const name = displayName.trim() || autoName().trim() || loader.fileName || 'Project';
    if (loader.filePath) {
      const conn: DacpacConnection = {
        type: 'dacpac',
        path: loader.filePath,
        displayName: loader.fileName ?? '',
        schemas: Array.from(loader.selectedSchemas),
      };
      onVisualize(name, conn);
    } else {
      // DB path — extension will build the real connection after Phase 2 completes
      onVisualize(name, null);
    }
  }, [displayName, autoName, loader.filePath, loader.fileName, loader.selectedSchemas, onVisualize]);

  const canVisualize = hasSource && loader.selectedSchemas.size > 0 && !loader.isLoading;

  const footer = hasSource && !isPhase1Loading ? (
    <Button variant="primary" className="w-full" disabled={!canVisualize} onClick={handleVisualize}>
      Visualize
    </Button>
  ) : undefined;

  return (
    <WizardPanel footer={footer}>
      {/* Back navigation */}
      <button
        className="flex items-center gap-1 text-xs hover:underline ln-text-link"
        onClick={onBack}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
        </svg>
        Back
      </button>

      {/* Source selection — locked once source is loaded */}
      {hasSource && !isPhase1Loading ? (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded text-sm ln-file-picker" style={{ opacity: 0.7, cursor: 'default' }}>
          {loader.filePath ? (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
            </svg>
          )}
          <span className="truncate flex-1">{loader.fileName}</span>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--ln-fg-dim)' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Open Dacpac — full width */}
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded text-sm text-left ln-file-picker ln-list-item"
            onClick={loader.openFile}
            disabled={loader.isLoading}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <span className="truncate">
              {loader.fileName && loader.filePath ? loader.fileName : 'Open .dacpac file…'}
            </span>
            {isPhase1Loading && loader.loadingContext === 'dacpac' && <InlineSpinner />}
          </button>

          {/* "or" divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 ln-border-top" />
            <span className="text-xs ln-text-muted">or</span>
            <div className="flex-1 ln-border-top" />
          </div>

          {/* Connect to Database — full width, shown-but-disabled when MSSQL unavailable */}
          <Tooltip content={loader.mssqlAvailable === false
              ? 'Requires the SQL Server (mssql) extension'
              : 'Connect to database'} asChild>
            <button
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded text-sm text-left ln-file-picker ln-list-item"
              onClick={loader.connectToDatabase}
              disabled={loader.isLoading || loader.mssqlAvailable !== true}
            >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
            </svg>
            <span className="truncate">
              {loader.fileName && !loader.filePath ? loader.fileName : 'Connect to database…'}
            </span>
            {isPhase1Loading && loader.loadingContext === 'database' && <InlineSpinner />}
          </button>
          </Tooltip>

          {/* Status / error */}
          {loader.status && (
            <StatusMessage text={loader.status.text} type={loader.status.type} />
          )}
        </div>
      )}

      {/* Phase 2: project name + schema selector (shown after Phase 1 completes) */}
      {hasSource && !isPhase1Loading && (
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium ln-text">Project name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. AdventureWorks 2026-03-24 14:35"
              className="w-full h-8 px-2 text-sm rounded ln-input"
            />
          </div>

          {(loader.schemaPreview ?? loader.model)?.schemas && (() => {
            const schemas = (loader.schemaPreview ?? loader.model)!.schemas;
            if (schemas.length === 0) {
              return (
                <div className="ln-status-warning text-xs px-3 py-2 rounded">
                  {loader.status?.text ?? 'No schemas found — the file may be empty or damaged.'}
                </div>
              );
            }
            const selectedCount = schemas
              .filter(s => loader.selectedSchemas.has(s.name))
              .reduce((sum, s) => sum + s.nodeCount, 0);
            const overLimit = selectedCount > maxNodes;
            return (
              <>
                <SchemaSelector
                  schemas={schemas}
                  selectedSchemas={loader.selectedSchemas}
                  onToggle={loader.toggleSchema}
                  onSelectAll={loader.selectAllSchemas}
                  onClearAll={loader.clearAllSchemas}
                />
                <div
                  className={`text-xs px-1 ${overLimit ? 'ln-status-warning rounded px-2 py-1' : ''}`}
                  style={{ color: overLimit ? undefined : 'var(--ln-wizard-fg-dim)' }}
                >
                  {overLimit
                    ? `⚠ ${selectedCount.toLocaleString()} objects selected — exceeds the ${maxNodes} node limit. Largest schemas will be trimmed.`
                    : `${selectedCount.toLocaleString()} objects selected`}
                </div>
              </>
            );
          })()}
        </>
      )}
    </WizardPanel>
  );
});

/**
 * A simple inline spinning SVG used to indicate loading progress within wizard buttons.
 */
function InlineSpinner() {
  return (
    <svg className="animate-spin w-4 h-4 ml-auto flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
