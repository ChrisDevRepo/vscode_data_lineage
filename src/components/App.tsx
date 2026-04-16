import { useState, useCallback, useRef, useEffect, useTransition, useMemo } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { StartScreen } from './StartScreen';
import { CreateFlow } from './CreateFlow';
import { VisualizingScreen, type LoadingPhase } from './VisualizingScreen';
import { GraphCanvas } from './GraphCanvas';
import { NodeContextMenu } from './NodeContextMenu';
import { useGraphology } from '../hooks/useGraphology';
import { useOverviewMode } from '../hooks/useOverviewMode';
import { buildSchemaGraph } from '../engine/graphBuilder';
import { useInteractiveTrace } from '../hooks/useInteractiveTrace';
import { useDacpacLoader } from '../hooks/useDacpacLoader';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DatabaseModel, ObjectType, FilterState, ExtensionConfig, AnalysisMode, AnalysisType } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { runAnalysis, getNeighborSchemas } from '../engine/graphAnalysis';
import { filterBySchemas, applyExclusionPatterns } from '../engine/dacpacExtractor';
import { computeSchemas } from '../engine/modelBuilder';
import { escapeRegexLiteral } from '../utils/sql';
import type { Project, FilterProfile, DacpacConnection, DatabaseConnection, AIViewMetadata } from '../engine/projectStore';
import { createProject, addFilterProfile, deleteFilterProfile, serializeFilter, deserializeFilter } from '../engine/projectStore';

/** Transient AI view — shown as a preview before the user decides to save. */
interface AiPreview {
  name: string;
  nodeIds: Set<string>;
  aiMetadata: AIViewMetadata;
}

type AppView = 'start' | 'create' | 'visualizing' | 'graph';

const DACPAC_TIMEOUT_MS = 20_000;
const DB_TIMEOUT_MS = 60_000;
const MIN_SPINNER_MS = 1200;

/** Compute all schemas that have at least one edge connecting to a node in the target schema. */
function computeNeighborSchemas(model: DatabaseModel, schema: string): Set<string> {
  const focusNodeIds = new Set(model.nodes.filter(n => n.schema === schema).map(n => n.id));
  const nodeById = new Map(model.nodes.map(n => [n.id, n]));
  const neighborSchemas = new Set<string>([schema]);
  for (const e of model.edges) {
    if (focusNodeIds.has(e.source)) {
      const target = nodeById.get(e.target);
      if (target) neighborSchemas.add(target.schema);
    }
    if (focusNodeIds.has(e.target)) {
      const source = nodeById.get(e.source);
      if (source) neighborSchemas.add(source.schema);
    }
  }
  return neighborSchemas;
}

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  nodeName: string;
  schema: string;
  externalType?: 'et' | 'file' | 'db';
  externalUrl?: string;
  fullName?: string;
  objectType: ObjectType;
}

export function App() {
  const vscodeApi = useVsCode();
  const isAutoVisualize = document.body.dataset.autoVisualize === 'true';
  const [view, setView] = useState<AppView>(isAutoVisualize ? 'visualizing' : 'start');
  const [model, setModel] = useState<DatabaseModel | null>(null);
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [projects, setProjects] = useState<Project[]>([]);
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);
  const [lastWizardView, setLastWizardView] = useState<'main' | 'projects'>('main');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [loadingProjectId, setLoadingProjectId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // VisualizingScreen state
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>('load');
  const [loadingStats, setLoadingStats] = useState<string | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [startScreenMessage, setStartScreenMessage] = useState<string | null>(null);

  // Graph source name (for toolbar/export)
  const [sourceName, setSourceName] = useState<string | null>(isAutoVisualize ? 'AdventureWorks (demo)' : null);

  // Whether source is from database (for stats panel)


  const [filter, setFilter] = useState<FilterState>({
    schemas: new Set(),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set<'file' | 'db'>(['file', 'db']),
    exclusionPatterns: [],
  });

  const { flowNodes, flowEdges, graph, metrics, renderLimitHit, filteredCount, renderedSchemas, buildFromModel } = useGraphology();
  const { trace, tracedNodes, tracedEdges, traceGraph, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace, useFullModel, toggleUseFullModel, filteredOutCount: traceFilteredOutCount } =
    useInteractiveTrace(graph, flowNodes, flowEdges, config, model);

  // Allows callbacks defined before useOverviewMode to reset the auto-trigger guard.
  const overviewActionsRef = useRef<{ resetUserChoice: () => void }>({
    resetUserChoice: () => {},
  });

  const applyConfig = useCallback((cfg: ExtensionConfig) => {
    setConfig(cfg);
  }, []);

  const dacpacLoader = useDacpacLoader(applyConfig);
  const [, startTransition] = useTransition();

  const rebuild = useCallback(
    (m: DatabaseModel, f: FilterState, cfg?: ExtensionConfig, forceLayout = false): number => {
      // When forceLayout is true (overview→full drill-down), run synchronously to avoid
      // the race condition where graphMode changes before flowNodes are ready.
      if (forceLayout) {
        return buildFromModel(m, f, cfg || config, true);
      }
      startTransition(() => { buildFromModel(m, f, cfg || config, false); });
      return 0; // Count unavailable for deferred builds; callers requiring count use forceLayout
    },
    [buildFromModel, config]
  );

  const getResetFilter = (m: DatabaseModel): FilterState => ({
    schemas: new Set(m.schemas.map(s => s.name)),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set<'file' | 'db'>(['file', 'db']),
    exclusionPatterns: [],
  });

  // Transition from visualizing → graph
  const handleVisualize = useCallback(
    (dacpacModel: DatabaseModel, selectedSchemas: Set<string>) => {
      let trimmed = filterBySchemas(dacpacModel, selectedSchemas, Infinity);
      trimmed = applyExclusionPatterns(trimmed, config.excludePatterns, (msg) => {
        vscodeApi.postMessage({ type: 'error', error: msg });
      });
      trimmed = { ...trimmed, schemas: computeSchemas(trimmed.nodes) };

      setModel(trimmed);
      const f = getResetFilter(trimmed);
      setFilter(f);
      setActiveViewId(null);
      rebuild(trimmed, f, config);
      setLoadingPhase('generate');
    },
    [rebuild, config, vscodeApi]
  );

  // pendingVisualize / pendingAutoVisualize → triggers handleVisualize → then view→graph
  const prevModelRef = useRef<DatabaseModel | null>(null);
  useEffect(() => {
    if (!dacpacLoader.model || dacpacLoader.isLoading) return;

    if (dacpacLoader.pendingAutoVisualize) {
      // No view guard — auto-visualize fires from any state (sidebar demo, startup, button)

      setSourceName(dacpacLoader.fileName || 'Demo');
      setView('visualizing');
      setLoadingPhase('parse');
      handleVisualize(dacpacLoader.model, new Set(dacpacLoader.model.schemas.map(s => s.name)));
      // Panel restore: projects-list was sent before dacpac-model, so lastOpenedId is current.
      // Demo: isDemo=true → skip, demo has no project.
      if (!dacpacLoader.isDemo && lastOpenedId) setActiveProjectId(lastOpenedId);
      dacpacLoader.clearAutoVisualize();
    } else if (dacpacLoader.pendingVisualize) {
      if (view !== 'visualizing') return; // guard: ignore stale responses after cancel
      setLoadingPhase('parse');
      handleVisualize(dacpacLoader.model, dacpacLoader.selectedSchemas);
      dacpacLoader.clearPendingVisualize();
    }
  }, [
    view,
    dacpacLoader.pendingAutoVisualize, dacpacLoader.pendingVisualize,
    dacpacLoader.model, dacpacLoader.isLoading, dacpacLoader.selectedSchemas,
    dacpacLoader.fileName,
    handleVisualize, dacpacLoader.clearAutoVisualize, dacpacLoader.clearPendingVisualize,
  ]);

  // Record when visualizing starts — used for minimum dwell enforcement
  const visualizingEnteredAt = useRef<number>(0);
  useEffect(() => {
    if (view === 'visualizing') visualizingEnteredAt.current = Date.now();
  }, [view]);

  // After buildFromModel completes → delay transition to graph so spinner is readable
  useEffect(() => {
    if (view !== 'visualizing' || loadingPhase !== 'generate' || flowNodes.length === 0) return;
    const remaining = Math.max(0, MIN_SPINNER_MS - (Date.now() - visualizingEnteredAt.current));
    if (remaining <= 0) { setView('graph'); setLoadingError(null); return; }
    const t = setTimeout(() => { setView('graph'); setLoadingError(null); }, remaining);
    return () => clearTimeout(t);
  }, [view, loadingPhase, flowNodes.length]);

  // Watch for errors in visualizing phase
  useEffect(() => {
    if (view !== 'visualizing') return;
    if (dacpacLoader.status?.type === 'error') {
      setLoadingError(dacpacLoader.status.text);
    } else if (dacpacLoader.status?.type === 'success' && dacpacLoader.model) {
      setLoadingStats(dacpacLoader.status.text);
    }
  }, [view, dacpacLoader.status, dacpacLoader.model]);

  // Timeout protection: if view stays 'visualizing' with no progress, surface an error
  const visualizingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (view !== 'visualizing' || loadingError) {
      if (visualizingTimeoutRef.current) {
        clearTimeout(visualizingTimeoutRef.current);
        visualizingTimeoutRef.current = null;
      }
      return;
    }

    if (visualizingTimeoutRef.current) clearTimeout(visualizingTimeoutRef.current);

    const ms = dacpacLoader.loadingContext === 'database' ? DB_TIMEOUT_MS : DACPAC_TIMEOUT_MS;
    visualizingTimeoutRef.current = setTimeout(() => {
      const msg = loadingPhase === 'load'
        ? 'Loading timed out. The file or database did not respond in time.'
        : 'Processing timed out. The model may be too large.';
      setLoadingError(msg);
    }, ms);

    return () => {
      if (visualizingTimeoutRef.current) clearTimeout(visualizingTimeoutRef.current);
    };
  }, [view, loadingPhase, dacpacLoader.status, dacpacLoader.loadingContext, loadingError]);

  const prevConfigRef = useRef(config);
  useEffect(() => {
    if (prevConfigRef.current !== config && model && view === 'graph') {
      prevConfigRef.current = config;
      rebuild(model, filter, config);
    }
  }, [config, model, view, filter, rebuild]);

  // ── Navigation handlers ─────────────────────────────────────────────────────

  const handleCreateNew = useCallback(() => {
    dacpacLoader.resetToStart();
    setStartScreenMessage(null);
    setView('create');
  }, [dacpacLoader.resetToStart]);

  const handleOpenProject = useCallback((id: string) => {
    setLoadingProjectId(id);
    setLoadingPhase('load');
    setLoadingStats(null);
    setLoadingError(null);
    setActiveProjectId(id);
    setLastOpenedId(id);

    const project = projects.find(p => p.id === id);
    if (project) {
      setSourceName(project.name);
    }

    vscodeApi.postMessage({ type: 'save-wizard-view', view: 'projects' });
    dacpacLoader.loadProject(id);
    setView('visualizing');
  }, [projects, dacpacLoader.loadProject, vscodeApi]);

  const handleOpenLatest = useCallback(() => {
    if (!lastOpenedId) return;
    handleOpenProject(lastOpenedId);
  }, [lastOpenedId, handleOpenProject]);

  const handleDeleteProject = useCallback((id: string) => {
    // Optimistic: update state immediately
    setProjects(prev => prev.filter(p => p.id !== id));
    if (activeProjectId === id) setActiveProjectId(null);
    vscodeApi.postMessage({ type: 'delete-project', id });
  }, [activeProjectId, vscodeApi]);

  const handleDeleteAllProjects = useCallback(() => {
    setProjects([]);
    setActiveProjectId(null);
    // Extension host persists each deletion; send one message per project
    projects.forEach(p => vscodeApi.postMessage({ type: 'delete-project', id: p.id }));
  }, [projects, vscodeApi]);

  const handleDemoClick = useCallback(() => {
    setLoadingPhase('load');
    setLoadingStats(null);
    setLoadingError(null);
    setStartScreenMessage(null);
    setActiveProjectId(null);
    setSourceName('AdventureWorks (demo)');
    dacpacLoader.loadDemo();
    setView('visualizing');
  }, [dacpacLoader.loadDemo]);

  const handleBack = useCallback(() => {
    dacpacLoader.resetToStart();
    setView('start');
    clearTrace();
    setIsDetailOpen(false);
    setLoadingProjectId(null);
    setLoadingError(null);
    setStartScreenMessage(null);
    setActiveProjectId(null);
    setActiveViewId(null);
    // Re-request projects so the start screen always shows fresh data
    vscodeApi.postMessage({ type: 'request-projects' });
  }, [dacpacLoader.resetToStart, clearTrace, vscodeApi]);

  const handleCancelVisualizing = useCallback(() => {
    dacpacLoader.cancelLoading();
    setView('start');
    setLoadingProjectId(null);
    setLoadingError(null);
    setActiveProjectId(null);
  }, [dacpacLoader.cancelLoading]);

  const handleBackFromError = useCallback(() => {
    setStartScreenMessage(loadingError);
    dacpacLoader.resetToStart();
    setView('start');
    setLoadingProjectId(null);
    setLoadingError(null);
    setActiveProjectId(null);
  }, [loadingError, dacpacLoader.resetToStart]);

  // CreateFlow → Visualize clicked
  const handleCreateVisualize = useCallback((projectName: string, conn: DacpacConnection | DatabaseConnection | null) => {
    setLoadingPhase('load');
    setLoadingStats(null);
    setLoadingError(null);
    setSourceName(projectName);

    if (conn && conn.type === 'dacpac') {
      // Save project now (dacpac: we have the full connection)
      const project = createProject(projectName, conn);
      setActiveProjectId(project.id);

      vscodeApi.postMessage({ type: 'save-project', project });
      dacpacLoader.visualize(dacpacLoader.selectedSchemas, projectName);
    } else {
      // DB path: extension saves project after Phase 2 succeeds, sends back projects-list
      dacpacLoader.visualize(dacpacLoader.selectedSchemas, projectName);
    }

    setView('visualizing');
  }, [dacpacLoader.visualize, dacpacLoader.selectedSchemas, vscodeApi]);

  // ── Graph state ─────────────────────────────────────────────────────────────

  const [isRebuilding, setIsRebuilding] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [infoBarNodeId, setInfoBarNodeId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isDetailSearchOpen, setIsDetailSearchOpen] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode | null>(null);
  const pendingAnalysisRef = useRef<AnalysisType | null>(null);

  /** The currently active advanced bookmark profile (allowlist-based view). */
  const [activeAdvancedProfile, setActiveAdvancedProfile] = useState<FilterProfile | null>(null);
  /** Transient AI preview — shown before user decides to save as bookmark. */
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null);
  /** Saved filter state before entering any locked mode (trace/analysis/bookmark) — restored on exit. */
  const preModFilterRef = useRef<FilterState | null>(null);
  /** Saved node positions from a bookmark — applied once after rebuild, then cleared. */
  const [pendingPositions, setPendingPositions] = useState<Record<string, { x: number; y: number }> | undefined>(undefined);
  const [pendingViewport, setPendingViewport] = useState<{ x: number; y: number; zoom: number } | undefined>(undefined);

  /** Names of allowlist node IDs no longer present in the model (stale objects). */
  const bookmarkStaleNames = useMemo(() => {
    if (!activeAdvancedProfile || !model) return [];
    const ids = activeAdvancedProfile.filter.allowlistNodeIds ?? [];
    return ids
      .filter(id => !model.catalog[id])
      .map(id => id.split('.').pop()?.replace(/[\[\]]/g, '') ?? id);
  }, [activeAdvancedProfile, model]);

  /** True when any locked mode (trace/analysis/advanced-bookmark/ai-preview) is active. */
  const isModeLocked = (
    trace.mode === 'applied' || trace.mode === 'path-applied' || trace.mode === 'filtered' ||
    !!analysisMode ||
    !!activeAdvancedProfile ||
    !!aiPreview
  );

  // ── Mode-lock filter save/restore ─────────────────────────────────────────
  // Refs to access current values inside the effect without re-firing on every change
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const modelRef = useRef(model);
  modelRef.current = model;
  const configRef = useRef(config);
  configRef.current = config;
  const rebuildRef = useRef(rebuild);
  rebuildRef.current = rebuild;
  const prevIsModeLocked = useRef(false);

  useEffect(() => {
    const entering = isModeLocked && !prevIsModeLocked.current;
    const leaving = !isModeLocked && prevIsModeLocked.current;
    prevIsModeLocked.current = isModeLocked;

    if (entering && !preModFilterRef.current) {
      preModFilterRef.current = filterRef.current;
    } else if (leaving) {
      const saved = preModFilterRef.current;
      preModFilterRef.current = null;
      if (saved && modelRef.current) {
        setFilter(saved);
        rebuildRef.current(modelRef.current, saved, configRef.current);
      }
    }
  }, [isModeLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(() => {
    if (model) {
      overviewActionsRef.current.resetUserChoice();
      clearTrace(() => {
        const f = {
          ...getResetFilter(model),
          hideIsolated: filter.hideIsolated,
          exclusionPatterns: filter.exclusionPatterns,
        };
        setFilter(f);
        rebuild(model, f, config);
      });
    }
  }, [model, config, rebuild, clearTrace, filter.hideIsolated, filter.exclusionPatterns]);

  const handleResetAll = useCallback(() => {
    if (model) {
      overviewActionsRef.current.resetUserChoice();
      const f = getResetFilter(model);
      setFilter(f);
      clearTrace(() => {
        rebuild(model, f, config);
      });
    }
  }, [model, config, rebuild, clearTrace]);

  const rebuildStartRef = useRef(0);
  const handleRebuild = useCallback(() => {
    if (model) {
      setIsRebuilding(true);
      rebuildStartRef.current = Date.now();
    }
    vscodeApi.postMessage({ type: 'rebuild' });
  }, [vscodeApi, model]);

  // ── Derived state: effective graph and nodes matching what's rendered ──────
  // When trace synthesizes out-of-filter nodes, the graphology graph and node set
  // must include those nodes for interactions (neighbors, context menu, delete).
  const isTraceActive = trace.mode === 'applied' || trace.mode === 'path-applied'
    || trace.mode === 'filtered' || trace.mode === 'analysis';

  const effectiveGraph = useMemo(
    () => (isTraceActive && traceGraph) ? traceGraph : graph,
    [isTraceActive, traceGraph, graph]
  );

  const effectiveNodes = useMemo(
    () => isTraceActive ? tracedNodes : flowNodes,
    [isTraceActive, tracedNodes, flowNodes]
  );

  // Clear stale highlight when the referenced node is removed by a filter change.
  // Uses effectiveNodes (not flowNodes) so synthesized out-of-filter nodes in
  // trace/path mode are recognized and don't get their highlight immediately cleared.
  useEffect(() => {
    if (highlightedNodeId && effectiveNodes.length > 0 && !effectiveNodes.some(n => n.id === highlightedNodeId)) {
      setHighlightedNodeId(null);
    }
  }, [highlightedNodeId, effectiveNodes]);

  const handleNodeClick = useCallback(
    (nodeId: string, findQuery?: string) => {
      const toggled = highlightedNodeId === nodeId ? null : nodeId;
      setHighlightedNodeId(toggled);
      setInfoBarNodeId(prev => prev !== null ? toggled : null);

      const node = model?.nodes.find(n => n.id === nodeId);
      if (!node) {
        window.vscode?.postMessage({ type: 'log', text: `[Bridge] handleNodeClick: "${nodeId}" not in model (${model?.nodes.length ?? 0} nodes)` });
        return;
      }
      if (isDetailOpen) {
        vscodeApi.postMessage({ type: 'update-detail', node, findQuery });
      } else if (findQuery) {
        // DetailSearchSidebar result clicked — open panel with search term
        vscodeApi.postMessage({ type: 'show-detail', node, findQuery });
        setIsDetailOpen(true);
      }
    },
    [model, vscodeApi, isDetailOpen, highlightedNodeId]
  );

  const handleTraceApply = useCallback((config: { upstreamLevels: number; downstreamLevels: number }) => {
    applyTrace(config.upstreamLevels, config.downstreamLevels);
  }, [applyTrace]);

  const handleNodeContextMenu = useCallback(
    (nodeId: string, x: number, y: number) => {
      const node = effectiveNodes.find((n) => n.id === nodeId);
      if (!node) return;
      setContextMenu({
        x: Math.min(x, window.innerWidth - 200),
        y: Math.min(y, window.innerHeight - 250),
        nodeId,
        nodeName: String(node.data.label),
        schema: String(node.data.schema),
        objectType: node.data.objectType as ObjectType,
        externalType: node.data.externalType,
        externalUrl: node.data.externalUrl,
        fullName: String(node.data.fullName),
      });
    },
    [effectiveNodes]
  );

  const handleViewDdl = useCallback(
    (nodeId: string) => {
      const node = model?.nodes.find(n => n.id === nodeId);
      if (!node) return;
      vscodeApi.postMessage({ type: 'show-detail', node });
      setIsDetailOpen(true);
    },
    [model, vscodeApi]
  );

  const handleToggleType = useCallback(
    (type: ObjectType) => {
      setFilter((prev) => {
        const types = new Set(prev.types);
        if (types.has(type)) types.delete(type);
        else types.add(type);
        const next = { ...prev, types };
        if (model) rebuild(model, next, config);
        return next;
      });
    },
    [model, config, rebuild]
  );

  // searchTerm is now local to SearchWithAutocomplete — no longer part of filter state.
  // Keystrokes only re-render the search component, not the entire App/GraphCanvas tree.

  const handleToggleIsolated = useCallback(() => {
    setFilter((prev) => {
      const next = { ...prev, hideIsolated: !prev.hideIsolated };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  /** Unified star-schema handler. All three entry points (star button, overview double-click,
   *  quick jump) route through this single function.
   *  @param schema  Target schema, or null to unfocus.
   *  @param options.toggle  If true, unfocus if already focused (star button behavior).
   *  @param options.forceLayout  Bypass Guard 2 (overview→full drill-down).
   *  @param options.includeNeighbors  If false, only include the target schema (fallback).
   *  @returns Post-filter node count (0 when model is absent).
   *  NOTE: Uses `{ ...filter }` spread (not functional setFilter updater) because we need
   *  the synchronous count from rebuild() before calling setFilter. `filter` is in deps
   *  so the closure is always current, but this does cause re-creation on every filter change. */
  const applyStarSchema = useCallback((
    schema: string | null,
    options: { toggle?: boolean; forceLayout?: boolean; includeNeighbors?: boolean } = {}
  ): number => {
    const { toggle = false, forceLayout = false, includeNeighbors = true } = options;
    if (!model) return 0;

    // Unfocus: clear star, show all schemas
    if (schema === null || (toggle && filter.focusSchemas.has(schema))) {
      const allSchemas = new Set(model.schemas.map(s => s.name));
      const next = { ...filter, focusSchemas: new Set<string>(), schemas: allSchemas };
      const count = rebuild(model, next, config, forceLayout);
      setFilter(next);
      return count;
    }

    // Focus: compute neighbor schemas, set filter
    const schemas = includeNeighbors
      ? computeNeighborSchemas(model, schema)
      : new Set<string>([schema]);
    const next = { ...filter, focusSchemas: includeNeighbors ? new Set([schema]) : new Set<string>(), schemas };
    window.vscode?.postMessage({ type: 'log', text: `[Filter] applyStarSchema: schema="${schema}", schemas=[${[...schemas].join(',')}], forceLayout=${forceLayout}` });
    const count = rebuild(model, next, config, forceLayout);
    setFilter(next);
    return count;
  }, [model, config, rebuild, filter]);

  // Star button in schema dropdown (toggle behavior)
  const handleToggleFocusSchema = useCallback(
    (schema: string) => { applyStarSchema(schema, { toggle: true }); },
    [applyStarSchema]
  );

  // ── Overview mode (schema-level view) ───────────────────────────────────────

  const schemasKey = useMemo(() => [...filter.schemas].sort().join(','), [filter.schemas]);

  const { graphMode, enteredFocusFromOverview, toggleMode, enterFocusFromOverview, resetUserChoice } = useOverviewMode({
    model,
    filteredCount,
    config,
    schemasKey,
    onSetFocusSchemaOnly: (schema, forceLayout) => applyStarSchema(schema, { forceLayout, includeNeighbors: false }),
  });

  // Populate ref so handleRefresh/handleResetAll (defined earlier) can reset the guard.
  overviewActionsRef.current.resetUserChoice = resetUserChoice;

  // Schema-level nodes/edges — computed once when model/filter.schemas change
  const { schemaNodes, schemaEdges } = useMemo(() => {
    if (!model) return { schemaNodes: [], schemaEdges: [] };
    const visibleSchemas = filter.schemas.size > 0 ? filter.schemas : new Set(model.schemas.map(s => s.name));
    const { nodes, edges } = buildSchemaGraph(model, visibleSchemas);
    return { schemaNodes: nodes, schemaEdges: edges };
  }, [model, filter.schemas]);

  const handleToggleExternalRefs = useCallback(() => {
    setFilter((prev) => {
      const next = { ...prev, showExternalRefs: !prev.showExternalRefs };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleToggleExternalRefType = useCallback((subType: 'file' | 'db') => {
    setFilter((prev) => {
      const externalRefTypes = new Set(prev.externalRefTypes);
      if (externalRefTypes.has(subType)) externalRefTypes.delete(subType);
      else externalRefTypes.add(subType);
      const next = { ...prev, externalRefTypes };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleAddExclusionPattern = useCallback((pattern: string) => {
    setFilter((prev) => {
      if (prev.exclusionPatterns.includes(pattern)) return prev;
      const exclusionPatterns = [...prev.exclusionPatterns, pattern];
      const next = { ...prev, exclusionPatterns };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleRemoveExclusionPattern = useCallback((pattern: string) => {
    setFilter((prev) => {
      const exclusionPatterns = prev.exclusionPatterns.filter(p => p !== pattern);
      const next = { ...prev, exclusionPatterns };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleToggleSchema = useCallback((schema: string) => {
    setFilter((prev) => {
      const schemas = new Set(prev.schemas);
      if (schemas.has(schema)) {
        schemas.delete(schema);
      } else {
        schemas.add(schema);
      }
      // User is manually managing schemas — clear the star focus lock so all
      // selected schemas show. Star button can still be used independently.
      const next = { ...prev, schemas, focusSchemas: new Set<string>() };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleSelectAllSchemas = useCallback((schemas: string[]) => {
    setFilter((prev) => {
      const next = { ...prev, schemas: new Set([...prev.schemas, ...schemas]), focusSchemas: new Set<string>() };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleSelectNoneSchemas = useCallback((schemas: string[]) => {
    setFilter((prev) => {
      const nextSchemas = new Set(prev.schemas);
      for (const s of schemas) nextSchemas.delete(s);
      const next = { ...prev, schemas: nextSchemas, focusSchemas: new Set<string>() };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const openAnalysis = useCallback((type: AnalysisType) => {
    endTrace();
    setIsDetailSearchOpen(false);
    setHighlightedNodeId(null);
    setInfoBarNodeId(null);

    const currentFilter = filterRef.current;
    if (type === 'orphans' && currentFilter.hideIsolated) {
      // Pre-save filter (with hideIsolated: true) before we change it,
      // so the mode-lock useEffect restores the correct value on exit.
      // When switching from another analysis type, preModFilterRef is already set — don't overwrite it.
      if (!preModFilterRef.current) preModFilterRef.current = currentFilter;
      const nextFilter = { ...currentFilter, hideIsolated: false };
      setFilter(nextFilter);
      pendingAnalysisRef.current = 'orphans';
      if (model) buildFromModel(model, nextFilter, config);
      return;
    }

    if (graph) {
      const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
      const totalNodes = result.groups.reduce((sum, g) => sum + g.nodeIds.length, 0);
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Analysis run: type="${type}" → ${result.groups.length} groups, ${totalNodes} total nodes` });
      setAnalysisMode({ type, result, activeGroupId: null });
    }
  }, [endTrace, model, graph, config, buildFromModel]);

  useEffect(() => {
    if (pendingAnalysisRef.current && graph) {
      const type = pendingAnalysisRef.current;
      pendingAnalysisRef.current = null;
      const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
      const totalNodes = result.groups.reduce((sum, g) => sum + g.nodeIds.length, 0);
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Analysis pending applied: type="${type}" → ${result.groups.length} groups, ${totalNodes} total nodes` });
      setAnalysisMode({ type, result, activeGroupId: null });
    }
  }, [graph, config.analysis, config.maxNodes]);

  // DELETE key on a highlighted node → add exact exclusion rule
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!highlightedNodeId) return;
      const node = effectiveNodes.find((n) => n.id === highlightedNodeId);
      if (!node) return;
      const pattern = `^${escapeRegexLiteral(String(node.data.schema))}\\.${escapeRegexLiteral(String(node.data.label))}$`;
      handleAddExclusionPattern(pattern);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [highlightedNodeId, effectiveNodes, handleAddExclusionPattern]);

  const closeAnalysis = useCallback(() => {
    // Filter restore is handled by the isModeLocked useEffect when analysisMode → null
    endTrace();
    setAnalysisMode(null);
  }, [endTrace]);

  const selectAnalysisGroup = useCallback((groupId: string) => {
    if (!analysisMode || !graph) return;
    const group = analysisMode.result.groups.find(g => g.id === groupId);
    if (!group) return;

    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Group selected: ${groupId} — ${group.nodeIds.length} nodeIds, flowNodes: ${flowNodes.length}`
    });

    setAnalysisMode(prev => prev ? { ...prev, activeGroupId: groupId } : null);

    const nodeIdSet = new Set(group.nodeIds);
    if (analysisMode.type === 'hubs') {
      for (const hubId of group.nodeIds) {
        if (graph.hasNode(hubId)) {
          graph.forEachNeighbor(hubId, (neighbor) => nodeIdSet.add(neighbor));
        }
      }
    }

    const edgeIds = new Set<string>();
    if (analysisMode.type === 'longest-path') {
      for (let i = 0; i < group.nodeIds.length - 1; i++) {
        const edge = graph.edge(group.nodeIds[i], group.nodeIds[i + 1]);
        if (edge) edgeIds.add(edge);
      }
    } else {
      graph.forEachEdge((edge, _attrs, source, target) => {
        if (nodeIdSet.has(source) && nodeIdSet.has(target)) {
          edgeIds.add(edge);
        }
      });
    }

    const originId = analysisMode.type === 'hubs' ? group.nodeIds[0]
      : analysisMode.type === 'longest-path' ? group.nodeIds[0]
      : undefined;

    applyAnalysisSubset(nodeIdSet, edgeIds, originId, analysisMode.type);
  }, [analysisMode, graph, flowNodes.length, applyAnalysisSubset]);

  const clearAnalysisGroup = useCallback(() => {
    if (!analysisMode) return;
    setAnalysisMode(prev => prev ? { ...prev, activeGroupId: null } : null);
    endTrace();
  }, [analysisMode, endTrace]);

  const handleDiscardAiPreview = useCallback(() => {
    setAiPreview(null);
    // Mode-lock restore triggers automatically via isModeLocked → false
  }, []);

  const handleExitAdvancedBookmark = useCallback(() => {
    // Filter restore is handled by the isModeLocked useEffect when activeAdvancedProfile → null
    setActiveAdvancedProfile(null);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (aiPreview) {
          handleDiscardAiPreview();
        } else if (activeAdvancedProfile) {
          handleExitAdvancedBookmark();
        } else if (analysisMode) {
          if (analysisMode.activeGroupId) clearAnalysisGroup();
          else closeAnalysis();
        } else if (trace.mode !== 'none') {
          endTrace();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [trace.mode, endTrace, analysisMode, closeAnalysis, clearAnalysisGroup, aiPreview, handleDiscardAiPreview, activeAdvancedProfile, handleExitAdvancedBookmark]);

  const handleApplyView = useCallback((profile: FilterProfile) => {
    overviewActionsRef.current.resetUserChoice();
    setActiveViewId(profile.id);
    const isAdvanced = (profile.filter.allowlistNodeIds?.length ?? 0) > 0;
    if (profile.positions && Object.keys(profile.positions).length > 0) {
      setPendingPositions(profile.positions);
      setPendingViewport(profile.viewport);
    }
    if (isAdvanced) {
      // Explicitly save filter NOW (before state changes) so the mode-lock useEffect finds it set
      if (!preModFilterRef.current) preModFilterRef.current = filter;
      const restored = deserializeFilter(profile.filter);
      // Override schemas/types to "all" so the allowlist is not pre-filtered out
      if (model) restored.schemas = new Set(model.schemas.map(s => s.name));
      restored.types = new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']);
      setFilter(restored);
      setActiveAdvancedProfile(profile);
      if (model) rebuild(model, restored, config);
    } else {
      const restored = deserializeFilter(profile.filter);
      setFilter(restored);
      if (model) rebuild(model, restored, config);
    }
  }, [model, config, filter, rebuild]);

  // ── Message handler (stats + projects-list) ─────────────────────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'detail-closed') {
        setIsDetailOpen(false);
      } else if (msg?.type === 'auto-visualize-start') {
        setSourceName('AdventureWorks (demo)');
        setLoadingPhase('load');
        setLoadingStats(null);
        setLoadingError(null);
        setActiveProjectId(null);
        setView('visualizing');
      } else if (msg?.type === 'toggle-overview') {
        toggleMode();
      } else if (msg?.type === 'projects-list') {
        const updatedProjects: Project[] = msg.projects ?? [];
        setProjects(updatedProjects);
        setLastOpenedId(msg.lastOpenedId ?? null);
        if (msg.lastWizardView) setLastWizardView(msg.lastWizardView);
        setLoadingProjectId(null);
        // When extension saves a DB project after Phase 2, set activeProjectId
        if (view === 'visualizing' && msg.lastOpenedId) {
          setActiveProjectId(msg.lastOpenedId);
        }
      } else if (msg?.type === 'rebuild-config') {
        // Fresh config from extension host — apply and rebuild graph with new settings
        if (msg.config) {
          const merged: ExtensionConfig = {
            ...DEFAULT_CONFIG,
            ...msg.config,
            layout: { ...DEFAULT_CONFIG.layout, ...msg.config.layout },
            trace: { ...DEFAULT_CONFIG.trace, ...msg.config.trace },
            analysis: { ...DEFAULT_CONFIG.analysis, ...msg.config.analysis },
          };
          setConfig(merged);
          if (modelRef.current && rebuildRef.current) {
            rebuildRef.current(modelRef.current, filterRef.current, merged);
          }
        }
        // Ensure spinner shows for at least 2s so user sees visual feedback
        const elapsed = Date.now() - rebuildStartRef.current;
        const MIN_REBUILD_SPINNER_MS = 2000;
        if (elapsed >= MIN_REBUILD_SPINNER_MS) {
          setIsRebuilding(false);
        } else {
          setTimeout(() => setIsRebuilding(false), MIN_REBUILD_SPINNER_MS - elapsed);
        }
      } else if (msg?.type === 'ai-view-preview') {
        // AI created a transient view — show as preview, user decides whether to save
        const preview: AiPreview = {
          name: msg.name,
          nodeIds: new Set<string>(msg.nodeIds),
          aiMetadata: msg.aiMetadata,
        };
        // Save current filter before entering mode-lock
        if (!preModFilterRef.current) preModFilterRef.current = filterRef.current;
        // Set allowlist filter so graph shows only preview nodes
        const allowlist = preview.nodeIds;
        setFilter(prev => {
          const next: FilterState = {
            ...prev,
            allowlistNodeIds: allowlist,
            // Override schemas/types to "all" so allowlist is not pre-filtered
            schemas: modelRef.current ? new Set(modelRef.current.schemas.map(s => s.name)) : prev.schemas,
            types: new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']),
          };
          if (modelRef.current) rebuildRef.current(modelRef.current, next, configRef.current);
          return next;
        });
        setAiPreview(preview);
        overviewActionsRef.current.resetUserChoice();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [view, toggleMode, handleApplyView]);

  // Notify extension when graphMode changes so it can update the status bar
  useEffect(() => {
    if (view === 'graph') {
      vscodeApi.postMessage({ type: 'overview-mode-changed', mode: graphMode, enteredFocusFromOverview });
    }
  }, [graphMode, enteredFocusFromOverview, view, vscodeApi]);

  // When user manually toggles overview→full (not via search drill-down) and dagre was skipped
  // (Guard 2), trigger a full rebuild so dagre positions are computed.
  // Skipped when enteredFocusFromOverview=true — that path already rebuilds with forceLayout=true.
  const prevGraphModeRef = useRef(graphMode);
  useEffect(() => {
    const wasOverview = prevGraphModeRef.current === 'overview';
    prevGraphModeRef.current = graphMode;
    if (wasOverview && graphMode === 'full' && !enteredFocusFromOverview &&
        modelRef.current && filteredCount > configRef.current.overview.threshold) {
      window.vscode?.postMessage({ type: 'log', text: `[Filter] Mode switch rebuild: overview→full, ${filteredCount} nodes > threshold=${configRef.current.overview.threshold}, forceLayout=true` });
      rebuildRef.current(modelRef.current, filterRef.current, configRef.current, true);
    }
  }, [graphMode, enteredFocusFromOverview, filteredCount]);

  // ── Saved Views ─────────────────────────────────────────────────────────────

  const activeProject = projects.find(p => p.id === activeProjectId);
  const filterProfiles = activeProject?.filterProfiles ?? [];

  // Sync active filter state to extension host so AI tools (search_objects, start_exploration etc.)
  // can report filter context correctly. Fires on structural filter changes and initial model load.
  // Excludes searchTerm — it's client-only (autocomplete) and would spam filter-changed on every keystroke.
  const filterKeyForHost = useMemo(() => {
    const { searchTerm: _, ...rest } = serializeFilter(filter);
    return JSON.stringify(rest);
  }, [filter]);
  useEffect(() => {
    if (!model) return;
    const { searchTerm: _, ...filterForHost } = serializeFilter(filter);
    vscodeApi.postMessage({ type: 'filter-changed', filter: filterForHost, savedViews: filterProfiles, filteredCount, renderLimitHit });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKeyForHost, filterProfiles, model, vscodeApi]);

  const isViewModified = useMemo(() => {
    if (!activeViewId) return false;
    const profile = filterProfiles.find(p => p.id === activeViewId);
    if (!profile) return false;
    return JSON.stringify(serializeFilter(filter)) !== JSON.stringify(profile.filter);
  }, [activeViewId, filterProfiles, filter]);

  const isFilterDirty = useMemo(() => {
    if (!model) return false;
    if (activeViewId && !isViewModified) return false;
    const clean = getResetFilter(model);
    return JSON.stringify(serializeFilter(filter)) !== JSON.stringify(serializeFilter(clean));
  }, [model, filter, activeViewId, isViewModified]);

  const persistFilterProfile = useCallback((
    profile: FilterProfile,
    options?: { 
      clearAiPreview?: boolean, 
      activateProfile?: boolean 
    }
  ) => {
    if (!activeProjectId) return;

    // Optimistic update
    setProjects(prev => {
      const store = { schemaVersion: 1 as const, projects: prev, lastOpenedId };
      return addFilterProfile(store, activeProjectId, profile).projects;
    });

    vscodeApi.postMessage({ type: 'save-view', projectId: activeProjectId, profile });

    if (options?.clearAiPreview) setAiPreview(null);
    if (options?.activateProfile) {
      if ((profile.filter.allowlistNodeIds?.length ?? 0) > 0) {
        setActiveAdvancedProfile(profile);
      }
      setActiveViewId(profile.id);
    }
  }, [activeProjectId, lastOpenedId, vscodeApi]);

  const handleSaveView = useCallback((name: string) => {
    if (!activeProjectId) {
      vscodeApi.postMessage({ type: 'log', text: '[SaveView] No active project — view not saved' });
      return;
    }
    const profile: FilterProfile = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      filter: serializeFilter(filter),
    };
    persistFilterProfile(profile, { activateProfile: true });
  }, [activeProjectId, filter, persistFilterProfile, vscodeApi]);

  const handleUpdateView = useCallback((profileId: string) => {
    if (!activeProjectId) return;
    const existing = filterProfiles.find(p => p.id === profileId);
    if (!existing) return;

    const updated: FilterProfile = {
      ...existing,
      filter: serializeFilter(filter),
    };
    persistFilterProfile(updated);
  }, [activeProjectId, filter, filterProfiles, persistFilterProfile]);

  const handleSaveTraceAsBookmark = useCallback((
    name: string,
    nodeIds: string[],
    source: 'trace' | 'path',
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
  ) => {
    const profile: FilterProfile = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      source: source === 'path' ? 'trace' : source,
      filter: {
        ...serializeFilter(filter),
        allowlistNodeIds: nodeIds,
      },
      ...(positions ? { positions } : {}),
      ...(viewport ? { viewport } : {}),
    };
    persistFilterProfile(profile, { activateProfile: true });
  }, [filter, persistFilterProfile]);

  const handleSaveAnalysisBookmark = useCallback((
    name: string,
    nodeIds: string[],
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
  ) => {
    const profile: FilterProfile = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      source: 'analysis',
      filter: {
        ...serializeFilter(filter),
        allowlistNodeIds: nodeIds,
      },
      ...(positions ? { positions } : {}),
      ...(viewport ? { viewport } : {}),
    };
    persistFilterProfile(profile, { activateProfile: true });
  }, [filter, persistFilterProfile]);

  const handleSaveAiBookmark = useCallback((
    name: string,
    withPositions: boolean,
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
  ) => {
    if (!aiPreview) return;
    const profile: FilterProfile = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      source: 'ai',
      filter: {
        ...serializeFilter(filter),
        allowlistNodeIds: Array.from(aiPreview.nodeIds),
      },
      aiMetadata: aiPreview.aiMetadata,
      ...(withPositions && positions ? { positions } : {}),
      ...(withPositions && viewport ? { viewport } : {}),
    };
    persistFilterProfile(profile, { clearAiPreview: true, activateProfile: true });
  }, [filter, aiPreview, persistFilterProfile]);

  const handleDeleteView = useCallback((profileId: string) => {
    if (!activeProjectId) return;
    if (activeViewId === profileId) setActiveViewId(null);
    // Optimistic update
    setProjects(prev => {
      const store = { schemaVersion: 1 as const, projects: prev, lastOpenedId };
      return deleteFilterProfile(store, activeProjectId, profileId).projects;
    });
    vscodeApi.postMessage({ type: 'delete-view', projectId: activeProjectId, profileId });
  }, [activeProjectId, activeViewId, lastOpenedId, vscodeApi]);

  // Object-level IDs that passed all filters — authoritative for search visibility in overview mode.
  // Must be above early returns to satisfy Rules of Hooks.
  const filteredObjectIds = useMemo(() => new Set(flowNodes.map(n => n.id)), [flowNodes]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const handleWizardViewChange = useCallback((v: 'main' | 'projects') => {
    vscodeApi.postMessage({ type: 'save-wizard-view', view: v });
  }, [vscodeApi]);

  if (view === 'start') {
    return (
      <StartScreen
        projects={projects}
        lastOpenedId={lastOpenedId}
        initialShowProjects={lastWizardView === 'projects'}
        loadingProjectId={loadingProjectId}
        startMessage={startScreenMessage}
        onCreateNew={handleCreateNew}
        onOpenProject={handleOpenProject}
        onOpenLatest={handleOpenLatest}
        onDeleteProject={handleDeleteProject}
        onDeleteAllProjects={handleDeleteAllProjects}
        onDemo={handleDemoClick}
        onWizardViewChange={handleWizardViewChange}
      />
    );
  }

  if (view === 'create') {
    return (
      <CreateFlow
        loader={dacpacLoader}
        maxNodes={config.maxNodes}
        onBack={() => { dacpacLoader.resetToStart(); setView('start'); }}
        onVisualize={handleCreateVisualize}
      />
    );
  }

  if (view === 'visualizing') {
    return (
      <VisualizingScreen
        sourceName={sourceName ?? '…'}
        phase={loadingPhase}
        progressText={dacpacLoader.status?.type === 'info' ? dacpacLoader.status.text : null}
        stats={loadingStats}
        error={loadingError}
        onCancel={handleCancelVisualizing}
        onBack={handleBackFromError}
      />
    );
  }

  if (renderLimitHit > 0 && graphMode !== 'overview') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8 max-w-md" style={{ color: 'var(--ln-fg)' }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Render limit reached</div>
          <div style={{ fontSize: 13, color: 'var(--ln-fg-muted)' }}>
            The current filter selects {renderLimitHit.toLocaleString()} nodes (limit: {config.renderLimit.toLocaleString()}).
            Select schema or type filters to reduce scope, or adjust the render limit in settings.
          </div>
        </div>
      </div>
    );
  }

  const renderNodes = isTraceActive ? tracedNodes : (graphMode === 'overview' ? schemaNodes : flowNodes);
  const renderEdges = isTraceActive ? tracedEdges : (graphMode === 'overview' ? schemaEdges : flowEdges);

  return (
    <ReactFlowProvider>
      <GraphCanvas
        flowNodes={renderNodes}
        flowEdges={renderEdges}
        graphMode={graphMode}
        filteredObjectIds={filteredObjectIds}
        onSchemaNodeDoubleClick={enterFocusFromOverview}
        trace={trace}
        filter={filter}
        metrics={metrics}
        highlightedNodeId={highlightedNodeId}
        graph={effectiveGraph}
        config={config}
        model={model}
        infoBarNodeId={infoBarNodeId}
        onCloseInfoBar={() => setInfoBarNodeId(null)}
        isDetailSearchOpen={isDetailSearchOpen}
        onToggleDetailSearch={() => setIsDetailSearchOpen(prev => !prev)}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onStartTraceImmediate={startTraceImmediate}
        onTraceApply={handleTraceApply}
        onTraceEnd={endTrace}
        onResetAll={handleResetAll}
        onToggleType={handleToggleType}
        onToggleIsolated={handleToggleIsolated}
        onToggleFocusSchema={handleToggleFocusSchema}
        onToggleSchema={handleToggleSchema}
        onSelectAllSchemas={handleSelectAllSchemas}
        onSelectNoneSchemas={handleSelectNoneSchemas}
        onToggleExternalRefs={handleToggleExternalRefs}
        onToggleExternalRefType={handleToggleExternalRefType}
        exclusionPatterns={filter.exclusionPatterns}
        onAddExclusionPattern={handleAddExclusionPattern}
        onRemoveExclusionPattern={handleRemoveExclusionPattern}
        availableSchemas={model?.schemas.map(s => s.name) || []}
        renderedSchemas={renderedSchemas}
        analysisMode={analysisMode}
        onOpenAnalysis={openAnalysis}
        onCloseAnalysis={closeAnalysis}
        onSelectAnalysisGroup={selectAnalysisGroup}
        onClearAnalysisGroup={clearAnalysisGroup}
        onApplyPath={applyPath}
        isRebuilding={isRebuilding}
        onRefresh={handleRefresh}
        onRebuild={handleRebuild}
        onBack={handleBack}
        sourceName={sourceName ?? dacpacLoader.fileName ?? undefined}
        filterProfiles={filterProfiles}
        activeProjectId={activeProjectId}
        activeViewId={activeViewId}
        isViewModified={isViewModified}
        onSaveView={handleSaveView}
        onApplyView={handleApplyView}
        onDeleteView={handleDeleteView}
        onUpdateView={handleUpdateView}
        isFilterDirty={isFilterDirty}
        isModeLocked={isModeLocked}
        onSaveTraceBookmark={activeProjectId ? handleSaveTraceAsBookmark : undefined}
        onSaveAnalysisBookmark={activeProjectId ? handleSaveAnalysisBookmark : undefined}
        aiPreview={aiPreview}
        onSaveAiBookmark={activeProjectId ? handleSaveAiBookmark : undefined}
        onDiscardAiPreview={handleDiscardAiPreview}
        onRemoveFromView={handleRemoveFromView}
        activeAdvancedProfile={activeAdvancedProfile}
        bookmarkStaleNames={bookmarkStaleNames}
        onExitAdvancedBookmark={handleExitAdvancedBookmark}
        pendingPositions={pendingPositions}
        pendingViewport={pendingViewport}
        onPendingPositionsApplied={handlePendingPositionsApplied}
        useFullModel={useFullModel}
        onToggleFullModel={toggleUseFullModel}
        filteredOutCount={traceFilteredOutCount}
        onOpenDdlViewer={() => {
          if (highlightedNodeId) {
            handleViewDdl(highlightedNodeId);
          } else {
            vscodeApi.postMessage({ type: 'show-detail' });
            setIsDetailOpen(true);
          }
        }}
      />

      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          nodeName={contextMenu.nodeName}
          schema={contextMenu.schema}
          objectType={contextMenu.objectType}
          externalType={contextMenu.externalType}
          externalUrl={contextMenu.externalUrl}
          fullName={contextMenu.fullName}
          isTracing={isModeLocked}
          onClose={() => setContextMenu(null)}
          onTrace={(nodeId) => startTraceConfig(nodeId)}
          onFindPath={(nodeId) => startPathFinding(nodeId)}
          onViewDdl={handleViewDdl}
          onShowDetails={(nodeId) => setInfoBarNodeId(nodeId)}
          onExcludeNode={handleAddExclusionPattern}
        />
      )}
    </ReactFlowProvider>
  );
}
