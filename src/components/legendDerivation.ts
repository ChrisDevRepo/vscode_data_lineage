import type { CustomNodeData, SchemaNodeData, GraphMode, TraceState } from '../engine/types';
import { schemaKey } from '../utils/sql';
import { getSchemaColor, type SchemaColorMap } from '../utils/schemaColors';

/**
 * Minimal structural shape of a rendered node the legend derivations read. Overview schema clusters
 * ({@link SchemaNodeData}) and object nodes ({@link CustomNodeData}) both satisfy it, so callers
 * pass `localNodes` directly.
 */
export interface LegendNode {
  /** React Flow node type — `'schemaNode'` for overview clusters, object type otherwise. */
  type?: string;
  /** Node payload, narrowed by {@link LegendNode."type"}. */
  data: unknown;
}

/**
 * Derives the schema names shown in the schema legend. External objects are excluded in lockstep
 * with {@link deriveLegendColorMap} (they use the fixed external color), keeping
 * `deriveLegendSchemas ⊆ keys(deriveLegendColorMap)`, which the {@link Legend} relies on to resolve
 * each listed schema's color.
 *
 * @param graphMode - Overview reads schema clusters + object nodes.
 * @param traceMode - Widens the set during active traces.
 * @param renderedSchemas - Schemas the parent reports as rendered (non-trace, non-overview).
 * @returns Sorted, de-duplicated schema names with at least one non-external object.
 */
export function deriveLegendSchemas(
  nodes: readonly LegendNode[],
  graphMode: GraphMode,
  traceMode: TraceState['mode'],
  renderedSchemas: string[] | undefined,
): string[] {
  if (graphMode === 'overview') {
    const schemas = new Set<string>();
    for (const n of nodes) {
      let schema: string | undefined;
      if (n.type === 'schemaNode') {
        const sd = n.data as SchemaNodeData;
        if (sd.isExternalOnly) continue;
        schema = sd.schemaName;
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
 * Builds the schema → color map behind the legend swatches. Schema clusters carry a pre-computed
 * color; object nodes contribute their schema's, except external ones (not palette schemas). The
 * key set is a superset of {@link deriveLegendSchemas}'s output.
 *
 * @param identifierCaseSensitive - Checked source policy for schema map identity.
 * @returns Map keyed by normalized schema name.
 */
export function deriveLegendColorMap(nodes: readonly LegendNode[], identifierCaseSensitive = false): SchemaColorMap {
  const colors: SchemaColorMap = new Map();
  for (const node of nodes) {
    if (node.type === 'schemaNode') {
      const data = node.data as SchemaNodeData;
      if (!data.isExternalOnly) {
        colors.set(schemaKey(data.schemaName, identifierCaseSensitive), data.color);
      }
      continue;
    }
    const data = node.data as CustomNodeData;
    if (data.objectType !== 'external') {
      colors.set(schemaKey(data.schema, identifierCaseSensitive), data.schemaColor ?? getSchemaColor(data.schema, undefined, identifierCaseSensitive));
    }
  }
  return colors;
}
