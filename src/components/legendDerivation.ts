import type {
  CustomNodeData,
  SchemaNodeData,
  GraphMode,
  TraceState,
} from '../engine/types';
import { schemaKey } from '../utils/sql';
import { getSchemaColor, type SchemaColorMap } from '../utils/schemaColors';

/** Minimal structural shape of a rendered graph node consumed by the legend derivations. Both overview schema clusters ({@link SchemaNodeData}) and object nodes ({@link CustomNodeData}) satisfy it, so callers pass `localNodes` directly. */
export interface LegendNode {
  /** React Flow node type — `'schemaNode'` for overview clusters, object type otherwise. */
  type?: string;
  /** Node payload, narrowed by {@link LegendNode.type}. */
  data: unknown;
}

/** Derives the schema names shown in the colorful schema legend. */
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

  const isTraceActive =
    traceMode === 'applied' ||
    traceMode === 'path-applied' ||
    traceMode === 'filtered' ||
    traceMode === 'analysis';

  const schemasWithRealObjects = new Set(
    nodes
      .map((n) => n.data as CustomNodeData)
      .filter((d) => d.objectType !== 'external')
      .map((d) => d.schema)
      .filter((s) => !!s && s.trim().length > 0),
  );

  if (!isTraceActive) {
    return (renderedSchemas || []).filter((s) => schemasWithRealObjects.has(s));
  }
  return Array.from(schemasWithRealObjects).filter(Boolean).sort();
}

/** Builds the schema → color map backing the legend swatches. */
export function deriveLegendColorMap(
  nodes: readonly LegendNode[],
  identifierCaseSensitive = false,
): SchemaColorMap {
  const colors: SchemaColorMap = new Map();
  for (const node of nodes) {
    if (node.type === 'schemaNode') {
      const data = node.data as SchemaNodeData;
      if (!data.isExternalOnly) {
        colors.set(
          schemaKey(data.schemaName, identifierCaseSensitive),
          data.color,
        );
      }
      continue;
    }
    const data = node.data as CustomNodeData;
    if (data.objectType !== 'external') {
      colors.set(
        schemaKey(data.schema, identifierCaseSensitive),
        data.schemaColor ??
          getSchemaColor(data.schema, undefined, identifierCaseSensitive),
      );
    }
  }
  return colors;
}
