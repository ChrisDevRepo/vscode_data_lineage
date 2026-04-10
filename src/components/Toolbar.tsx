import { memo, useState } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { useDropdown } from '../hooks/useDropdown';
import { ObjectType, AnalysisType } from '../engine/types';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { HelpModal } from './HelpModal';
import { SchemaFilterDropdown } from './SchemaFilterDropdown';
import { TypeFilterDropdown } from './TypeFilterDropdown';
import { ExternalRefsDropdown } from './ExternalRefsDropdown';
import { ExclusionDropdown } from './ExclusionDropdown';
import { SavedViewsDropdown } from './SavedViewsDropdown';
import { SearchWithAutocomplete } from './SearchWithAutocomplete';
import type { FilterProfile } from '../engine/projectStore';

interface ToolbarProps {
  types: Set<ObjectType>;
  onToggleType: (type: ObjectType) => void;
  hideIsolated: boolean;
  onToggleIsolated: () => void;
  focusSchemas: Set<string>;
  onToggleFocusSchema: (schema: string) => void;
  selectedSchemas?: Set<string>;
  onToggleSchema?: (schema: string) => void;
  onSelectAllSchemas?: (schemas: string[]) => void;
  onSelectNoneSchemas?: (schemas: string[]) => void;
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
  showExternalRefs?: boolean;
  externalRefTypes?: Set<'file' | 'db'>;
  onToggleExternalRefs?: () => void;
  onToggleExternalRefType?: (subType: 'file' | 'db') => void;
  exclusionPatterns?: string[];
  onAddExclusionPattern?: (pattern: string) => void;
  onRemoveExclusionPattern?: (pattern: string) => void;
  filterProfiles?: FilterProfile[];
  activeProjectId?: string | null;
  activeViewId?: string | null;
  isViewModified?: boolean;
  onSaveView?: (name: string) => void;
  onApplyView?: (profile: FilterProfile) => void;
  onDeleteView?: (profileId: string) => void;
  onUpdateView?: (profileId: string) => void;
  /** When true, a confirmation strip is shown before navigating back. */
  isFilterDirty?: boolean;
  /** When true, analysis and trace-start buttons are disabled (trace/analysis/bookmark mode active). */
  isModeLocked?: boolean;
  /** When true, graph is in schema overview mode — export is disabled. */
  isOverview?: boolean;
  allNodes?: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  metrics: {
    totalNodes: number;
    totalEdges: number;
    rootNodes: number;
    leafNodes: number;
  } | null;
}

function buildMetricsTooltip(
  allNodes: Array<{ type: ObjectType }>,
  metrics: { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number }
): string {
  const counts: Partial<Record<ObjectType, number>> = {};
  for (const n of allNodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  const typeRows: string[] = [];
  const pad = String(metrics.totalNodes).length;
  if (counts.table)     typeRows.push(`  ${String(counts.table).padStart(pad)} tables`);
  if (counts.view)      typeRows.push(`  ${String(counts.view).padStart(pad)} views`);
  if (counts.procedure) typeRows.push(`  ${String(counts.procedure).padStart(pad)} procedures`);
  if (counts.function)  typeRows.push(`  ${String(counts.function).padStart(pad)} functions`);
  if (counts.external)  typeRows.push(`  ${String(counts.external).padStart(pad)} external`);
  return [`Objects: ${metrics.totalNodes}`, ...typeRows].join('\n');
}

export const Toolbar = memo(function Toolbar({
  types,
  onToggleType,
  hideIsolated,
  onToggleIsolated,
  focusSchemas,
  onToggleFocusSchema,
  selectedSchemas: propSelectedSchemas,
  onToggleSchema,
  onSelectAllSchemas,
  onSelectNoneSchemas,
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
  showExternalRefs = true,
  externalRefTypes = new Set<'file' | 'db'>(['file', 'db']),
  onToggleExternalRefs,
  onToggleExternalRefType,
  exclusionPatterns = [],
  onAddExclusionPattern,
  onRemoveExclusionPattern,
  filterProfiles = [],
  activeProjectId,
  activeViewId,
  isViewModified,
  onSaveView,
  onApplyView,
  onDeleteView,
  onUpdateView,
  isFilterDirty = false,
  isModeLocked = false,
  isOverview = false,
  allNodes = [],
  metrics,
}: ToolbarProps) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [confirmingBack, setConfirmingBack] = useState(false);
  const analysis = useDropdown();

  useKeyboardShortcut('?', () => setIsHelpOpen(true));

  const schemas = availableSchemas || [];
  const selectedSchemas = propSelectedSchemas || new Set(schemas);

  return (
    <>
      <div className="ln-toolbar flex items-center gap-2 px-4 py-2.5">
        {/* Navigation */}
        <Tooltip content="Load New Project">
          <Button onClick={() => isFilterDirty ? setConfirmingBack(true) : onBack()} variant="icon" aria-label="Load New Project">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
            </svg>
          </Button>
        </Tooltip>
        {onSaveView && onApplyView && onDeleteView && (
          <SavedViewsDropdown
            filterProfiles={filterProfiles}
            isEnabled={!!activeProjectId}
            activeViewId={activeViewId}
            isViewModified={isViewModified}
            onSaveView={onSaveView}
            onApplyView={onApplyView}
            onDeleteView={onDeleteView}
            onUpdateView={onUpdateView}
          />
        )}

        <div className="w-px h-6 ln-divider" />

        {/* Search & Filters */}
        <div className="flex-1 min-w-[100px] max-w-[340px]">
          <SearchWithAutocomplete
            onExecuteSearch={onExecuteSearch}
            onStartTrace={isModeLocked || isAnalysisActive ? undefined : onStartTrace}
            allNodes={allNodes}
            selectedSchemas={selectedSchemas}
            types={types}
          />
        </div>
        <Tooltip content="Detail Search (full-text search in SQL bodies)">
          <Button onClick={onToggleDetailSearch} variant="icon" className={isDetailSearchOpen ? 'ln-btn-icon-active' : ''} aria-label="Detail Search" aria-pressed={isDetailSearchOpen}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 8.25v3m0 0v3m0-3h3m-3 0h-3" />
            </svg>
          </Button>
        </Tooltip>
        <SchemaFilterDropdown schemas={schemas} selectedSchemas={selectedSchemas} focusSchemas={focusSchemas} onToggleSchema={onToggleSchema} onSelectAll={onSelectAllSchemas} onSelectNone={onSelectNoneSchemas} onToggleFocusSchema={onToggleFocusSchema} />
        <TypeFilterDropdown types={types} onToggleType={onToggleType} />
        {onToggleExternalRefs && onToggleExternalRefType && (
          <ExternalRefsDropdown
            showExternalRefs={showExternalRefs}
            externalRefTypes={externalRefTypes}
            onToggleMaster={onToggleExternalRefs}
            onToggleSubType={onToggleExternalRefType}
          />
        )}
        {onAddExclusionPattern && onRemoveExclusionPattern && (
          <ExclusionDropdown
            exclusionPatterns={exclusionPatterns}
            onAddPattern={onAddExclusionPattern}
            onRemovePattern={onRemoveExclusionPattern}
          />
        )}
        <div className="w-px h-6 ln-divider" />

        {/* Graph Controls: HideIsolated + Analysis + ClearFilters */}
        <Tooltip content={analysisType === 'orphans' ? 'Disabled during Orphan analysis' : 'Hide Isolated Nodes'}>
          <Button onClick={onToggleIsolated} variant="icon" className={hideIsolated ? 'ln-btn-icon-active' : ''} disabled={analysisType === 'orphans'} aria-label="Hide Isolated Nodes" aria-pressed={hideIsolated}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
            </svg>
          </Button>
        </Tooltip>

        {/* Analysis Dropdown */}
        <Tooltip content={isModeLocked && !isAnalysisActive ? 'Exit current mode to start analysis' : 'Graph Analysis'}>
          <Button
            ref={analysis.refs.setReference}
            onClick={analysis.toggle}
            variant="icon"
            className={isAnalysisActive ? 'ln-btn-icon-active ln-btn-icon-active--analysis' : ''}
            disabled={isModeLocked && !isAnalysisActive}
            aria-label="Graph Analysis"
            aria-pressed={isAnalysisActive}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605" />
            </svg>
          </Button>
        </Tooltip>
        <FloatingPortal>
          {analysis.isOpen && (
            <div
              ref={analysis.refs.setFloating}
              style={{ ...analysis.floatingStyles, boxShadow: 'var(--ln-dropdown-shadow)' }}
              className="w-52 rounded-md shadow-lg z-50 ln-dropdown"
              {...analysis.getFloatingProps()}
            >
              <div className="py-1">
                <button className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('islands'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
                  Islands
                </button>
                <button className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('hubs'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg>
                  Hubs
                </button>
                <button className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('orphans'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                  Orphan Nodes
                </button>
                <button className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('longest-path'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
                  Longest Path
                </button>
                <button className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('cycles'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                  Cycles
                </button>
                <button className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('external-refs'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                  External Refs
                </button>
              </div>
            </div>
          )}
        </FloatingPortal>

        <Tooltip content="Clear All Filters">
          <Button onClick={onRefresh} variant="icon" aria-label="Clear All Filters">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17l5 5M22 17l-5 5" />
            </svg>
          </Button>
        </Tooltip>

        <div className="w-px h-6 ln-divider" />

        {/* Tools: DDL Viewer, Refresh, Export */}
        <Tooltip content={isOverview ? 'DDL not available in schema view' : (hasHighlightedNode ? 'View DDL / SQL source for selected node' : 'View DDL / SQL source')}>
          <Button onClick={onOpenDdlViewer} variant="icon" aria-label="View DDL / SQL source" disabled={isOverview}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
            </svg>
          </Button>
        </Tooltip>
        {onRebuild && (
          <Tooltip content="Refresh (re-read settings &amp; rebuild graph)">
            <Button onClick={onRebuild} variant="icon" aria-label="Refresh (re-read settings and rebuild graph)">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            </Button>
          </Tooltip>
        )}

        {/* Export & Help */}
        <Tooltip content={isOverview ? 'Export not available in schema view' : 'Export as Draw.io'}>
          <Button onClick={onExportDrawio} variant="icon" aria-label="Export as Draw.io" disabled={isOverview}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          </Button>
        </Tooltip>
        <Tooltip content="Help">
          <Button onClick={() => setIsHelpOpen(true)} variant="icon" aria-label="Help">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
            </svg>
          </Button>
        </Tooltip>

        {/* Metrics — pushed to right */}
        {metrics && (
          <>
            <div className="ml-auto w-px h-6 flex-shrink-0 ln-divider" />
            <Tooltip content={buildMetricsTooltip(allNodes, metrics)} delay={400} multiline>
              <div className="flex-shrink-0 text-xs ln-text-muted whitespace-nowrap tabular-nums flex items-center gap-1 pr-1 cursor-default select-none">
                <span className="font-medium" style={{ color: 'var(--ln-fg)' }}>{metrics.totalNodes}</span>
                <span className="opacity-60">objects</span>
              </div>
            </Tooltip>
          </>
        )}
      </div>

      {confirmingBack && (
        <div className="px-4 py-1.5 flex items-center gap-2 text-xs" style={{ background: 'var(--ln-bg-secondary)', borderBottom: '1px solid var(--ln-border)' }}>
          <span className="ln-text-muted">Leave current view? Unsaved changes will be lost.</span>
          <Button variant="ghost" className="h-6 px-2 text-xs" style={{ color: 'var(--ln-warning-fg)' }} onClick={() => { setConfirmingBack(false); onBack(); }}>Leave</Button>
          <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConfirmingBack(false)}>Cancel</Button>
        </div>
      )}

      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </>
  );
});
