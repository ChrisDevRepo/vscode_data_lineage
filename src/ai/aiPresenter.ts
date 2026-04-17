/**
 * AI presentation layer — the single place that controls what the AI sees.
 *
 * Zero business logic. Zero VS Code imports. Transforms internal model types
 * into compact, token-optimized shapes for the LLM. Change field names or
 * format strategies here; all tools automatically update.
 */
import type { LineageNode, ColumnDef, SchemaInfo, NeighborIndex } from '../engine/types';
import type { SerializedFilterState } from '../engine/projectStore';


/** 
 * Prunes null, undefined, false, empty strings, and empty arrays from a record.
 * 
 * @remarks
 * This is a critical token-optimization utility. By removing "zero-signal" fields
 * before serialization, we significantly reduce the context window pressure
 * for large database models without losing semantic information.
 * 
 * @param obj - The plain object to be stripped.
 * @returns A partial version of the input object containing only truthy/non-empty values.
 */
export function strip<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) =>
      v !== null && v !== undefined && v !== false && v !== '' &&
      !(Array.isArray(v) && v.length === 0)
    )
  ) as Partial<T>;
}

const EDGE_TYPE_MAP: Record<string, string> = { body: 'read', write: 'write', exec: 'exec', read: 'read' };
const NULLABLE_VALUES = new Set(['true', 'True', 'NULL']);

/** 
 * Standardizes internal edge types into an AI-consumable API nomenclature.
 * 
 * @param type - The raw edge type from the graph engine.
 * @returns A simplified string representing the data flow direction (e.g., 'read', 'write', 'exec').
 */
export function edgeApiType(type: string): string {
  return EDGE_TYPE_MAP[type] ?? 'read';
}


/** 
 * A minimal representation of a database node, used for cross-layer presentation.
 */
export type PresentableNode = Pick<LineageNode, 'id' | 'schema' | 'name' | 'type'> & { 
  /** Optional metadata for external/linked resources. */
  externalType?: string 
};

/**
 * Transforms a database node into a compact, token-optimized JSON representation.
 * 
 * @remarks
 * Keys are intentionally abbreviated (`s`=schema, `n`=name, `t`=type, `deg`=degree) 
 * to minimize the footprint in search results and BFS discovery payloads.
 *
 * @param node - The node to transform.
 * @param neighborIndex - Optional index to calculate connection density (degree).
 * @returns A stripped record suitable for AI consumption.
 */
export function presentNode(
  node: PresentableNode,
  neighborIndex?: NeighborIndex,
): Record<string, unknown> {
  const entry = neighborIndex?.[node.id];
  const deg = entry !== undefined
    ? entry.in.length + entry.out.length
    : undefined;
  return strip({
    id:  node.id,
    s:   node.schema,
    n:   node.name,
    t:   node.type,
    deg,
    ext: node.externalType || undefined,
  } as Record<string, unknown>);
}

/**
 * Transforms a column definition into a compact, token-optimized JSON representation.
 * 
 * @remarks
 * Optimized for `getObjectDetail` responses. Abbreviates constraints 
 * (`nl`=nullable, `pk`=primary key, `uq`=unique, `ck`=check).
 *
 * @param col - The column metadata to transform.
 * @returns A stripped record containing the column's semantic properties.
 */
export function presentColumn(col: ColumnDef): Record<string, unknown> {
  return strip({
    n:  col.name,
    t:  col.type,
    nl: col.nullable  || undefined,
    pk: col.pkOrdinal ?? undefined,
    uq: col.unique    || undefined,
    ck: col.check     || undefined,
  } as Record<string, unknown>);
}

/**
 * Generates a human-readable, single-line summary of a column's properties.
 * 
 * @remarks
 * Designed for "Hop Context" where the AI reads natural language lists more 
 * effectively than dense JSON arrays. 
 * Format: `[Name] [Type], [Nullable], [Constraints]`
 *
 * @param col - The column metadata to summarize.
 * @returns A comma-delimited string of column attributes.
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

/**
 * Summarizes a Foreign Key relationship in a compact "pointer" format.
 * 
 * @param fk - The foreign key metadata.
 * @returns A string in the format `ColumnA, ColumnB → Schema.Table`.
 */
export function presentFkCompact(fk: { columns: string[]; refSchema: string; refTable: string }): string {
  return `${fk.columns.join(', ')} → ${fk.refSchema}.${fk.refTable}`;
}

/**
 * Transforms schema-level statistics into a compact JSON representation.
 * 
 * @remarks
 * Used in `getContext` to provide a bird's-eye view of the database structure.
 *
 * @param schema - The schema summary to transform.
 * @returns A stripped record containing node and type counts.
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
  } as Record<string, unknown>);
}

/**
 * Presents a neighboring node and its relationship to the focus object.
 * 
 * @remarks
 * Used to build `upstream` and `downstream` arrays in `getObjectDetail`.
 * Includes the specific edge type to distinguish between data flow and execution flow.
 *
 * @param nid - The unique ID of the neighbor.
 * @param originId - The unique ID of the object currently being inspected.
 * @param nodeMap - Global lookup for node metadata.
 * @param edgeMap - Global lookup for edge metadata.
 * @param isUpstream - Directionality of the relationship.
 * @returns A compact representation of the neighbor and the connecting edge.
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
  } as Record<string, unknown>);
}

/**
 * Compresses the current UI filter state for AI consumption.
 * 
 * @remarks
 * Replaces large ID allow-lists with simple counts to save significant token space
 * while still informing the AI about the user's focus.
 *
 * @param filter - The raw filter state from the project store.
 * @returns A compact representation of active search, schema, and type filters.
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
  } as Record<string, unknown>);
}

