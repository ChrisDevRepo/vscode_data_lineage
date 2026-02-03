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

const STATUS_ICONS: Record<StatusMessage['type'], string> = {
  error: '!', warning: '!', success: '>', info: 'i',
};

export function ProjectSelector({ onVisualize, config, loader }: ProjectSelectorProps) {
  const vscodeApi = useVsCode();
  const {
    model, selectedSchemas, isLoading, fileName, status,
    fileRef, handleFileChange, loadDemo, toggleSchema, selectAllSchemas, clearAllSchemas,
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
          <img
            src={(window as any).LOGO_URI || '../images/logo.png'}
            alt="Data Lineage Viz"
            className="h-10 w-auto"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
              const fallback = document.createElement('span');
              fallback.className = 'text-sm font-semibold ln-text';
              fallback.textContent = 'Data Lineage Viz';
              target.parentElement?.appendChild(fallback);
            }}
          />
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* File picker */}
          <div>
            <label className="block text-xs font-medium mb-1.5 ln-text">Database Project</label>
            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded cursor-pointer transition-colors ln-file-picker"
              onClick={() => fileRef.current?.click()}
            >
              <input ref={fileRef} type="file" accept=".dacpac" onChange={handleFileChange} className="hidden" />
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0 ln-text-muted">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              {isLoading ? (
                <span className="text-xs ln-text-muted">Parsing...</span>
              ) : fileName ? (
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium truncate block ln-text">{fileName}</span>
                </div>
              ) : (
                <span className="text-xs ln-text-placeholder">Select a .dacpac file...</span>
              )}
              {fileName && <span className="text-[10px] ln-text-muted">Change</span>}
            </div>
          </div>

          {/* Load Demo Button */}
          {!model && !isLoading && (
            <div className="flex items-center gap-2">
              <div className="flex-1 ln-border-top" />
              <span className="text-xs ln-text-muted">or</span>
              <div className="flex-1 ln-border-top" />
            </div>
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

          {/* Status */}
          {status && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded text-xs ln-text ${STATUS_CLASSES[status.type]}`}>
              <span className="flex-shrink-0">{STATUS_ICONS[status.type]}</span>
              <span className="truncate">{status.text}</span>
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
