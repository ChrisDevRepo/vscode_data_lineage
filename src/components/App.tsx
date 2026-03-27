import { useState, useCallback, useRef, useEffect, useTransition } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { StartScreen } from './StartScreen';
import { CreateFlow } from './CreateFlow';
import { VisualizingScreen, type LoadingPhase } from './VisualizingScreen';
import { GraphCanvas } from './GraphCanvas';
import { NodeContextMenu } from './NodeContextMenu';
import { useGraphology } from '../hooks/useGraphology';
import { useInteractiveTrace } from '../hooks/useInteractiveTrace';
import { useDacpacLoader } from '../hooks/useDacpacLoader';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DatabaseModel, ObjectType, FilterState, ExtensionConfig, AnalysisMode, AnalysisType } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { runAnalysis } from '../engine/graphAnalysis';
import { loadRules } from '../engine/sqlBodyParser';
import { filterBySchemas, applyExclusionPatterns } from '../engine/dacpacExtractor';
import { computeSchemas } from '../engine/modelBuilder';
import { escapeRegexLiteral } from '../utils/sql';
import type { Project, FilterProfile, DacpacConnection, DatabaseConnection } from '../engine/projectStore';
import { createProject, addFilterProfile, deleteFilterProfile, serializeFilter, deserializeFilter } from '../engine/projectStore';

type AppView = 'start' | 'create' | 'visualizing' | 'graph';

const REBUILD_DELAY_MS = 400;
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

  const { flowNodes, flowEdges, graph, metrics, buildFromModel } = useGraphology();
  const { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace } =
    useInteractiveTrace(graph, flowNodes, flowEdges, config);

  const applyConfig = useCallback((cfg: ExtensionConfig) => {
    setConfig(cfg);
    if (cfg.parseRules) {
      const result = loadRules(cfg.parseRules);
      vscodeApi.postMessage({
        type: 'parse-rules-result',
        loaded: result.loaded,
        skipped: result.skipped,
        errors: result.errors,
        usedDefaults: result.usedDefaults,
        categoryCounts: result.categoryCounts,
      });
    } else {
      vscodeApi.postMessage({
        type: 'parse-rules-result',
        loaded: 0,
        skipped: [],
        errors: ['No parse rules received from extension host'],
        usedDefaults: true,
        categoryCounts: {},
      });
    }
  }, [vscodeApi]);

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
  const prevHideIsolatedRef = useRef<boolean | null>(null);
  const pendingAnalysisRef = useRef<AnalysisType | null>(null);

  const handleRefresh = useCallback(() => {
    if (model) {
      clearTrace(() => {
        const f = getResetFilter(model);
        setFilter(f);
        rebuild(model, f, config);
      });
    }
  }, [model, config, rebuild, clearTrace]);

  const handleResetAll = useCallback(() => {
    if (model) {
      const f = getResetFilter(model);
      setFilter(f);
      clearTrace(() => {
        rebuild(model, f, config);
      });
    }
  }, [model, config, rebuild, clearTrace]);

  const handleRebuild = useCallback(() => {
    vscodeApi.postMessage({ type: 'ready' });
    if (model) {
      setIsRebuilding(true);
      setTimeout(() => {
        rebuild(model, filter, config);
        setIsRebuilding(false);
      }, REBUILD_DELAY_MS);
    }
  }, [vscodeApi, model, filter, config, rebuild]);

  const handleNodeClick = useCallback(
    (nodeId: string, findQuery?: string) => {
      setHighlightedNodeId(prev => {
        const toggled = prev === nodeId ? null : nodeId;
        setInfoBarNodeId(cur => cur !== null ? toggled : null);
        return toggled;
      });

      if (isDetailOpen) {
        const node = model?.nodes.find(n => n.id === nodeId);
        if (node) vscodeApi.postMessage({ type: 'update-detail', node, findQuery });
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
      const focusSchemas = new Set(prev.focusSchemas);
      if (schemas.has(schema)) {
        schemas.delete(schema);
        if (focusSchemas.has(schema)) focusSchemas.delete(schema);
      } else {
        schemas.add(schema);
      }
      const next = { ...prev, schemas, focusSchemas };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleSelectAllSchemas = useCallback((schemas: string[]) => {
    setFilter((prev) => {
      const next = { ...prev, schemas: new Set([...prev.schemas, ...schemas]) };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleSelectNoneSchemas = useCallback((schemas: string[]) => {
    setFilter((prev) => {
      const nextSchemas = new Set(prev.schemas);
      const focusSchemas = new Set(prev.focusSchemas);
      for (const s of schemas) {
        nextSchemas.delete(s);
        focusSchemas.delete(s);
      }
      const next = { ...prev, schemas: nextSchemas, focusSchemas };
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
      prevHideIsolatedRef.current = true;
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
    endTrace();
    if (prevHideIsolatedRef.current !== null) {
      const nextFilter = { ...filter, hideIsolated: true };
      setFilter(nextFilter);
      if (model) rebuild(model, nextFilter, config);
      prevHideIsolatedRef.current = null;
    }
    setAnalysisMode(null);
  }, [endTrace, filter, model, config, rebuild]);

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
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [view]);

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

  const handleApplyView = useCallback((profile: FilterProfile) => {
    const restored = deserializeFilter(profile.filter);
    setFilter(restored);
    if (model) rebuild(model, restored, config);
  }, [model, config, rebuild]);

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

  return (
    <ReactFlowProvider>
      <GraphCanvas
        flowNodes={tracedNodes}
        flowEdges={tracedEdges}
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
        onOpenDdlViewer={() => {
          if (highlightedNodeId) {
            handleViewDdl(highlightedNodeId);
          } else {
            vscodeApi.postMessage({
              type: 'show-ddl',
              objectName: 'SQL Viewer',
              schema: '',
              sqlBody: '-- Select a node to view its SQL definition',
            });
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
          isTracing={trace.mode !== 'none' || !!analysisMode}
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
