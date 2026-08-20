import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import type Graph from 'graphology';
import { buildExpandedSchemaViewGraph } from '../engine/graphBuilder';
import { countExpandedSchemaViewRenderedNodes, partitionBySchema } from '../engine/schemaProjection';
import type { DatabaseModel, ExtensionConfig, GraphMode } from '../engine/types';
import { notifyUser } from '../utils/notify';

/**
 * UI state that tracks which schemas are expanded in Expanded Schema View.
 */
export interface ExpandedSchemaViewState {
  /** Object highlighted after search/detail navigation; null for schema-level expansion. */
  focusNodeId: string | null;
  /** Schemas currently rendered as individual object nodes. */
  expandedSchemas: Set<string>;
}

interface UseExpandedSchemaViewArgs {
  config: ExtensionConfig;
  expandedSchemaView: ExpandedSchemaViewState | null;
  filterSchemas: ReadonlySet<string>;
  graph: Graph | null;
  graphMode: GraphMode;
  model: DatabaseModel | null;
  preserveViewportOnNextGraphChange: () => void;
  setExpandedSchemaView: Dispatch<SetStateAction<ExpandedSchemaViewState | null>>;
  setShowExpandedSchemaClusters: Dispatch<SetStateAction<boolean>>;
  showExpandedSchemaClusters: boolean;
}

/**
 * Encapsulates Expanded Schema View state transitions and derived render data.
 *
 * @remarks
 * This hook owns only the feature logic. State still lives in `App` so existing
 * reset points and host-sync behavior can remain unchanged.
 *
 * @returns Expanded-view flow graph, rendered counts, collapsed-cluster IDs, and
 * the expand/collapse/toggle actions.
 */
export function useExpandedSchemaView({
  config,
  expandedSchemaView,
  filterSchemas,
  graph,
  graphMode,
  model,
  preserveViewportOnNextGraphChange,
  setExpandedSchemaView,
  setShowExpandedSchemaClusters,
  showExpandedSchemaClusters,
}: UseExpandedSchemaViewArgs) {
  const expandedSchemaNames = useMemo(
    () => expandedSchemaView ? Array.from(expandedSchemaView.expandedSchemas).sort((a, b) => a.localeCompare(b)) : [],
    [expandedSchemaView],
  );
  const expandedSchemaKey = expandedSchemaNames.join('\u0000');

  const expandedSchemaViewGraph = useMemo(() => {
    if (graphMode !== 'overview' || !expandedSchemaView || !graph) return null;
    // The render limit is enforced here, in the layer that owns the projection, because state can
    // arrive without passing `applyExpandedSchemaViewSchemas` — a restored bookmark whose graph
    // grew, or whose limit shrank, since it was saved. Over the limit the view degrades to
    // clusters instead of freezing the webview.
    const projectedCount = countExpandedSchemaViewRenderedNodes(
      graph,
      expandedSchemaView.expandedSchemas,
      { includeCollapsedSchemaClusters: showExpandedSchemaClusters },
    );
    if (projectedCount > config.renderLimit) return null;
    return buildExpandedSchemaViewGraph(
      graph,
      expandedSchemaView.expandedSchemas,
      expandedSchemaView.focusNodeId,
      config,
      { hideClusters: !showExpandedSchemaClusters },
    );
  }, [config, expandedSchemaKey, expandedSchemaView, graph, graphMode, showExpandedSchemaClusters]);

  const expandedSchemaViewRenderedCount = useMemo(() => {
    if (graphMode !== 'overview' || !expandedSchemaView || !graph) return undefined;
    return countExpandedSchemaViewRenderedNodes(
      graph,
      expandedSchemaView.expandedSchemas,
      { includeCollapsedSchemaClusters: showExpandedSchemaClusters },
    );
  }, [expandedSchemaKey, expandedSchemaView, graph, graphMode, showExpandedSchemaClusters]);

  /** Node IDs in the working set that are currently collapsed inside a schema cluster. */
  const collapsedSchemaNodeIds = useMemo(() => {
    if (graphMode !== 'overview' || !graph) return undefined;
    if (!expandedSchemaView) return new Set(graph.nodes());
    return partitionBySchema(graph, expandedSchemaView.expandedSchemas).collapsed;
  }, [expandedSchemaKey, expandedSchemaView, graph, graphMode]);

  const clearExpandedSchemaView = useCallback(() => {
    setExpandedSchemaView(null);
  }, [setExpandedSchemaView]);

  const applyExpandedSchemaViewSchemas = useCallback((
    expandedSchemas: Set<string>,
    focusNodeId: string | null,
    label: string,
  ) => {
    if (!graph) {
      notifyUser('Expanded Schema View is still rebuilding. Try again after the graph finishes loading.');
      return;
    }
    const projectedCount = countExpandedSchemaViewRenderedNodes(
      graph,
      expandedSchemas,
      { includeCollapsedSchemaClusters: showExpandedSchemaClusters },
    );
    if (projectedCount > config.renderLimit) {
      const subject = label === 'all' ? 'all schemas' : `schema "${label}"`;
      notifyUser(
        `Cannot expand ${subject}: Expanded Schema View would render ${projectedCount} nodes, over the render limit of ${config.renderLimit}.`
      );
      return;
    }
    setExpandedSchemaView({ focusNodeId, expandedSchemas });
  }, [config.renderLimit, graph, setExpandedSchemaView, showExpandedSchemaClusters]);

  /** Open a node's schema in expanded schema view without changing filters. */
  const openExpandedSchemaViewForNode = useCallback((nodeId: string) => {
    const schema = model?.nodes.find((node) => node.id === nodeId)?.schema;
    if (!schema) return;
    const expandedSchemas = new Set(expandedSchemaView?.expandedSchemas ?? []);
    expandedSchemas.add(schema);
    applyExpandedSchemaViewSchemas(expandedSchemas, nodeId, schema);
  }, [applyExpandedSchemaViewSchemas, expandedSchemaView, model]);

  /** Expand a schema cluster in place without changing filters. */
  const expandExpandedSchemaViewSchema = useCallback((schema: string) => {
    const expandedSchemas = new Set(expandedSchemaView?.expandedSchemas ?? []);
    expandedSchemas.add(schema);
    applyExpandedSchemaViewSchemas(expandedSchemas, null, schema);
  }, [applyExpandedSchemaViewSchemas, expandedSchemaView]);

  /** Replace the expanded schema set with one schema. */
  const centerExpandedSchemaViewSchema = useCallback((schema: string) => {
    applyExpandedSchemaViewSchemas(new Set([schema]), null, schema);
  }, [applyExpandedSchemaViewSchemas]);

  const toggleExpandedSchemaClusters = useCallback(() => {
    preserveViewportOnNextGraphChange();
    setShowExpandedSchemaClusters((previous) => !previous);
  }, [preserveViewportOnNextGraphChange, setShowExpandedSchemaClusters]);

  /** Expand all visible schemas at once; rejected with a toast if it would exceed the render limit. */
  const expandAllSchemas = useCallback((allSchemaNames: string[]) => {
    applyExpandedSchemaViewSchemas(new Set(allSchemaNames), null, 'all');
  }, [applyExpandedSchemaViewSchemas]);

  /** Collapse one expanded schema; clearing the last schema returns to Schema View. */
  const collapseExpandedSchemaViewSchema = useCallback((schema: string) => {
    preserveViewportOnNextGraphChange();
    setExpandedSchemaView((previous) => {
      if (!previous) return null;
      const expandedSchemas = new Set(previous.expandedSchemas);
      expandedSchemas.delete(schema);
      return expandedSchemas.size > 0 ? { focusNodeId: null, expandedSchemas } : null;
    });
  }, [preserveViewportOnNextGraphChange, setExpandedSchemaView]);

  // Schema filter is the authoritative schema universe. Prune expanded schemas to those still
  // present; other filter changes (type, exclusion, external refs) preserve expansion state.
  useEffect(() => {
    setExpandedSchemaView((previous) => {
      if (!previous || previous.expandedSchemas.size === 0) return previous;
      // Empty filter.schemas means all schemas are active — nothing to prune.
      if (filterSchemas.size === 0) return previous;
      const surviving = new Set([...previous.expandedSchemas].filter((schema) => filterSchemas.has(schema)));
      if (surviving.size === previous.expandedSchemas.size) return previous;
      return surviving.size > 0 ? { focusNodeId: null, expandedSchemas: surviving } : null;
    });
  }, [filterSchemas, setExpandedSchemaView]);

  return {
    clearExpandedSchemaView,
    collapsedSchemaNodeIds,
    collapseExpandedSchemaViewSchema,
    expandAllSchemas,
    expandedSchemaCount: expandedSchemaView?.expandedSchemas.size ?? 0,
    expandedSchemaViewGraph,
    expandedSchemaViewRenderedCount,
    expandExpandedSchemaViewSchema,
    openExpandedSchemaViewForNode,
    toggleExpandedSchemaClusters,
    centerExpandedSchemaViewSchema,
  };
}
