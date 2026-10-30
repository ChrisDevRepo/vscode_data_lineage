/** Projects internal lineage models into compact model-facing payloads. */
import type {
  LineageNode,
  ColumnDef,
  SchemaInfo,
  NeighborIndex,
  ForeignKeyInfo,
} from '../../engine/types';
import type { SerializedFilterState } from '../../engine/projectStore';

/** Prunes null, undefined, false, empty strings, and empty arrays from a record. */
export function strip<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([, v]) =>
        v !== null &&
        v !== undefined &&
        v !== false &&
        v !== '' &&
        !(Array.isArray(v) && v.length === 0),
    ),
  ) as Partial<T>;
}

const EDGE_TYPE_MAP: Record<string, string> = { body: 'read', exec: 'exec' };
const NULLABLE_VALUES = new Set(['true', 'True', 'NULL']);

/** Standardizes internal edge types into an AI-consumable API nomenclature. */
export function edgeApiType(type: string, sourceNodeType: string): string {
  if (type === 'body' && sourceNodeType === 'procedure') return 'write';
  return EDGE_TYPE_MAP[type] ?? 'read';
}

/** A minimal representation of a database node, used for cross-layer presentation. */
type PresentableNode = Pick<LineageNode, 'id' | 'schema' | 'name' | 'type'> & {
  /** Optional metadata for external/linked resources. */
  externalType?: string;
};

/** Optional context that enables {@link presentNode} to serve a node's `in`/`out` neighbor split in the same shape `buildHopFocusNode` uses for the hop_context route, instead of only the scalar `deg`. */
type NodeNeighborSplitContext = {
  /** Full node lookup, needed to resolve each neighbor id to its schema/name/type. */
  nodeMap: Map<string, LineageNode>;
  /** `"source→target"` to API edge type, as built by `buildEdgeTypeMap`. */
  edgeTypeMap: Map<string, string>;
};

/** Transforms a database node into a compact, token-optimized JSON representation. */
export function presentNode(
  node: PresentableNode,
  neighborIndex?: NeighborIndex,
  splitContext?: NodeNeighborSplitContext,
): Record<string, unknown> {
  const entry = neighborIndex?.[node.id];
  const deg =
    entry !== undefined ? entry.in.length + entry.out.length : undefined;
  const inSplit =
    entry && splitContext
      ? entry.in.map((nid) =>
          presentNeighbor(
            nid,
            node.id,
            splitContext.nodeMap,
            splitContext.edgeTypeMap,
            true,
          ),
        )
      : undefined;
  const outSplit =
    entry && splitContext
      ? entry.out.map((nid) =>
          presentNeighbor(
            nid,
            node.id,
            splitContext.nodeMap,
            splitContext.edgeTypeMap,
            false,
          ),
        )
      : undefined;
  return strip({
    id: node.id,
    s: node.schema,
    n: node.name,
    t: node.type,
    deg,
    in: inSplit,
    out: outSplit,
    ext: node.externalType || undefined,
  });
}

/** Transforms a column definition into a compact, token-optimized JSON representation. */
export function presentColumn(col: ColumnDef): Record<string, unknown> {
  return strip({
    n: col.name,
    t: col.type,
    nl: col.nullable || undefined,
    pk: col.pkOrdinal ?? undefined,
    uq: col.unique || undefined,
    ck: col.check || undefined,
  });
}

/** Generates a human-readable, single-line summary of a column's properties. */
export function presentColumnCompact(col: ColumnDef): string {
  const parts = [col.name];
  if (col.extra === 'COMPUTED') {
    parts.push('COMPUTED');
    return parts.join(' ');
  }
  if (col.type) parts.push(col.type);
  parts.push(NULLABLE_VALUES.has(col.nullable ?? '') ? 'nullable' : 'not null');
  if (col.pkOrdinal) parts.push('PK');
  if (col.unique) parts.push('UQ');
  if (col.check) parts.push('CK');
  return parts.join(', ');
}

/** Summarizes a Foreign Key relationship in a compact "pointer" format. */
export function presentFkCompact(fk: {
  columns: string[];
  refSchema: string;
  refTable: string;
}): string {
  return `${fk.columns.join(', ')} → ${fk.refSchema}.${fk.refTable}`;
}

/** Maps a node's foreign keys to the snake_case model-facing shape. */
export function presentForeignKeys(
  fks: ForeignKeyInfo[] | undefined,
): Array<Record<string, unknown>> | undefined {
  return fks?.map((fk) => ({
    name: fk.name,
    columns: fk.columns,
    ref_schema: fk.refSchema,
    ref_table: fk.refTable,
    ref_columns: fk.refColumns,
    on_delete: fk.onDelete,
  }));
}

/** Transforms schema-level statistics into a compact JSON representation. */
export function presentSchema(schema: SchemaInfo): Record<string, unknown> {
  return strip({
    name: schema.name,
    n: schema.nodeCount,
    t: schema.types['table'] || undefined,
    v: schema.types['view'] || undefined,
    p: schema.types['procedure'] || undefined,
    f: schema.types['function'] || undefined,
    ext: schema.types['external'] || undefined,
  });
}

/** Presents a neighboring node and its relationship to the focus object. */
export function presentNeighbor(
  nid: string,
  originId: string,
  nodeMap: Map<string, LineageNode>,
  edgeMap: Map<string, string>,
  isUpstream: boolean,
): Record<string, unknown> {
  const n = nodeMap.get(nid);
  const edgeKey = isUpstream ? `${nid}→${originId}` : `${originId}→${nid}`;
  return strip({
    id: nid,
    s: n?.schema || undefined,
    n: n?.name ?? nid,
    t: n?.type || undefined,
    e: edgeMap.get(edgeKey) ?? 'read',
  });
}

/** Compresses the current UI filter state for AI consumption. */
export function presentFilter(
  filter: SerializedFilterState,
): Record<string, unknown> {
  const bookmarkCount = filter.allowlistNodeIds?.length;
  return strip({
    schemas: filter.schemas.length > 0 ? filter.schemas : undefined,
    types: filter.types.length > 0 ? filter.types : undefined,
    searchTerm: filter.searchTerm || undefined,
    hideIsolated: filter.hideIsolated || undefined,
    focusSchemas:
      filter.focusSchemas?.length > 0 ? filter.focusSchemas : undefined,
    showExternalRefs: filter.showExternalRefs || undefined,
    externalRefTypes:
      filter.externalRefTypes?.length > 0 ? filter.externalRefTypes : undefined,
    exclusionPatterns: filter.exclusionPatterns?.length
      ? filter.exclusionPatterns
      : undefined,
    bookmark_nodes:
      bookmarkCount && bookmarkCount > 0 ? bookmarkCount : undefined,
  });
}
