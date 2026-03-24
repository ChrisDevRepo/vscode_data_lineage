import { memo, useState, useCallback } from 'react';
import { Button } from './ui/Button';
import { WizardPanel } from './ui/WizardPanel';
import { SchemaSelector } from './SchemaSelector';
import type { DacpacLoaderState } from '../hooks/useDacpacLoader';
import type { DacpacConnection, DatabaseConnection, StoredConnectionInfo } from '../engine/projectStore';
import { generateProjectName } from '../engine/projectStore';

interface CreateFlowProps {
  loader: DacpacLoaderState;
  onBack: () => void;
  onVisualize: (projectName: string, project: DacpacConnection | DatabaseConnection | null) => void;
}

export const CreateFlow = memo(function CreateFlow({
  loader,
  onBack,
  onVisualize,
}: CreateFlowProps) {
  const [projectName, setProjectName] = useState('');

  // Auto-fill project name when schema preview arrives (Phase 1 done)
  const schemaOrModel = loader.schemaPreview ?? loader.model;
  const hasSource = !!schemaOrModel;
  const isPhase1Loading = loader.isLoading && !loader.schemaPreview && !loader.model;

  // Build auto-name when source first appears
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

      {/* Source selection row */}
      <div className="space-y-2">
        <div className="flex gap-2">
          {/* Open Dacpac */}
          <button
            className="flex-1 flex items-center gap-2 px-3 py-2 rounded text-sm text-left ln-file-picker ln-list-item"
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

          {/* Connect to Database */}
          {loader.mssqlAvailable && (
            <button
              className="flex items-center gap-2 px-3 py-2 rounded text-sm ln-file-picker ln-list-item"
              onClick={loader.connectToDatabase}
              disabled={loader.isLoading}
              title="Connect to database"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
              </svg>
              {isPhase1Loading && loader.loadingContext === 'database' && <InlineSpinner />}
            </button>
          )}
        </div>

        {/* Status / error */}
        {loader.status && (
          <div className={`text-xs px-3 py-2 rounded ln-status-${loader.status.type}`}>
            {loader.status.text}
          </div>
        )}
      </div>

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

          {(loader.schemaPreview ?? loader.model)?.schemas && (
            <SchemaSelector
              schemas={(loader.schemaPreview ?? loader.model)!.schemas}
              selectedSchemas={loader.selectedSchemas}
              onToggle={loader.toggleSchema}
              onSelectAll={loader.selectAllSchemas}
              onClearAll={loader.clearAllSchemas}
            />
          )}
        </>
      )}
    </WizardPanel>
  );
});

function InlineSpinner() {
  return (
    <svg className="animate-spin w-4 h-4 ml-auto flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
