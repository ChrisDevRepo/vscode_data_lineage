/**
 * Projects internal lineage models into compact model-facing payloads. No VS Code dependencies or
 * domain decisions; tool handlers share these projections so field naming and compaction stay
 * consistent.
 */
import { columnFacts } from '../../engine/shared/columnFacts';
import type { LineageEdge, LineageNode, ColumnDef, SchemaInfo, NeighborIndex, ForeignKeyInfo } from '../../engine/types';
import type { SerializedFilterState } from '../../engine/projectStore';


/** Prunes null, undefined, false, empty strings and empty arrays from a record (shallow copy). */
export function strip<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) =>
      v !== null && v !== undefined && v !== false && v !== '' &&
      !(Array.isArray(v) && v.length === 0)
    )
  ) as Partial<T>;
}

const EDGE_TYPE_MAP: Record<string, string> = { body: 'read', exec: 'exec' };
const NULLABLE_VALUES = new Set(['true', 'True', 'NULL']);

/**
 * Standardizes internal edge types into the AI-facing nomenclature ('read', 'write', 'delete',
 * 'exec'). `LineageEdge.type` records provenance (`body` vs `exec`), never direction: the engine
 * orders a `body` edge's endpoints by write-vs-read but discards the verb. Only a procedure emits
 * an outbound `body` edge for a mutation; every other `body` source is a read. A write marked
 * `deleteOnly` is a `delete`: it removes rows and supplies no data.
 */
export function edgeApiType(edge: Pick<LineageEdge, 'type' | 'deleteOnly'>, sourceNodeType: string): string {
  if (edge.type === 'body' && sourceNodeType === 'procedure') return edge.deleteOnly ? 'delete' : 'write';
  return EDGE_TYPE_MAP[edge.type] ?? 'read';
}


/** A minimal database node for cross-layer presentation. */
type PresentableNode = Pick<LineageNode, 'id' | 'schema' | 'name' | 'type'> & {
  /** Optional metadata for external/linked resources. */
  externalType?: string
};

/**
 * Optional context that lets {@link presentNode} serve a node's `in`/`out` neighbor split instead
 * of only the scalar `deg`.
 */
export type NodeNeighborSplitContext = {
  /** Full node lookup, needed to resolve each neighbor id to its schema/name/type. */
  nodeMap: Map<string, LineageNode>;
  /** `"source→target"` to API edge type, as built by `buildEdgeTypeMap`. */
  edgeTypeMap: Map<string, string>;
};

/**
 * Transforms a database node into a compact, token-optimized record. Keys are abbreviated
 * (`s`=schema, `n`=name, `t`=type, `deg`=degree). `deg` alone cannot answer "which side", so
 * `splitContext` (with a `neighborIndex` entry) adds `in`/`out` neighbor arrays; omitted elsewhere
 * so the payload only grows where requested.
 *
 * @param neighborIndex - Optional index to calculate connection density (degree).
 */
export function presentNode(
  node: PresentableNode,
  neighborIndex?: NeighborIndex,
  splitContext?: NodeNeighborSplitContext,
): Record<string, unknown> {
  const entry = neighborIndex?.[node.id];
  const deg = entry !== undefined
    ? entry.in.length + entry.out.length
    : undefined;
  const inSplit = entry && splitContext
    ? entry.in.map(nid => presentNeighbor(nid, node.id, splitContext.nodeMap, splitContext.edgeTypeMap, true))
    : undefined;
  const outSplit = entry && splitContext
    ? entry.out.map(nid => presentNeighbor(nid, node.id, splitContext.nodeMap, splitContext.edgeTypeMap, false))
    : undefined;
  return strip({
    id:  node.id,
    s:   node.schema,
    n:   node.name,
    t:   node.type,
    deg,
    in:  inSplit,
    out: outSplit,
    ext: node.externalType || undefined,
  });
}

/**
 * Serializes a column's {@link columnFacts} for `getObjectDetail`, abbreviating them
 * (`nl`=nullable, `pk`=primary key, `uq`=unique, `ck`=check, `ex`=IDENTITY/COMPUTED).
 * A fact the model does not declare is omitted, never invented.
 */
export function presentColumn(col: ColumnDef): Record<string, unknown> {
  const f = columnFacts(col);
  return {
    ...strip({ n: f.name, t: f.type }),
    ...(f.nullable !== undefined && { nl: f.nullable }),
    ...strip({ pk: f.pk, uq: f.unique, ck: f.check, ex: f.extra }),
  };
}

/**
 * Generates a single-line column summary, `[Name] [Type], [Nullable], [Constraints]`, for "Hop
 * Context", where the AI reads natural language lists more effectively than dense JSON arrays.
 */
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

/** Summarizes a Foreign Key in a compact "pointer" format, `ColumnA, ColumnB → Schema.Table`. */
export function presentFkCompact(fk: { columns: string[]; refSchema: string; refTable: string }): string {
  return `${fk.columns.join(', ')} → ${fk.refSchema}.${fk.refTable}`;
}

/** Maps a node's foreign keys to the snake_case model-facing shape; `undefined` without `fks`. */
export function presentForeignKeys(
  fks: ForeignKeyInfo[] | undefined,
): Array<Record<string, unknown>> | undefined {
  return fks?.map(fk => ({
    name: fk.name,
    columns: fk.columns,
    ref_schema: fk.refSchema,
    ref_table: fk.refTable,
    ref_columns: fk.refColumns,
    on_delete: fk.onDelete,
  }));
}

/**
 * Transforms schema-level statistics into a compact record (node and type counts); used in
 * `getContext` for a bird's-eye view of the database structure.
 */
export function presentSchema(schema: SchemaInfo): Record<string, unknown> {
  return strip({
    name: schema.name,
    n:    schema.nodeCount,
    t:    schema.types['table']     || undefined,
    v:    schema.types['view']      || undefined,
    p:    schema.types['procedure'] || undefined,
    f:    schema.types['function']  || undefined,
    ext:  schema.types['external']  || undefined,
  });
}

/**
 * Presents a neighboring node and its relationship to the focus object, for the
 * `upstream`/`downstream` arrays in `getObjectDetail`. Includes the edge type to distinguish data
 * flow from execution flow.
 *
 * @param nid - The neighbor's id.
 * @param originId - The id of the object being inspected.
 * @param nodeMap - Global lookup for node metadata.
 * @param edgeMap - Global lookup for edge metadata.
 */
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
    s:  n?.schema || undefined,
    n:  n?.name   ?? nid,
    t:  n?.type   || undefined,
    e:  edgeMap.get(edgeKey) ?? 'read',
  });
}

/**
 * Compresses the current UI filter state for AI consumption: large ID allow-lists become counts,
 * saving tokens while still showing the user's focus.
 */
export function presentFilter(filter: SerializedFilterState): Record<string, unknown> {
  const bookmarkCount = filter.allowlistNodeIds?.length;
  return strip({
    schemas:           filter.schemas.length > 0 ? filter.schemas : undefined,
    types:             filter.types.length > 0 ? filter.types : undefined,
    searchTerm:        filter.searchTerm        || undefined,
    hideIsolated:      filter.hideIsolated       || undefined,
    focusSchemas:      filter.focusSchemas?.length > 0 ? filter.focusSchemas : undefined,
    showExternalRefs:  filter.showExternalRefs   || undefined,
    externalRefTypes:  filter.externalRefTypes?.length > 0 ? filter.externalRefTypes : undefined,
    exclusionPatterns: filter.exclusionPatterns?.length ? filter.exclusionPatterns : undefined,
    bookmark_nodes:    bookmarkCount && bookmarkCount > 0 ? bookmarkCount : undefined,
  });
}
