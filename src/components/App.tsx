import { useState, useCallback, useRef, useEffect } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { ProjectSelector } from './ProjectSelector';
import { GraphCanvas } from './GraphCanvas';
import { NodeContextMenu } from './NodeContextMenu';
import { useGraphology } from '../hooks/useGraphology';
import { useInteractiveTrace } from '../hooks/useInteractiveTrace';
import { useDacpacLoader } from '../hooks/useDacpacLoader';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DacpacModel, ObjectType, FilterState, ExtensionConfig, AnalysisMode, AnalysisType } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { runAnalysis } from '../engine/graphAnalysis';
import { loadRules } from '../engine/sqlBodyParser';
import { filterBySchemas, computeSchemas, applyExclusionPatterns } from '../engine/dacpacExtractor';

type AppView = 'selector' | 'graph';

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  nodeName: string;
  schema: string;
  objectType: ObjectType;
}

export function App() {
  const vscodeApi = useVsCode();
  const [view, setView] = useState<AppView>('selector');
  const [model, setModel] = useState<DacpacModel | null>(null);
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Single source of truth for filter state
  const [filter, setFilter] = useState<FilterState>({
    schemas: new Set(),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
  });

  const { flowNodes, flowEdges, graph, metrics, buildFromModel } = useGraphology();
  const { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace } =
    useInteractiveTrace(graph, flowNodes, flowEdges, config);

  // Dacpac loader lives here so state persists when navigating back
  const applyConfig = useCallback((cfg: ExtensionConfig) => {
    setConfig(cfg);
    if (cfg.parseRules) {
      const result = loadRules(cfg.parseRules);
      if (result.errors.length > 0) {
        // Send warnings back to extension host for OutputChannel + notification
        vscodeApi.postMessage({
          type: 'parse-rules-warning',
          loaded: result.loaded,
          skipped: result.skipped,
          errors: result.errors,
          usedDefaults: result.usedDefaults,
        });
      }
    }
  }, []);

  const dacpacLoader = useDacpacLoader(applyConfig);

  // Rebuild graph when filter changes (except on initial mount)
  const rebuild = useCallback(
    (m: DacpacModel, f: FilterState, cfg?: ExtensionConfig) => {
      buildFromModel(m, f, cfg || config);
    },
    [buildFromModel, config]
  );

  const handleVisualize = useCallback(
    (dacpacModel: DacpacModel, selectedSchemas: Set<string>) => {
      // Persist selected schemas for "Reopen" flow
      vscodeApi.postMessage({ type: 'save-schemas', schemas: Array.from(selectedSchemas) });

      // Create trimmed model: only selected schemas with exclusions applied
      let trimmed = filterBySchemas(dacpacModel, selectedSchemas, Infinity);
      trimmed = applyExclusionPatterns(trimmed, config.excludePatterns);
      trimmed = { ...trimmed, schemas: computeSchemas(trimmed.nodes) };

      setModel(trimmed);
      const f = { ...filter, schemas: new Set(trimmed.schemas.map(s => s.name)) };
      setFilter(f);
      rebuild(trimmed, f, config);
      setView('graph');
    },
    [filter, rebuild, config]
  );

  const getResetFilter = (m: DacpacModel): FilterState => ({
    schemas: new Set(m.schemas.map(s => s.name)),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
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
    // Request fresh config from extension host — triggers config-only → applyConfig → rebuild via useEffect
    vscodeApi.postMessage({ type: 'ready' });
  }, [vscodeApi]);

  const handleBack = useCallback(() => {
    setView('selector');
    clearTrace();
  }, [clearTrace]);

  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [infoBarNodeId, setInfoBarNodeId] = useState<string | null>(null);
  const [isDetailSearchOpen, setIsDetailSearchOpen] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode | null>(null);
  const prevHideIsolatedRef = useRef<boolean | null>(null);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      setHighlightedNodeId(prev => {
        const toggled = prev === nodeId ? null : nodeId;
        // Update info bar if already open (uses nested updater to avoid dep)
        setInfoBarNodeId(cur => cur !== null ? toggled : null);
        return toggled;
      });

      // Update DDL viewer if already open (don't open on left-click)
      const node = model?.nodes.find(n => n.id === nodeId);
      if (node) {
        vscodeApi.postMessage({
          type: 'update-ddl',
          objectName: node.name,
          schema: node.schema,
          objectType: node.type,
          sqlBody: node.bodyScript,
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
      });
    },
    [flowNodes]
  );

  const handleViewDdl = useCallback(
    (nodeId: string) => {
      const node = model?.nodes.find(n => n.id === nodeId);
      if (node) {
        vscodeApi.postMessage({
          type: 'show-ddl',
          objectName: node.name,
          schema: node.schema,
          objectType: node.type,
          sqlBody: node.bodyScript,
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
        const neighborSchemas = new Set<string>([schema]);
        for (const e of model.edges) {
          if (focusNodeIds.has(e.source)) {
            const target = model.nodes.find(n => n.id === e.target);
            if (target) neighborSchemas.add(target.schema);
          }
          if (focusNodeIds.has(e.target)) {
            const source = model.nodes.find(n => n.id === e.source);
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

  // ─── Analysis Mode ──────────────────────────────────────────────────────

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
      if (model) {
        // Rebuild with orphans visible, then run analysis on the new graph
        buildFromModel(model, nextFilter, config);
      }
    } else {
      // For islands/hubs, run analysis on current graph
      if (graph) {
        const result = runAnalysis(graph, type, config.analysis, config.maxNodes);
        setAnalysisMode({ type, result, activeGroupId: null });
      }
    }
  }, [endTrace, filter, model, graph, config, buildFromModel]);

  // When graph changes after orphan hideIsolated toggle, run the analysis
  useEffect(() => {
    if (prevHideIsolatedRef.current !== null && graph && !analysisMode) {
      const result = runAnalysis(graph, 'orphans', config.analysis, config.maxNodes);
      setAnalysisMode({ type: 'orphans', result, activeGroupId: null });
    }
  }, [graph, analysisMode, config.analysis]);

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

  if (view === 'selector') {
    return <ProjectSelector onVisualize={handleVisualize} config={config} loader={dacpacLoader} />;
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
        availableSchemas={model?.schemas.map(s => s.name) || []}
        analysisMode={analysisMode}
        onOpenAnalysis={openAnalysis}
        onCloseAnalysis={closeAnalysis}
        onSelectAnalysisGroup={selectAnalysisGroup}
        onClearAnalysisGroup={clearAnalysisGroup}
        onApplyPath={applyPath}
        onRefresh={handleRefresh}
        onRebuild={handleRebuild}
        onBack={handleBack}
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
          isTracing={trace.mode !== 'none' || !!analysisMode}
          onClose={() => setContextMenu(null)}
          onTrace={(nodeId) => startTraceConfig(nodeId)}
          onFindPath={(nodeId) => startPathFinding(nodeId)}
          onViewDdl={handleViewDdl}
          onShowDetails={(nodeId) => setInfoBarNodeId(nodeId)}
        />
      )}

    </ReactFlowProvider>
  );
}
