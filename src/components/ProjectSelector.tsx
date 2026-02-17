import { useState } from 'react';
import type { DacpacModel, ExtensionConfig } from '../engine/types';
import type { StatusMessage, DacpacLoaderState } from '../hooks/useDacpacLoader';
import { useVsCode } from '../contexts/VsCodeContext';
import { SchemaSelector } from './SchemaSelector';
import { Button } from './ui/Button';

interface ProjectSelectorProps {
  onVisualize: (model: DacpacModel, selectedSchemas: Set<string>) => void;
  config: ExtensionConfig;
  loader: DacpacLoaderState;
}

const STATUS_CLASSES: Record<StatusMessage['type'], string> = {
  error: 'ln-status-error',
  warning: 'ln-status-warning',
  success: 'ln-status-success',
  info: 'ln-status-info',
};

const ICON_COLORS: Record<StatusMessage['type'], string> = {
  error: 'var(--vscode-editorError-foreground, #f14c4c)',
  warning: 'var(--vscode-editorWarning-foreground, #cca700)',
  success: 'var(--vscode-testing-iconPassed, #73c991)',
  info: 'currentColor',
};

function StatusIcon({ type }: { type: StatusMessage['type'] }) {
  const cls = 'w-4 h-4 flex-shrink-0';
  const color = ICON_COLORS[type];
  const style = { fill: color };
  if (type === 'error')
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" className={cls} style={style}>
        <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
      </svg>
    );
  if (type === 'warning')
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" className={cls} style={style}>
        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
      </svg>
    );
  if (type === 'success')
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" className={cls} style={style}>
        <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
      </svg>
    );
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" className={cls} style={style}>
      <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clipRule="evenodd" />
    </svg>
  );
}

export function ProjectSelector({ onVisualize, config, loader }: ProjectSelectorProps) {
  const vscodeApi = useVsCode();
  const [logoFailed, setLogoFailed] = useState(false);
  const {
    model, selectedSchemas, isLoading, loadingContext, fileName, status, lastDacpacName, lastDbSourceName,
    mssqlAvailable,
    openFile, resetToStart, loadLast, loadDemo, connectToDatabase, cancelLoading,
    toggleSchema, selectAllSchemas, clearAllSchemas,
  } = loader;

  const selectedCount = model
    ? model.schemas
        .filter((s) => selectedSchemas.has(s.name))
        .reduce((sum, s) => sum + s.nodeCount, 0)
    : 0;

  const maxNodes = config.maxNodes;
  const overLimit = selectedCount > maxNodes;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 ln-start-screen">
      <div className="w-full max-w-md ln-panel" style={{ borderRadius: 6 }}>
        {/* Header */}
        <div className="flex items-center justify-center px-4 py-4 ln-border-bottom">
          {logoFailed ? (
            <span className="text-sm font-semibold ln-text">Data Lineage Viz</span>
          ) : (
            <img
              src={window.LOGO_URI || '../images/logo.png'}
              alt="Data Lineage Viz"
              className="h-10 w-auto"
              onError={() => setLogoFailed(true)}
            />
          )}
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* File picker / loading indicator */}
          <div>
            <label className="block text-xs font-medium mb-1.5 ln-text">Database Project</label>
            <div
              className={`flex items-center gap-3 px-3 py-2.5 rounded transition-colors ln-file-picker ${isLoading ? 'cursor-default' : 'cursor-pointer'}`}
              onClick={isLoading ? undefined : model ? resetToStart : openFile}
            >
              {isLoading && loadingContext === 'database' ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0 ln-text-muted animate-pulse">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0 ln-text-muted">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              )}
              {isLoading ? (
                <span className="text-xs ln-text-muted">
                  {loadingContext === 'database' ? 'Connecting to database...' : 'Parsing...'}
                </span>
              ) : fileName ? (
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium truncate block ln-text">{fileName}</span>
                </div>
              ) : (
                <span className="text-xs ln-text-placeholder">Select a .dacpac file...</span>
              )}
              {!isLoading && fileName && <span className="text-[10px] ln-text-muted">Change</span>}
            </div>
          </div>

          {/* Cancel button during loading */}
          {isLoading && (
            <Button
              variant="ghost"
              onClick={cancelLoading}
              className="w-full"
            >
              Cancel
            </Button>
          )}

          {/* Quick actions */}
          {!model && !isLoading && (
            <div className="flex items-center gap-2">
              <div className="flex-1 ln-border-top" />
              <span className="text-xs ln-text-muted">or</span>
              <div className="flex-1 ln-border-top" />
            </div>
          )}

          {!model && !isLoading && lastDacpacName && (
            <Button
              variant="primary"
              onClick={loadLast}
              className="w-full"
            >
              Reopen {lastDacpacName}
            </Button>
          )}

          {!model && !isLoading && (
            <Button
              variant="secondary"
              onClick={loadDemo}
              className="w-full"
            >
              Load Demo Data
            </Button>
          )}

          {!model && !isLoading && lastDbSourceName && (
            <Button
              variant="primary"
              onClick={connectToDatabase}
              disabled={mssqlAvailable !== true}
              className="w-full"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-2 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
              </svg>
              Reconnect {lastDbSourceName}
            </Button>
          )}

          {!model && !isLoading && (
            <Button
              variant="secondary"
              onClick={connectToDatabase}
              disabled={mssqlAvailable !== true}
              title={mssqlAvailable === false ? 'Install the MSSQL extension (ms-mssql.mssql) to connect to a live database' : undefined}
              className="w-full"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-2 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
              </svg>
              Connect to Database
            </Button>
          )}

          {/* Status */}
          {status && (
            <div className={`flex items-start gap-2.5 px-3 py-2.5 rounded text-xs ${STATUS_CLASSES[status.type]}`}>
              <StatusIcon type={status.type} />
              <div className="pt-px">
                <span style={{ color: ICON_COLORS[status.type] }}>{status.text}</span>
                {status.type === 'warning' && model && model.schemas.length === 0 && (
                  <p className="mt-1 ln-text-muted">Try a different file, or check the Output panel for details.</p>
                )}
              </div>
            </div>
          )}

          {/* Schema selector */}
          {model && model.schemas.length > 0 && (
            <SchemaSelector
              schemas={model.schemas}
              selectedSchemas={selectedSchemas}
              onToggle={toggleSchema}
              onSelectAll={selectAllSchemas}
              onClearAll={clearAllSchemas}
            />
          )}

          {/* Node count + limit warning — fixed height to prevent layout jump */}
          <div className="text-xs text-center py-1" style={{ minHeight: 24 }}>
            {model && selectedCount > 0 && (
              overLimit ? (
                <span>
                  <span className="ln-text-warning">{selectedCount}/{maxNodes} objects</span>
                  <span className="ln-text-muted">{' — '}</span>
                  <button
                    className="underline ln-text-link"
                    onClick={clearAllSchemas}
                  >
                    reduce
                  </button>
                  <span className="ln-text-muted">{' or '}</span>
                  <button
                    className="underline ln-text-link"
                    onClick={() => vscodeApi.postMessage({ type: 'open-settings' })}
                  >
                    set limit
                  </button>
                </span>
              ) : (
                <span className="ln-text-muted">{selectedCount} objects selected</span>
              )
            )}
          </div>

          {/* Visualize */}
          <Button
            variant="primary"
            onClick={() => model && onVisualize(model, selectedSchemas)}
            disabled={!model || selectedSchemas.size === 0 || overLimit}
            className="w-full"
          >
            Visualize
          </Button>
        </div>
      </div>
    </div>
  );
}
