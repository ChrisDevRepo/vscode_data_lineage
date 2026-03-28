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
import type { DatabaseModel, ObjectType, FilterState, ExtensionConfig, AnalysisMode, AnalysisType, InnerFilterContext } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { runAnalysis } from '../engine/graphAnalysis';
import { filterBySchemas, applyExclusionPatterns } from '../engine/dacpacExtractor';
import { computeSchemas } from '../engine/modelBuilder';
import { escapeRegexLiteral } from '../utils/sql';
import type { Project, FilterProfile, DacpacConnection, DatabaseConnection } from '../engine/projectStore';
import { createProject, addFilterProfile, deleteFilterProfile, serializeFilter, deserializeFilter } from '../engine/projectStore';

type AppView = 'start' | 'create' | 'visualizing' | 'graph';

const DACPAC_TIMEOUT_MS = 20_000;
const DB_TIMEOUT_MS = 60_000;
const MIN_SPINNER_MS = 1200;

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

  const { flowNodes, flowEdges, graph, metrics, renderLimitHit, buildFromModel } = useGraphology();
  const { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace } =
    useInteractiveTrace(graph, flowNodes, flowEdges, config);

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
    (m: DatabaseModel, f: FilterState, cfg?: ExtensionConfig) => {
      startTransition(() => buildFromModel(m, f, cfg || config));
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
  }, [dacpacLoader.resetToStart, clearTrace]);

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

  /** True when any locked mode (trace/analysis/advanced-bookmark) is active. */
  const isModeLocked = (
    trace.mode === 'applied' || trace.mode === 'path-applied' ||
    !!analysisMode ||
    !!activeAdvancedProfile
  );

  /**
   * Active filter context — schemas and types visible in the current mode.
   * Schemas/types NOT in these sets are shown grayed-out in filter dropdowns.
   */
  const innerContext = useMemo((): InnerFilterContext | null => {
    if (!model) return null;
    let nodeIds: string[] = [];
    if (trace.mode === 'applied' || trace.mode === 'path-applied') {
      nodeIds = Array.from(trace.tracedNodeIds);
    } else if (analysisMode) {
      if (analysisMode.activeGroupId) {
        const group = analysisMode.result.groups.find(g => g.id === analysisMode.activeGroupId);
        nodeIds = group?.nodeIds ?? [];
      } else {
        nodeIds = analysisMode.result.groups.flatMap(g => g.nodeIds);
      }
    } else if (activeAdvancedProfile) {
      nodeIds = activeAdvancedProfile.filter.allowlistNodeIds ?? [];
    } else {
      return null;
    }
    const nodeSet = new Set(nodeIds);
    const allowedSchemas = new Set<string>();
    const allowedTypes = new Set<ObjectType>();
    for (const n of model.nodes) {
      if (nodeSet.has(n.id)) {
        allowedSchemas.add(n.schema);
        allowedTypes.add(n.type);
      }
    }
    return { allowedSchemas, allowedTypes };
  }, [model, trace.mode, trace.tracedNodeIds, analysisMode, activeAdvancedProfile]);

  // ── Mode-lock filter save/restore ─────────────────────────────────────────
  // Refs to access current values inside the effect without re-firing on every change
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const modelRef = useRef(model);
  modelRef.current = model;
  const configRef = useRef(config);
  configRef.current = config;
  const innerContextRef = useRef(innerContext);
  innerContextRef.current = innerContext;
  const rebuildRef = useRef(rebuild);
  rebuildRef.current = rebuild;
  const prevIsModeLocked = useRef(false);

  useEffect(() => {
    const entering = isModeLocked && !prevIsModeLocked.current;
    const leaving = !isModeLocked && prevIsModeLocked.current;
    prevIsModeLocked.current = isModeLocked;

    if (entering && !preModFilterRef.current) {
      // Save current filter (before narrowing) — skip if already explicitly saved
      preModFilterRef.current = filterRef.current;
      // Narrow schemas/types to mode scope — NO rebuild (graph already shows mode subset)
      const ic = innerContextRef.current;
      if (ic) {
        setFilter(prev => ({
          ...prev,
          schemas: ic.allowedSchemas.size > 0
            ? new Set([...prev.schemas].filter(s => ic.allowedSchemas.has(s)))
            : prev.schemas,
          types: ic.allowedTypes.size > 0
            ? new Set([...prev.types].filter(t => ic.allowedTypes.has(t))) as FilterState['types']
            : prev.types,
        }));
      }
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
        const f = getResetFilter(model);
        setFilter(f);
        rebuild(model, f, config);
      });
    }
  }, [model, config, rebuild, clearTrace]);

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

  const handleRebuild = useCallback(() => {
    if (model) setIsRebuilding(true);
    vscodeApi.postMessage({ type: 'rebuild' });
  }, [vscodeApi, model]);

  const handleNodeClick = useCallback(
    (nodeId: string, findQuery?: string) => {
      setHighlightedNodeId(prev => {
        const toggled = prev === nodeId ? null : nodeId;
        setInfoBarNodeId(cur => cur !== null ? toggled : null);
        return toggled;
      });

      const node = model?.nodes.find(n => n.id === nodeId);
      if (!node) return;
      if (isDetailOpen) {
        vscodeApi.postMessage({ type: 'update-detail', node, findQuery });
      } else if (findQuery) {
        // DetailSearchSidebar result clicked — open panel with search term
        vscodeApi.postMessage({ type: 'show-detail', node, findQuery });
        setIsDetailOpen(true);
      }
    },
    [model, vscodeApi, isDetailOpen]
  );

  const handleTraceApply = useCallback((config: { upstreamLevels: number; downstreamLevels: number }) => {
    applyTrace(config.upstreamLevels, config.downstreamLevels);
  }, [applyTrace]);

  const handleNodeContextMenu = useCallback(
    (nodeId: string, x: number, y: number) => {
      const node = flowNodes.find((n) => n.id === nodeId);
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
    [flowNodes]
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

  const handleSearchChange = useCallback((term: string) => {
    setFilter((prev) => ({ ...prev, searchTerm: term }));
  }, []);

  const handleToggleIsolated = useCallback(() => {
    setFilter((prev) => {
      const next = { ...prev, hideIsolated: !prev.hideIsolated };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleToggleFocusSchema = useCallback((schema: string) => {
    setFilter((prev) => {
      const focusSchemas = new Set<string>();
      const isUnfocusing = prev.focusSchemas.has(schema);

      if (!isUnfocusing) {
        focusSchemas.add(schema);
      }

      let schemas: Set<string>;
      if (isUnfocusing) {
        schemas = new Set(model?.schemas.map(s => s.name) || []);
      } else if (model) {
        const focusNodeIds = new Set(
          model.nodes.filter(n => n.schema === schema).map(n => n.id)
        );
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
        schemas = neighborSchemas;
      } else {
        schemas = prev.schemas;
      }

      const next = { ...prev, focusSchemas, schemas };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  /** Called on schema bubble double-click — same as clicking the star button in the
   *  schema dropdown. Sets focusSchemas + selects the schema + its neighbors. Always-set
   *  (never toggles off, even if schema was already focused). */
  const handleSetFocusSchema = useCallback((schema: string) => {
    if (!model) return;
    setFilter((prev) => {
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
      const next = { ...prev, focusSchemas: new Set([schema]), schemas: neighborSchemas };
      rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  // ── Overview mode (schema-level view) ───────────────────────────────────────

  const schemasKey = useMemo(() => [...filter.schemas].sort().join(','), [filter.schemas]);

  const { graphMode, enteredFocusFromOverview, toggleMode, enterFocusFromOverview, resetUserChoice } = useOverviewMode({
    model,
    flowNodes,
    config,
    schemasKey,
    onSetFocusSchema: handleSetFocusSchema,
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

    if (type === 'orphans' && filter.hideIsolated) {
      // Pre-save filter (with hideIsolated: true) before we change it,
      // so the mode-lock useEffect restores the correct value on exit.
      preModFilterRef.current = filter;
      const nextFilter = { ...filter, hideIsolated: false };
      setFilter(nextFilter);
      setAnalysisMode(null);
      pendingAnalysisRef.current = 'orphans';
      if (model) buildFromModel(model, nextFilter, config);
    } else {
      if (graph) {
        const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
        setAnalysisMode({ type, result, activeGroupId: null });
      }
    }
  }, [endTrace, filter, model, graph, config, buildFromModel]);

  useEffect(() => {
    if (pendingAnalysisRef.current && graph) {
      const type = pendingAnalysisRef.current;
      pendingAnalysisRef.current = null;
      const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
      setAnalysisMode({ type, result, activeGroupId: null });
    }
  }, [graph, config.analysis, config.maxNodes]);

  // DELETE key on a highlighted node → add exact exclusion rule
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!highlightedNodeId) return;
      const node = flowNodes.find((n) => n.id === highlightedNodeId);
      if (!node) return;
      const pattern = `^${escapeRegexLiteral(String(node.data.schema))}\\.${escapeRegexLiteral(String(node.data.label))}$`;
      handleAddExclusionPattern(pattern);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [highlightedNodeId, flowNodes, handleAddExclusionPattern]);

  const closeAnalysis = useCallback(() => {
    // Filter restore is handled by the isModeLocked useEffect when analysisMode → null
    endTrace();
    setAnalysisMode(null);
  }, [endTrace]);

  const selectAnalysisGroup = useCallback((groupId: string) => {
    if (!analysisMode || !graph) return;
    const group = analysisMode.result.groups.find(g => g.id === groupId);
    if (!group) return;

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
  }, [analysisMode, graph, applyAnalysisSubset]);

  const clearAnalysisGroup = useCallback(() => {
    if (!analysisMode) return;
    setAnalysisMode(prev => prev ? { ...prev, activeGroupId: null } : null);
    endTrace();
  }, [analysisMode, endTrace]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (analysisMode) {
          if (analysisMode.activeGroupId) clearAnalysisGroup();
          else closeAnalysis();
        } else if (trace.mode !== 'none') {
          endTrace();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [trace.mode, endTrace, analysisMode, closeAnalysis, clearAnalysisGroup]);

  const handleApplyView = useCallback((profile: FilterProfile) => {
    overviewActionsRef.current.resetUserChoice();
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
        setIsRebuilding(false);
      } else if (msg?.type === 'ai-view-activate') {
        // AI created an advanced bookmark — look it up and apply it
        const profileId: string = msg.profileId;
        setProjects(prev => {
          const project = prev.find(p => p.filterProfiles?.some(fp => fp.id === profileId));
          const profile = project?.filterProfiles?.find(fp => fp.id === profileId);
          if (profile) {
            // Defer to next tick so projects state is committed first
            setTimeout(() => handleApplyView(profile), 0);
          }
          return prev;
        });
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

  // ── Saved Views ─────────────────────────────────────────────────────────────

  const activeProject = projects.find(p => p.id === activeProjectId);
  const filterProfiles = activeProject?.filterProfiles ?? [];

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
    // Optimistic update
    setProjects(prev => {
      const store = { schemaVersion: 1 as const, projects: prev, lastOpenedId };
      return addFilterProfile(store, activeProjectId, profile).projects;
    });
    vscodeApi.postMessage({ type: 'save-view', projectId: activeProjectId, profile });
  }, [activeProjectId, filter, lastOpenedId, vscodeApi]);

  const handleExitAdvancedBookmark = useCallback(() => {
    // Filter restore is handled by the isModeLocked useEffect when activeAdvancedProfile → null
    setActiveAdvancedProfile(null);
  }, []);

  const handlePendingPositionsApplied = useCallback(() => {
    setPendingPositions(undefined);
    setPendingViewport(undefined);
  }, []);

  const handleRemoveFromView = useCallback((nodeId: string) => {
    setFilter(f => {
      if (!f.allowlistNodeIds) return f;
      const next: FilterState = {
        ...f,
        allowlistNodeIds: new Set([...f.allowlistNodeIds].filter(id => id !== nodeId)),
      };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleSaveTraceAsBookmark = useCallback((
    name: string,
    nodeIds: string[],
    source: 'trace' | 'path',
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
  ) => {
    if (!activeProjectId) return;
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
    setProjects(prev => {
      const store = { schemaVersion: 1 as const, projects: prev, lastOpenedId };
      return addFilterProfile(store, activeProjectId, profile).projects;
    });
    vscodeApi.postMessage({ type: 'save-view', projectId: activeProjectId, profile });
  }, [activeProjectId, filter, lastOpenedId, vscodeApi]);

  const handleSaveAnalysisBookmark = useCallback((
    name: string,
    nodeIds: string[],
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
  ) => {
    if (!activeProjectId) return;
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
    setProjects(prev => {
      const store = { schemaVersion: 1 as const, projects: prev, lastOpenedId };
      return addFilterProfile(store, activeProjectId, profile).projects;
    });
    vscodeApi.postMessage({ type: 'save-view', projectId: activeProjectId, profile });
  }, [activeProjectId, filter, lastOpenedId, vscodeApi]);

  const handleDeleteView = useCallback((profileId: string) => {
    if (!activeProjectId) return;
    // Optimistic update
    setProjects(prev => {
      const store = { schemaVersion: 1 as const, projects: prev, lastOpenedId };
      return deleteFilterProfile(store, activeProjectId, profileId).projects;
    });
    vscodeApi.postMessage({ type: 'delete-view', projectId: activeProjectId, profileId });
  }, [activeProjectId, lastOpenedId, vscodeApi]);

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

  const isTraceActive = trace.mode === 'applied' || trace.mode === 'path-applied' || trace.mode === 'analysis';
  const renderNodes = isTraceActive ? tracedNodes : (graphMode === 'overview' ? schemaNodes : tracedNodes);
  const renderEdges = isTraceActive ? tracedEdges : (graphMode === 'overview' ? schemaEdges : tracedEdges);

  return (
    <ReactFlowProvider>
      <GraphCanvas
        flowNodes={renderNodes}
        flowEdges={renderEdges}
        graphMode={graphMode}
        onSchemaNodeDoubleClick={enterFocusFromOverview}
        trace={trace}
        filter={filter}
        metrics={metrics}
        highlightedNodeId={highlightedNodeId}
        graph={graph}
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
        onSearchChange={handleSearchChange}
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
        onSaveView={handleSaveView}
        onApplyView={handleApplyView}
        onDeleteView={handleDeleteView}
        isModeLocked={isModeLocked}
        innerContext={innerContext}
        onSaveTraceBookmark={activeProjectId ? handleSaveTraceAsBookmark : undefined}
        onSaveAnalysisBookmark={activeProjectId ? handleSaveAnalysisBookmark : undefined}
        onRemoveFromView={handleRemoveFromView}
        activeAdvancedProfile={activeAdvancedProfile}
        bookmarkStaleNames={bookmarkStaleNames}
        onExitAdvancedBookmark={handleExitAdvancedBookmark}
        pendingPositions={pendingPositions}
        pendingViewport={pendingViewport}
        onPendingPositionsApplied={handlePendingPositionsApplied}
        onOpenDdlViewer={() => {
          if (highlightedNodeId) {
            handleViewDdl(highlightedNodeId);
          }
          // else: no-op — user must select a node first
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
