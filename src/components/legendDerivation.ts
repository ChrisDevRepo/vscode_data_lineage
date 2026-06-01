import type { CustomNodeData } from './CustomNode';
import type { SchemaNodeData, GraphMode, TraceState } from '../engine/types';
import { schemaKey } from '../utils/sql';
import { getSchemaColor, type SchemaColorMap } from '../utils/schemaColors';

/**
 * Minimal structural shape of a rendered graph node consumed by the legend
 * derivations. Both overview schema clusters ({@link SchemaNodeData}) and object
 * nodes ({@link CustomNodeData}) satisfy it, so callers pass `localNodes` directly.
 */
export interface LegendNode {
  /** React Flow node type — `'schemaNode'` for overview clusters, object type otherwise. */
  type?: string;
  /** Node payload, narrowed by {@link LegendNode.type}. */
  data: unknown;
}

/**
 * Derives the schema names shown in the colorful schema legend.
 *
 * @remarks
 * External objects are never palette schemas (they render with the fixed external
 * color), so they are excluded here in lockstep with {@link deriveLegendColorMap},
 * which skips external object nodes. This keeps `deriveLegendSchemas ⊆
 * keys(deriveLegendColorMap)` — the invariant the {@link Legend} relies on when it
 * resolves each listed schema's color.
 *
 * @param nodes - Currently rendered nodes (`localNodes`).
 * @param graphMode - Active graph mode; overview reads schema clusters + object nodes.
 * @param traceMode - Current trace mode, used to widen the set during active traces.
 * @param renderedSchemas - Schemas the parent reports as rendered (non-trace, non-overview).
 * @returns Sorted, de-duplicated schema names with at least one non-external object.
 */
export function deriveLegendSchemas(
  nodes: readonly LegendNode[],
  graphMode: GraphMode,
  traceMode: TraceState['mode'],
  renderedSchemas: string[] | undefined,
): string[] {
  // In overview mode localNodes are SchemaNodeData buckets, plus object nodes for any
  // expanded schema. Externals are excluded so the list matches legendColorMap.
  if (graphMode === 'overview') {
    const schemas = new Set<string>();
    for (const n of nodes) {
      let schema: string | undefined;
      if (n.type === 'schemaNode') {
        schema = (n.data as SchemaNodeData).schemaName;
      } else {
        const data = n.data as CustomNodeData;
        if (data.objectType === 'external') continue;
        schema = data.schema;
      }
      if (schema && schema.trim().length > 0) schemas.add(schema);
    }
    return [...schemas].sort();
  }

  const isTraceActive = traceMode === 'applied' || traceMode === 'path-applied'
    || traceMode === 'filtered' || traceMode === 'analysis';

  // We only show schemas in the legend if they contain at least one non-external object.
  const schemasWithRealObjects = new Set(
    nodes
      .map(n => n.data as CustomNodeData)
      .filter(d => d.objectType !== 'external')
      .map(d => d.schema)
      .filter(s => !!s && s.trim().length > 0)
  );

  if (!isTraceActive) {
    return (renderedSchemas || []).filter(s => schemasWithRealObjects.has(s));
  }
  return Array.from(schemasWithRealObjects).filter(Boolean).sort();
}

/**
 * Builds the schema → color map backing the legend swatches.
 *
 * @remarks
 * Schema clusters carry a pre-computed color; object nodes contribute their schema's
 * color, but external object nodes are skipped (they are not palette schemas). The
 * resulting key set is a superset of {@link deriveLegendSchemas}'s output.
 *
 * @param nodes - Currently rendered nodes (`localNodes`).
 * @returns Map keyed by normalized schema name.
 */
export function deriveLegendColorMap(nodes: readonly LegendNode[]): SchemaColorMap {
  const colors: SchemaColorMap = new Map();
  for (const node of nodes) {
    if (node.type === 'schemaNode') {
      const data = node.data as SchemaNodeData;
      colors.set(schemaKey(data.schemaName), data.color);
      continue;
    }
    const data = node.data as CustomNodeData;
    if (data.objectType !== 'external') {
      colors.set(schemaKey(data.schema), data.schemaColor ?? getSchemaColor(data.schema));
    }
  }
  return colors;
}
