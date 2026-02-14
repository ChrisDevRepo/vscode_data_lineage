import { memo, useState, useRef, useCallback } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { ObjectType, AnalysisType } from '../engine/types';
import { Button } from './ui/Button';
import { HelpModal } from './HelpModal';
import { SchemaFilterDropdown } from './SchemaFilterDropdown';
import { TypeFilterDropdown } from './TypeFilterDropdown';
import { SearchWithAutocomplete } from './SearchWithAutocomplete';

interface ToolbarProps {
  types: Set<ObjectType>;
  onToggleType: (type: ObjectType) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  hideIsolated: boolean;
  onToggleIsolated: () => void;
  focusSchemas: Set<string>;
  onToggleFocusSchema: (schema: string) => void;
  selectedSchemas?: Set<string>;
  onToggleSchema?: (schema: string) => void;
  availableSchemas?: string[];
  onRefresh: () => void;
  onRebuild?: () => void;
  onBack: () => void;
  onOpenDdlViewer?: () => void;
  onExportDrawio?: () => void;
  hasHighlightedNode?: boolean;
  onExecuteSearch?: (name: string, schema?: string) => void;
  onStartTrace?: (nodeId: string) => void;
  onToggleDetailSearch?: () => void;
  isDetailSearchOpen?: boolean;
  isAnalysisActive?: boolean;
  analysisType?: AnalysisType | null;
  onOpenAnalysis?: (type: AnalysisType) => void;
  allNodes?: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  metrics: {
    totalNodes: number;
    totalEdges: number;
    rootNodes: number;
    leafNodes: number;
  } | null;
}

export const Toolbar = memo(function Toolbar({
  types,
  onToggleType,
  searchTerm,
  onSearchChange,
  hideIsolated,
  onToggleIsolated,
  focusSchemas,
  onToggleFocusSchema,
  selectedSchemas: propSelectedSchemas,
  onToggleSchema,
  availableSchemas,
  onRefresh,
  onRebuild,
  onBack,
  onOpenDdlViewer,
  onExportDrawio,
  hasHighlightedNode = false,
  onExecuteSearch,
  onStartTrace,
  onToggleDetailSearch,
  isDetailSearchOpen = false,
  isAnalysisActive = false,
  analysisType = null,
  onOpenAnalysis,
  allNodes = [],
  metrics,
}: ToolbarProps) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isAnalysisDropdownOpen, setIsAnalysisDropdownOpen] = useState(false);
  const analysisDropdownRef = useRef<HTMLDivElement>(null);

  const closeAnalysisDropdown = useCallback(() => setIsAnalysisDropdownOpen(false), []);
  useClickOutside([analysisDropdownRef], isAnalysisDropdownOpen, closeAnalysisDropdown);
  
  const schemas = availableSchemas || [];
  const selectedSchemas = propSelectedSchemas || new Set(schemas);

  return (
    <>
      <div className="ln-toolbar flex items-center justify-between gap-4 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Button onClick={onBack} variant="ghost" title="Back to Project Selection">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"
              />
            </svg>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <SearchWithAutocomplete
            searchTerm={searchTerm}
            onSearchChange={onSearchChange}
            onExecuteSearch={onExecuteSearch}
            onStartTrace={isAnalysisActive ? undefined : onStartTrace}
            allNodes={allNodes}
            selectedSchemas={selectedSchemas}
            types={types}
          />

          <Button
            onClick={onToggleDetailSearch}
            variant={isDetailSearchOpen ? 'primary' : 'icon'}
            title="Detail Search (full-text search in SQL bodies)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.5 8.25v3m0 0v3m0-3h3m-3 0h-3"
              />
            </svg>
          </Button>

          <SchemaFilterDropdown
            schemas={schemas}
            selectedSchemas={selectedSchemas}
            focusSchemas={focusSchemas}
            onToggleSchema={onToggleSchema}
            onToggleFocusSchema={onToggleFocusSchema}
          />

          <TypeFilterDropdown
            types={types}
            onToggleType={onToggleType}
          />

          <div className="w-px h-6 ln-divider" />

          <Button
            onClick={onOpenDdlViewer}
            variant="icon"
            title={hasHighlightedNode ? 'Open SQL Viewer for selected node' : 'Open SQL Viewer'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              />
            </svg>
          </Button>

          <Button
            onClick={onToggleIsolated}
            variant={hideIsolated ? 'default' : 'ghost'}
            title={analysisType === 'orphans' ? 'Disabled during Orphan analysis' : 'Hide Isolated Nodes'}
            disabled={analysisType === 'orphans'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"
              />
            </svg>
          </Button>

          <div className="relative" ref={analysisDropdownRef}>
            <Button
              onClick={() => setIsAnalysisDropdownOpen(prev => !prev)}
              variant={isAnalysisActive ? 'primary' : 'ghost'}
              title="Graph Analysis"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605"
                />
              </svg>
            </Button>
            {isAnalysisDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-48 rounded-md shadow-lg z-50 ln-dropdown" style={{ boxShadow: 'var(--ln-dropdown-shadow)' }}>
                <div className="py-1">
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs ln-list-item flex items-center gap-2"
                    onClick={() => { setIsAnalysisDropdownOpen(false); onOpenAnalysis?.('islands'); }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                    </svg>
                    Islands
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs ln-list-item flex items-center gap-2"
                    onClick={() => { setIsAnalysisDropdownOpen(false); onOpenAnalysis?.('hubs'); }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
                    </svg>
                    Hubs
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs ln-list-item flex items-center gap-2"
                    onClick={() => { setIsAnalysisDropdownOpen(false); onOpenAnalysis?.('orphans'); }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                    Orphan Nodes
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs ln-list-item flex items-center gap-2"
                    onClick={() => { setIsAnalysisDropdownOpen(false); onOpenAnalysis?.('longest-path'); }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                    </svg>
                    Longest Path
                  </button>
                </div>
              </div>
            )}
          </div>

          <Button onClick={onRefresh} variant="ghost" title="Clear All Filters">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 17l5 5M22 17l-5 5"
              />
            </svg>
          </Button>

          {onRebuild && (
            <Button onClick={onRebuild} variant="ghost" title="Refresh (re-read settings & rebuild layout)">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                />
              </svg>
            </Button>
          )}

          <div className="w-px h-6 ln-divider" />

          <Button onClick={onExportDrawio} variant="ghost" title="Export as Draw.io">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
              />
            </svg>
          </Button>

          <Button onClick={() => setIsHelpOpen(true)} variant="ghost" title="Help">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z"
              />
            </svg>
          </Button>
        </div>

        {metrics && (
          <div className="flex items-center gap-2.5 text-xs ln-text-muted whitespace-nowrap">
            <div className="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
              <span><span className="font-mono inline-block text-right" style={{ minWidth: '3ch', fontVariantNumeric: 'tabular-nums' }}>{metrics.totalNodes}</span> nodes</span>
            </div>
            <div className="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
              </svg>
              <span><span className="font-mono inline-block text-right" style={{ minWidth: '3ch', fontVariantNumeric: 'tabular-nums' }}>{metrics.totalEdges}</span> edges</span>
            </div>
            <div className="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
              <span><span className="font-mono inline-block text-right" style={{ minWidth: '3ch', fontVariantNumeric: 'tabular-nums' }}>{metrics.rootNodes}</span> roots</span>
            </div>
            <div className="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
              </svg>
              <span><span className="font-mono inline-block text-right" style={{ minWidth: '3ch', fontVariantNumeric: 'tabular-nums' }}>{metrics.leafNodes}</span> leaves</span>
            </div>
          </div>
        )}
      </div>

      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </>
  );
});
