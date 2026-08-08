import { memo, useMemo, useState } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { useDropdown } from '../hooks/useDropdown';
import type { ObjectType, AnalysisType, GraphMode } from '../engine/types';
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
import { SHORTCUT_KEYS } from '../ui/keyboardShortcuts';

interface ToolbarProps {
  /** The set of object types (table, view, etc.) currently active in the filter. */
  types: Set<ObjectType>;
  /** Callback to toggle a specific object type in the filter. */
  onToggleType: (type: ObjectType) => void;
  /** Whether nodes with no edges are currently hidden. */
  hideIsolated: boolean;
  /** Callback to toggle the visibility of isolated nodes. */
  onToggleIsolated: () => void;
  /** Set of schemas that are currently highlighted or "focused" in the graph. */
  focusSchemas: Set<string>;
  /** Callback to toggle focus for a specific schema. */
  onToggleFocusSchema: (schema: string) => void;
  /** The set of schemas currently selected for rendering. */
  selectedSchemas?: Set<string>;
  /** Callback to toggle visibility for a specific schema. */
  onToggleSchema?: (schema: string) => void;
  /** Callback to select all available schemas. */
  onSelectAllSchemas?: (schemas: string[]) => void;
  /** Callback to deselect all schemas. */
  onSelectNoneSchemas?: (schemas: string[]) => void;
  /** List of all unique schema names present in the current model. */
  availableSchemas?: string[];
  /** Callback to reset all filters to their default state. */
  onRefresh: () => void;
  /** Callback to re-extract metadata and completely rebuild the graph. */
  onRebuild?: () => void;
  /** Callback to return to the project selection screen. */
  onBack: () => void;
  /** Callback to open the DDL/SQL source viewer for the selected node. */
  onOpenDdlViewer?: () => void;
  /** Callback to export the current graph state as a Draw.io XML file. */
  onExportDrawio?: () => void;
  /** Whether a node is currently selected/highlighted in the canvas. */
  hasHighlightedNode?: boolean;
  /** Callback to execute a search and highlight matching nodes. */
  onExecuteSearch?: (name: string, schema?: string) => void;
  /** Callback to initiate a column-level or table-level lineage trace. */
  onStartTrace?: (nodeId: string) => void;
  /**
   * IDs of nodes that are in the working set but collapsed inside a schema cluster.
   * Passed through to {@link SearchWithAutocomplete} for three-state search partitioning.
   */
  collapsedSchemaNodeIds?: Set<string>;
  /** Callback to toggle the full-text SQL search sidebar. */
  onToggleDetailSearch?: () => void;
  /** Whether the detail search sidebar is currently visible. */
  isDetailSearchOpen?: boolean;
  /** Whether an analysis mode (islands, hubs, etc.) is currently active. */
  isAnalysisActive?: boolean;
  /** The specific type of analysis currently being performed. */
  analysisType?: AnalysisType | null;
  /** Callback to switch to a specific analysis mode. */
  onOpenAnalysis?: (type: AnalysisType) => void;
  /** Whether external references (cross-DB, files) are shown. */
  showExternalRefs?: boolean;
  /** The specific subtypes of external references to display. */
  externalRefTypes?: Set<'file' | 'db'>;
  /** Callback to toggle the global external references filter. */
  onToggleExternalRefs?: () => void;
  /** Callback to toggle a specific external reference subtype. */
  onToggleExternalRefType?: (subType: 'file' | 'db') => void;
  /** List of glob patterns used to exclude objects by name. */
  exclusionPatterns?: string[];
  /** Callback to add a new name-based exclusion pattern. */
  onAddExclusionPattern?: (pattern: string) => void;
  /** Callback to remove an existing exclusion pattern. */
  onRemoveExclusionPattern?: (pattern: string) => void;
  /** List of saved filter profiles (bookmarks) for the current project. */
  filterProfiles?: FilterProfile[];
  /** The ID of the currently loaded project. */
  activeProjectId?: string | null;
  /** The ID of the currently applied saved view. */
  activeViewId?: string | null;
  /** Whether the current filter state differs from the applied saved view. */
  isViewModified?: boolean;
  /** Callback to save the current filter state as a new view. */
  onSaveView?: (name: string) => void;
  /** Callback to apply a saved filter profile. */
  onApplyView?: (profile: FilterProfile) => void;
  /** Callback to delete a saved filter profile. */
  onDeleteView?: (profileId: string) => void;
  /** Callback to update an existing saved filter profile. */
  onUpdateView?: (profileId: string) => void;
  /** Whether the filters have been modified since the last project load/save. */
  isFilterDirty?: boolean;
  /** Whether UI interactions that would change the graph structure are disabled. */
  isModeLocked?: boolean;
  /** Whether a fresh trace/path/analysis mode can be started from the current view. */
  canStartNewScopedMode?: boolean;
  /** Whether Object View / Schema View can be toggled from the current view. */
  canSwitchGraphMode?: boolean;
  /** Whether the graph is showing schema clusters only. */
  isOverview?: boolean;
  /** Explicit Object View / Schema View state. */
  graphMode?: GraphMode;
  /** Callback to switch between Object View and Schema View. */
  onGraphModeChange?: (mode: GraphMode) => void;
  /** Whether overview currently renders schema clusters and object nodes. */
  isExpandedSchemaViewActive?: boolean;
  /** Callback to collapse all expanded schemas and return to Schema View. */
  onResetExpandedSchemaView?: () => void;
  /** Whether collapsed schema clusters are visible beside expanded object nodes. */
  showExpandedSchemaClusters?: boolean;
  /** Callback to hide/show collapsed schema clusters without changing filters. */
  onToggleExpandedSchemaClusters?: () => void;
  /** Number of schemas currently expanded in expanded schema view. */
  expandedSchemaCount?: number;
  /** Callback to expand all schemas at once and enter Expanded Schema View. */
  onExpandAllSchemas?: () => void;
  /** Complete list of nodes available in the project model. */
  allNodes?: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  /** The set of node IDs that passed through all current filters. */
  visibleNodeIds: Set<string>;
  /** High-level graph metrics for display in the status bar. */
  metrics: {
    totalNodes: number;
    totalEdges: number;
    rootNodes: number;
    leafNodes: number;
  } | null;
  /** Number of nodes React Flow is actually rendering (the perf-relevant count). */
  renderedNodeCount: number;
  /** Object count above which newly loaded graphs start in Schema View (`dataLineageViz.overview.threshold`). */
  overviewThreshold: number;
  /** Rendered-node ceiling above which the graph is replaced by a limit warning (`dataLineageViz.renderLimit`). */
  renderLimit: number;
  /**
   * Set once on initial load/reset: `true` when the loaded model is below the overview threshold.
   * Disables the Schema View button until the user opts in via settings; never re-derived from filter changes.
   */
  schemaViewSoftDisabled?: boolean;
}

const METRIC_NUMBER_FORMAT = new Intl.NumberFormat();

function formatMetricCount(value: number): string {
  return METRIC_NUMBER_FORMAT.format(value);
}

function buildMetricsTooltip(
  allNodes: Array<{ type: ObjectType }>,
  metrics: { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number },
  renderedNodeCount: number,
  overviewThreshold: number,
  renderLimit: number,
  modeLines: readonly string[] = [],
): string {
  const counts: Partial<Record<ObjectType, number>> = {};
  for (const n of allNodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  const total = allNodes.length;
  const typeRows: string[] = [];
  if (counts.table)     typeRows.push(`  ${formatMetricCount(counts.table)} tables`);
  if (counts.view)      typeRows.push(`  ${formatMetricCount(counts.view)} views`);
  if (counts.procedure) typeRows.push(`  ${formatMetricCount(counts.procedure)} procedures`);
  if (counts.function)  typeRows.push(`  ${formatMetricCount(counts.function)} functions`);
  if (counts.external)  typeRows.push(`  ${formatMetricCount(counts.external)} external`);
  const header = [
    `Rendered: ${formatMetricCount(renderedNodeCount)} graph nodes mounted`,
    `Filtered: ${formatMetricCount(metrics.totalNodes)} catalog objects in scope`,
    `Total: ${formatMetricCount(total)} loaded catalog objects`,
    `Initial Schema View threshold ${formatMetricCount(overviewThreshold)}; render limit ${formatMetricCount(renderLimit)}`,
  ];
  return [...modeLines, ...(modeLines.length > 0 ? [''] : []), ...header, '', ...typeRows].join('\n');
}

function expandedSchemaStatusText(expandedSchemaCount: number): string {
  return expandedSchemaCount === 1 ? '1 schema expanded' : `${expandedSchemaCount} schemas expanded`;
}


/**
 * Provides graph search, filtering, analysis, navigation, and keyboard controls.
 */
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
  collapsedSchemaNodeIds,
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
  canStartNewScopedMode = !isModeLocked,
  canSwitchGraphMode = !isModeLocked,
  isOverview = false,
  graphMode,
  onGraphModeChange,
  isExpandedSchemaViewActive = false,
  onResetExpandedSchemaView,
  showExpandedSchemaClusters = true,
  onToggleExpandedSchemaClusters,
  expandedSchemaCount = 0,
  onExpandAllSchemas,
  allNodes = [],
  visibleNodeIds,
  metrics,
  renderedNodeCount,
  overviewThreshold,
  renderLimit,
  schemaViewSoftDisabled = false,
}: ToolbarProps) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [confirmingBack, setConfirmingBack] = useState(false);
  const analysis = useDropdown();

  useKeyboardShortcut(SHORTCUT_KEYS.openHelp, () => setIsHelpOpen(true));
  useKeyboardShortcut(SHORTCUT_KEYS.toggleSchemaView, () => {
    if (!onGraphModeChange || !canSwitchGraphMode || schemaViewSoftDisabled) return;
    onGraphModeChange(currentGraphMode === 'overview' ? 'full' : 'overview');
  });
  useKeyboardShortcut(SHORTCUT_KEYS.hideExpandedSchemaClusters, () => {
    if (isExpandedSchemaViewActive && onToggleExpandedSchemaClusters) onToggleExpandedSchemaClusters();
  });

  const schemas = availableSchemas || [];
  const selectedSchemas = propSelectedSchemas || new Set(schemas);
  const currentGraphMode = graphMode ?? (isOverview ? 'overview' : 'full');
  const graphModeDisabledReason = schemaViewSoftDisabled
    ? `Schema View is optimised for larger databases (threshold: ${overviewThreshold} objects)`
    : !onGraphModeChange
      ? 'Schema View is disabled in settings'
      : !canSwitchGraphMode
        ? 'Exit current mode to switch views'
        : null;
  const viewModeTooltipLines = isExpandedSchemaViewActive
    ? [
        'View: Expanded Schema View',
        expandedSchemaStatusText(expandedSchemaCount),
        showExpandedSchemaClusters ? 'Schema clusters visible' : 'Schema clusters hidden',
      ]
    : currentGraphMode === 'overview'
      ? ['View: Schema View', 'Graph is shown as schema clusters. Double-click a schema cluster to expand it.']
      : ['View: Object View', 'Graph is shown as individual object nodes.'];

  // Render limit is the hard guard; overview threshold is only the initial-view hint.
  const limitRatio = renderLimit > 0 ? renderedNodeCount / renderLimit : 0;
  const metricColor = limitRatio >= 0.9
    ? 'var(--ln-validation-error-border)'
    : limitRatio >= 0.75
      ? 'var(--ln-warning-fg)'
      : undefined;

  const activeFilterCount = useMemo(() => [
    selectedSchemas.size < schemas.length && schemas.length > 0,
    types.size < 5,
    !showExternalRefs || externalRefTypes.size < 2,
    exclusionPatterns.length > 0,
  ].filter(Boolean).length, [selectedSchemas.size, schemas.length, types.size, showExternalRefs, externalRefTypes.size, exclusionPatterns.length]);

  return (
    <>
      <div className="ln-toolbar flex items-center gap-2 px-4 py-2.5">
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

        <div className="flex-1 min-w-[100px] max-w-[340px]">
          <SearchWithAutocomplete
            onExecuteSearch={onExecuteSearch}
            onStartTrace={canStartNewScopedMode ? onStartTrace : undefined}
            allNodes={allNodes}
            visibleNodeIds={visibleNodeIds}
            collapsedSchemaNodeIds={collapsedSchemaNodeIds}
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
        <Tooltip content={graphModeDisabledReason ?? 'Schema View (S)'}>
          <Button
            onClick={() => onGraphModeChange?.(currentGraphMode === 'overview' ? 'full' : 'overview')}
            variant="icon"
            className={currentGraphMode === 'overview' ? 'ln-btn-icon-active' : ''}
            disabled={!onGraphModeChange || !canSwitchGraphMode || schemaViewSoftDisabled}
            aria-label="Schema View"
            aria-pressed={currentGraphMode === 'overview'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 7.5h15v5.25h-15V7.5ZM7.5 15.75h3.75M12.75 15.75h3.75M9.375 12.75v3M14.625 12.75v3" />
            </svg>
          </Button>
        </Tooltip>
        <SchemaFilterDropdown schemas={schemas} selectedSchemas={selectedSchemas} focusSchemas={focusSchemas} onToggleSchema={onToggleSchema} onSelectAll={onSelectAllSchemas} onSelectNone={onSelectNoneSchemas} onToggleFocusSchema={onToggleFocusSchema} isNarrowed={selectedSchemas.size < schemas.length && schemas.length > 0} />
        <TypeFilterDropdown types={types} onToggleType={onToggleType} isNarrowed={types.size < 5} />
        {onToggleExternalRefs && onToggleExternalRefType && (
          <ExternalRefsDropdown
            showExternalRefs={showExternalRefs}
            externalRefTypes={externalRefTypes}
            onToggleMaster={onToggleExternalRefs}
            onToggleSubType={onToggleExternalRefType}
            isNarrowed={!showExternalRefs || externalRefTypes.size < 2}
          />
        )}
        <div className="relative inline-flex">
          <Tooltip content={activeFilterCount > 0 ? `Refresh View (${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active)` : 'Refresh View'}>
            <Button onClick={() => { onRefresh(); onResetExpandedSchemaView?.(); }} variant="icon" aria-label="Refresh View">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 17l5 5M22 17l-5 5" />
              </svg>
            </Button>
          </Tooltip>
          {activeFilterCount > 0 && (
            <span
              className="absolute -top-1 -right-1 flex items-center justify-center rounded-full pointer-events-none ln-counter-badge"
              aria-label={`${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active`}
            >
              {activeFilterCount}
            </span>
          )}
        </div>
        <div className="w-px h-6 ln-divider" />

        {/* Display Preferences (sticky — not cleared by Clear All) */}
        <Tooltip content={analysisType === 'orphans' ? 'Disabled during Orphan analysis' : 'Hide Isolated Nodes'}>
          <Button onClick={onToggleIsolated} variant="icon" className={hideIsolated ? 'ln-btn-icon-active' : ''} disabled={analysisType === 'orphans'} aria-label="Hide Isolated Nodes" aria-pressed={hideIsolated}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
            </svg>
          </Button>
        </Tooltip>
        {onAddExclusionPattern && onRemoveExclusionPattern && (
          <ExclusionDropdown
            exclusionPatterns={exclusionPatterns}
            onAddPattern={onAddExclusionPattern}
            onRemovePattern={onRemoveExclusionPattern}
          />
        )}

        <Tooltip content={!canStartNewScopedMode && !isAnalysisActive ? 'Exit current mode to start analysis' : 'Graph Analysis'}>
          <Button
            ref={analysis.refs.setReference}
            onClick={analysis.toggle}
            variant="icon"
            className={isAnalysisActive ? 'ln-btn-icon-active ln-btn-icon-active--analysis' : ''}
            disabled={!canStartNewScopedMode && !isAnalysisActive}
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
              role="menu"
              aria-label="Graph analysis tools"
              {...analysis.getFloatingProps()}
            >
              <div className="py-1">
                <button role="menuitem" className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('islands'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
                  Islands
                </button>
                <button role="menuitem" className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('hubs'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg>
                  Hubs
                </button>
                <button role="menuitem" className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('orphans'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                  Orphan Nodes
                </button>
                <button role="menuitem" className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('longest-path'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
                  Longest Path
                </button>
                <button role="menuitem" className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('cycles'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                  Cycles
                </button>
                <button role="menuitem" className="w-full text-left px-3 py-1.5 text-sm ln-list-item flex items-center gap-2" onClick={() => { analysis.close(); onOpenAnalysis?.('external-refs'); }}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                  External Refs
                </button>
              </div>
            </div>
          )}
        </FloatingPortal>

        <div className="w-px h-6 ln-divider" />

        {/* Tools: DDL Viewer, Refresh, Export */}
        <Tooltip content={hasHighlightedNode ? 'View DDL / SQL source for selected object' : 'View DDL / SQL source'}>
          <Button onClick={onOpenDdlViewer} variant="icon" aria-label="View DDL / SQL source" disabled={!onOpenDdlViewer}>
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

        <Tooltip content={isOverview ? 'Export Schema View as Draw.io' : 'Export as Draw.io'}>
          <Button onClick={onExportDrawio} variant="icon" aria-label="Export as Draw.io" disabled={!onExportDrawio}>
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

        {/* Compact Expanded Schema View controls — persistent in Schema View so the expand/collapse action is always reachable. */}
        {currentGraphMode === 'overview' && (onExpandAllSchemas || onResetExpandedSchemaView) && (
          <>
            <div className="w-px h-6 ln-divider" />
            {isExpandedSchemaViewActive && onToggleExpandedSchemaClusters && (
              <Tooltip content={[
                expandedSchemaStatusText(expandedSchemaCount),
                showExpandedSchemaClusters ? 'Schema clusters visible — hide (H)' : 'Schema clusters hidden — show (H)',
              ].join('\n')} multiline>
                <Button
                  onClick={onToggleExpandedSchemaClusters}
                  variant="icon"
                  className={!showExpandedSchemaClusters ? 'ln-btn-icon-active' : ''}
                  aria-label={showExpandedSchemaClusters ? 'Hide schema clusters' : 'Show schema clusters'}
                  aria-pressed={!showExpandedSchemaClusters}
                >
                  {showExpandedSchemaClusters ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12Z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58M9.1 5.52A8.96 8.96 0 0 1 12 5.25c6 0 9.75 6.75 9.75 6.75a16.6 16.6 0 0 1-3.02 3.69M6.35 7.35A17.28 17.28 0 0 0 2.25 12S6 18.75 12 18.75a9.2 9.2 0 0 0 4.1-.98" />
                    </svg>
                  )}
                </Button>
              </Tooltip>
            )}
            {isExpandedSchemaViewActive && onResetExpandedSchemaView ? (
              <Tooltip content={[
                expandedSchemaStatusText(expandedSchemaCount),
                showExpandedSchemaClusters ? 'Schema clusters visible' : 'Schema clusters hidden',
                'Collapse all expanded schemas and return to Schema View',
              ].join('\n')} multiline>
                <Button onClick={onResetExpandedSchemaView} variant="icon" aria-label="Collapse all schemas">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                  </svg>
                </Button>
              </Tooltip>
            ) : onExpandAllSchemas ? (
              <Tooltip content="Expand all schemas">
                <Button onClick={onExpandAllSchemas} variant="icon" aria-label="Expand all schemas">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  </svg>
                </Button>
              </Tooltip>
            ) : null}
          </>
        )}

        {/* Metrics — pushed to right. Shows the rendered-node count gauged toward the render limit,
            with a tick at the initial Schema View threshold. */}
        {metrics && (
          <>
            <div className="ml-auto w-px h-6 shrink-0 ln-divider" />
            <Tooltip content={buildMetricsTooltip(allNodes, metrics, renderedNodeCount, overviewThreshold, renderLimit, viewModeTooltipLines)} delay={400} multiline>
              <div
                className="shrink-0 flex items-center gap-2 pr-1 cursor-default select-none"
                aria-label={isExpandedSchemaViewActive
                  ? `Rendered ${renderedNodeCount}, filtered ${metrics.totalNodes}, total ${allNodes.length}`
                  : `${metrics.totalNodes} filtered nodes`}
              >
                <span className="text-xs ln-text-muted whitespace-nowrap tabular-nums flex items-baseline gap-1">
                  {isExpandedSchemaViewActive ? (
                    <>
                      <span className="font-medium" style={{ color: metricColor }}>{formatMetricCount(renderedNodeCount)}</span>
                      <span className="opacity-45">/</span>
                      <span className="font-medium">{formatMetricCount(metrics.totalNodes)}</span>
                      <span className="opacity-45">/</span>
                      <span>{formatMetricCount(allNodes.length)}</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium" style={{ color: metricColor }}>{formatMetricCount(metrics.totalNodes)}</span>
                      <span className="opacity-60">nodes</span>
                    </>
                  )}
                </span>
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
