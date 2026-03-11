import { useState, useCallback, useRef, useEffect, useTransition } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ProjectSelector } from './ProjectSelector';
import { GraphCanvas } from './GraphCanvas';
import { NodeContextMenu } from './NodeContextMenu';
import { TableDetailPanel, type TableStatsState } from './TableDetailPanel';
import { useGraphology } from '../hooks/useGraphology';
import { useInteractiveTrace } from '../hooks/useInteractiveTrace';
import { useDacpacLoader } from '../hooks/useDacpacLoader';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DacpacModel, LineageNode, ObjectType, FilterState, ExtensionConfig, AnalysisMode, AnalysisType, SavedSession } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import type { StatsMode } from '../engine/profilingEngine';
import { runAnalysis } from '../engine/graphAnalysis';
import { loadRules } from '../engine/sqlBodyParser';
import { filterBySchemas, applyExclusionPatterns } from '../engine/dacpacExtractor';
import { computeSchemas } from '../engine/modelBuilder';

type AppView = 'selector' | 'graph' | 'loading';

const REBUILD_DELAY_MS = 400;

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
  const [view, setView] = useState<AppView>(isAutoVisualize ? 'loading' : 'selector');
  const [model, setModel] = useState<DacpacModel | null>(null);
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const [filter, setFilter] = useState<FilterState>({
    schemas: new Set(),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set<'file' | 'db'>(['file', 'db']),
    filteredOutObjects: [],
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
    (m: DacpacModel, f: FilterState, cfg?: ExtensionConfig) => {
      startTransition(() => buildFromModel(m, f, cfg || config));
    },
    [buildFromModel, config]
  );

  const handleVisualize = useCallback(
    (dacpacModel: DacpacModel, selectedSchemas: Set<string>) => {
      // Create trimmed model: only selected schemas with exclusions applied
      let trimmed = filterBySchemas(dacpacModel, selectedSchemas, Infinity);
      trimmed = applyExclusionPatterns(trimmed, config.excludePatterns, (msg) => {
        vscodeApi.postMessage({ type: 'error', error: msg });
      });
      trimmed = { ...trimmed, schemas: computeSchemas(trimmed.nodes) };

      setModel(trimmed);

      // Apply pending session filter state if loading from a saved session
      const pending = pendingSessionRef.current;
      if (pending) {
        pendingSessionRef.current = null;
        const f: FilterState = {
          schemas: new Set(trimmed.schemas.map(s => s.name)),
          types: new Set(pending.filterState.types),
          searchTerm: '',
          hideIsolated: pending.filterState.hideIsolated,
          focusSchemas: new Set(),
          showExternalRefs: pending.filterState.showExternalRefs,
          externalRefTypes: new Set(pending.filterState.externalRefTypes),
          filteredOutObjects: pending.filteredOutObjects,
        };
        setFilter(f);
        rebuild(trimmed, f, config);
      } else {
        const f = getResetFilter(trimmed);
        setFilter(f);
        rebuild(trimmed, f, config);
      }
      setView('graph');
    },
    [rebuild, config]
  );

  useEffect(() => {
    if (!dacpacLoader.model || dacpacLoader.isLoading) return;

    if (dacpacLoader.pendingAutoVisualize) {
      handleVisualize(dacpacLoader.model, new Set(dacpacLoader.model.schemas.map(s => s.name)));
      dacpacLoader.clearAutoVisualize();
    } else if (dacpacLoader.pendingVisualize) {
      handleVisualize(dacpacLoader.model, dacpacLoader.selectedSchemas);
      dacpacLoader.clearPendingVisualize();
    }
  }, [
    dacpacLoader.pendingAutoVisualize, dacpacLoader.pendingVisualize,
    dacpacLoader.model, dacpacLoader.isLoading, dacpacLoader.selectedSchemas,
    handleVisualize, dacpacLoader.clearAutoVisualize, dacpacLoader.clearPendingVisualize,
  ]);

  const getResetFilter = (m: DacpacModel, preserveFilterOut = false): FilterState => ({
    schemas: new Set(m.schemas.map(s => s.name)),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set<'file' | 'db'>(['file', 'db']),
    filteredOutObjects: preserveFilterOut ? filter.filteredOutObjects : [],
  });

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

  const prevConfigRef = useRef(config);

  // Rebuild graph when config changes (after a refresh)
  useEffect(() => {
    if (prevConfigRef.current !== config && model && view === 'graph') {
      prevConfigRef.current = config;
      rebuild(model, filter, config);
    }
  }, [config, model, view, filter, rebuild]);

  const handleRebuild = useCallback(() => {
    // Re-read settings from extension host (picks up any changed VS Code settings)
    vscodeApi.postMessage({ type: 'ready' });
    if (model) {
      setIsRebuilding(true);
      setTimeout(() => {
        rebuild(model, filter, config);
        setIsRebuilding(false);
      }, REBUILD_DELAY_MS);
    }
  }, [vscodeApi, model, filter, config, rebuild]);

  const handleBack = useCallback(() => {
    dacpacLoader.resetToStart();
    setView('selector');
    clearTrace();
    setTableDetailNode(null);
    setTableStatsState({ phase: 'idle' });
  }, [dacpacLoader.resetToStart, clearTrace]);

  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const pendingSessionRef = useRef<SavedSession | null>(null);

  // Listen for session messages from extension host
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'sessions-list') {
        setSavedSessions(msg.sessions);
      } else if (msg?.type === 'session-loaded') {
        // Store pending session — will be applied after model loads
        pendingSessionRef.current = msg.session;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const [isRebuilding, setIsRebuilding] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [infoBarNodeId, setInfoBarNodeId] = useState<string | null>(null);
  const [tableDetailNode, setTableDetailNode] = useState<LineageNode | null>(null);
  const [tableStatsState, setTableStatsState] = useState<TableStatsState>({ phase: 'idle' });
  const [isDetailSearchOpen, setIsDetailSearchOpen] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode | null>(null);
  const prevHideIsolatedRef = useRef<boolean | null>(null);
  const pendingAnalysisRef = useRef<AnalysisType | null>(null);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      setHighlightedNodeId(prev => {
        const toggled = prev === nodeId ? null : nodeId;
        // Update info bar if already open (uses nested updater to avoid dep)
        setInfoBarNodeId(cur => cur !== null ? toggled : null);
        return toggled;
      });

      const node = model?.nodes.find(n => n.id === nodeId);
      if (!node) return;

      if (node.type === 'table' || node.type === 'external') {
        // If panel is already open, refresh to show the clicked table (don't open from scratch)
        setTableDetailNode(prev => {
          if (!prev) return null;           // panel closed — stay closed
          if (prev.id === nodeId) return prev; // same node — no change
          setTableStatsState({ phase: 'idle' });
          return node;                      // different table — refresh panel
        });
      } else {
        // Update DDL text editor if already open (don't open on left-click)
        vscodeApi.postMessage({
          type: 'update-ddl',
          objectName: node.name,
          schema: node.schema,
          objectType: node.type,
          sqlBody: node.bodyScript,
          columns: node.columns,
        });
      }
    },
    [model, vscodeApi]
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

      if (node.type === 'table' || node.type === 'external') {
        // Open the table detail sidebar
        setTableDetailNode(node);
        setTableStatsState({ phase: 'idle' });
      } else {
        // Open DDL text editor (SP/View/Function)
        vscodeApi.postMessage({
          type: 'show-ddl',
          objectName: node.name,
          schema: node.schema,
          objectType: node.type,
          sqlBody: node.bodyScript,
          columns: node.columns,
        });
      }
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

  const handleSearchChange = useCallback(
    (term: string) => {
      setFilter((prev) => ({ ...prev, searchTerm: term }));
    },
    []
  );

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

      // Update schema checkboxes to match what's visible
      let schemas: Set<string>;
      if (isUnfocusing) {
        // Restore all schemas when un-starring
        schemas = new Set(model?.schemas.map(s => s.name) || []);
      } else if (model) {
        // Check only the focused schema + schemas of its 1-hop neighbors
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

  // ─── Object Filter-Out Callbacks ────────────────────────────────────────────

  const handleAddFilterOut = useCallback((pattern: string) => {
    setFilter((prev) => {
      if (prev.filteredOutObjects.includes(pattern)) return prev;
      const next = { ...prev, filteredOutObjects: [...prev.filteredOutObjects, pattern] };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleRemoveFilterOut = useCallback((index: number) => {
    setFilter((prev) => {
      const filteredOutObjects = prev.filteredOutObjects.filter((_, i) => i !== index);
      const next = { ...prev, filteredOutObjects };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  const handleClearFilterOut = useCallback(() => {
    setFilter((prev) => {
      const next = { ...prev, filteredOutObjects: [] };
      if (model) rebuild(model, next, config);
      return next;
    });
  }, [model, config, rebuild]);

  // ─── Session Callbacks ──────────────────────────────────────────────────────

  const handleSaveSession = useCallback((name: string) => {
    const session: SavedSession = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: {
        type: dacpacLoader.lastSource?.type || 'dacpac',
        name: dacpacLoader.lastSource?.name || '',
      },
      deselectedSchemas: model
        ? model.schemas.map(s => s.name).filter(s => !filter.schemas.has(s))
        : [],
      filteredOutObjects: filter.filteredOutObjects,
      filterState: {
        types: Array.from(filter.types),
        hideIsolated: filter.hideIsolated,
        showExternalRefs: filter.showExternalRefs,
        externalRefTypes: Array.from(filter.externalRefTypes),
      },
    };
    vscodeApi.postMessage({ type: 'save-session', session });
  }, [dacpacLoader.lastSource, model, filter, vscodeApi]);

  const handleLoadSession = useCallback((sessionId: string) => {
    vscodeApi.postMessage({ type: 'load-session', sessionId });
  }, [vscodeApi]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    vscodeApi.postMessage({ type: 'delete-session', sessionId });
  }, [vscodeApi]);

  const handleToggleSchema = useCallback((schema: string) => {
    setFilter((prev) => {
      const schemas = new Set(prev.schemas);
      const focusSchemas = new Set(prev.focusSchemas);
      
      if (schemas.has(schema)) {
        schemas.delete(schema);
        // If unchecking a focused schema, unfocus it
        if (focusSchemas.has(schema)) {
          focusSchemas.delete(schema);
        }
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
    // End any active trace / close detail search
    endTrace();
    setIsDetailSearchOpen(false);
    setHighlightedNodeId(null);
    setInfoBarNodeId(null);

    if (type === 'orphans' && filter.hideIsolated) {
      // Save current hideIsolated state and disable it so orphans become visible
      prevHideIsolatedRef.current = true;
      const nextFilter = { ...filter, hideIsolated: false };
      setFilter(nextFilter);
      setAnalysisMode(null);
      // Set pending flag — useEffect will run analysis once graph rebuilds
      pendingAnalysisRef.current = 'orphans';
      if (model) {
        buildFromModel(model, nextFilter, config);
      }
    } else {
      // For islands/hubs/longest-path/cycles, run analysis on current graph
      if (graph) {
        const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
        setAnalysisMode({ type, result, activeGroupId: null });
      }
    }
  }, [endTrace, filter, model, graph, config, buildFromModel]);

  // Run pending orphan analysis after graph rebuild completes
  useEffect(() => {
    if (pendingAnalysisRef.current && graph) {
      const type = pendingAnalysisRef.current;
      pendingAnalysisRef.current = null;
      const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
      setAnalysisMode({ type, result, activeGroupId: null });
    }
  }, [graph, config.analysis, config.maxNodes]);

  const closeAnalysis = useCallback(() => {
    // Clear analysis overlay — same restore as leaving trace mode
    endTrace();

    // Undo orphans' hideIsolated change if needed
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

    // Compute subset node IDs
    const nodeIdSet = new Set(group.nodeIds);
    if (analysisMode.type === 'hubs') {
      for (const hubId of group.nodeIds) {
        if (graph.hasNode(hubId)) {
          graph.forEachNeighbor(hubId, (neighbor) => nodeIdSet.add(neighbor));
        }
      }
    }

    // Compute subset edge IDs from the live graph
    const edgeIds = new Set<string>();
    if (analysisMode.type === 'longest-path') {
      // Consecutive-pair edges only — same concept as computeShortestPath
      for (let i = 0; i < group.nodeIds.length - 1; i++) {
        const edge = graph.edge(group.nodeIds[i], group.nodeIds[i + 1]);
        if (edge) edgeIds.add(edge);
      }
    } else {
      // All edges between subset nodes that exist in current graph
      graph.forEachEdge((edge, _attrs, source, target) => {
        if (nodeIdSet.has(source) && nodeIdSet.has(target)) {
          edgeIds.add(edge);
        }
      });
    }

    // Determine origin node for highlighting
    const originId = analysisMode.type === 'hubs' ? group.nodeIds[0]
      : analysisMode.type === 'longest-path' ? group.nodeIds[0]
      : undefined;

    // Reuse trace pipeline for rendering (same as Find Path / Trace Levels)
    applyAnalysisSubset(nodeIdSet, edgeIds, originId, analysisMode.type);
  }, [analysisMode, graph, applyAnalysisSubset]);

  const clearAnalysisGroup = useCallback(() => {
    if (!analysisMode) return;
    setAnalysisMode(prev => prev ? { ...prev, activeGroupId: null } : null);
    endTrace();  // Clear subset overlay — full graph visible again
  }, [analysisMode, endTrace]);

  // Escape key: end trace or close analysis
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (analysisMode) {
          if (analysisMode.activeGroupId) {
            clearAnalysisGroup();
          } else {
            closeAnalysis();
          }
        } else if (trace.mode !== 'none') {
          endTrace();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [trace.mode, endTrace, analysisMode, closeAnalysis, clearAnalysisGroup]);

  // Handle stats results from extension host
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'table-stats-result') {
        setTableStatsState({ phase: 'result', stats: msg.stats, mode: msg.mode });
      } else if (msg?.type === 'table-stats-error') {
        setTableStatsState({ phase: 'error', message: msg.message });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (view === 'loading') {
    return null;
  }

  if (view === 'selector') {
    return <ProjectSelector config={config} loader={dacpacLoader} savedSessions={savedSessions} onLoadSession={handleLoadSession} />;
  }

  const isDbMode = dacpacLoader.lastSource?.type === 'database';
  const statsEnabled = config.tableStatistics?.enabled ?? true;
  const excludeExternalTables = config.tableStatistics?.excludeExternalTables ?? true;
  const standardModeEnabled = config.tableStatistics?.standardModeEnabled ?? true;

  const handleRequestStats = (mode: StatsMode) => {
    if (!tableDetailNode) return;
    setTableStatsState({ phase: 'loading', mode });
    vscodeApi.postMessage({
      type: 'table-stats-request',
      schema: tableDetailNode.schema,
      objectName: tableDetailNode.name,
      mode,
      columns: tableDetailNode.columns,
    });
  };

  const tableDetailPanelElement = tableDetailNode ? (
    <TableDetailPanel
      schema={tableDetailNode.schema}
      objectName={tableDetailNode.name}
      objectType={tableDetailNode.type as 'table' | 'external'}
      externalType={tableDetailNode.externalType}
      columns={tableDetailNode.columns ?? []}
      fks={tableDetailNode.fks ?? []}
      statsState={tableStatsState}
      onClose={() => { setTableDetailNode(null); setTableStatsState({ phase: 'idle' }); }}
      onRequestStats={handleRequestStats}
      isDbMode={isDbMode}
      statsEnabled={statsEnabled}
      excludeExternalTables={excludeExternalTables}
      standardModeEnabled={standardModeEnabled}
    />
  ) : null;

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
        onAddFilterOut={handleAddFilterOut}
        onRemoveFilterOut={handleRemoveFilterOut}
        onClearFilterOut={handleClearFilterOut}
        savedSessions={savedSessions}
        onSaveSession={handleSaveSession}
        onLoadSession={handleLoadSession}
        onDeleteSession={handleDeleteSession}
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
        tableDetailPanel={tableDetailPanelElement}
        isPanelOpen={tableDetailNode !== null}
        sourceName={dacpacLoader.lastSource?.name}
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
          onFilterOut={handleAddFilterOut}
        />
      )}

    </ReactFlowProvider>
  );
}
