/**
 * AI presentation layer — the single place that controls what the AI sees.
 *
 * Zero business logic. Zero VS Code imports. Transforms internal model types
 * into compact, token-optimized shapes for the LLM. Change field names or
 * format strategies here; all tools automatically update.
 */
import type { LineageNode, ColumnDef, SchemaInfo, NeighborIndex } from '../engine/types';
import type { SerializedFilterState } from '../engine/projectStore';

// ─── Core helpers ─────────────────────────────────────────────────────────────

/** Strip null / undefined / false / '' / [] from a plain object before sending to the LLM. */
export function strip<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) =>
      v !== null && v !== undefined && v !== false && v !== '' &&
      !(Array.isArray(v) && v.length === 0)
    )
  ) as Partial<T>;
}

/** Map internal edge types to the AI-facing API name. */
export function edgeApiType(type: string): string {
  return type === 'body' ? 'read' : type;
}

// ─── Compact shape presenters ─────────────────────────────────────────────────

/** Minimal node shape accepted by presentNode — satisfied by both LineageNode and SearchableNode. */
export type PresentableNode = Pick<LineageNode, 'id' | 'schema' | 'name' | 'type'> & { externalType?: string };

/**
 * Compact node shape used in search results and BFS nodes.
 * `deg` = total connection count (in + out). Only included when neighborIndex is provided.
 * `ext` = externalType — only when present.
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
 * Compact column shape used in getObjectDetail.
 * `nl` = nullable, `pk` = primary key ordinal, `uq` = unique, `ck` = check constraint.
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
 * Compact schema shape used in getSchemasSummary.
 * Type counts stripped when zero.
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
 * Compact neighbor shape used in inline up/dn arrays in getObjectDetail.
 * `e` = edge type ('read' | 'exec').
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
  return {
    id: nid,
    s:  n?.schema ?? '',
    n:  n?.name   ?? nid,
    t:  n?.type   ?? 'table',
    e:  edgeMap.get(edgeKey) ?? 'read',
  };
}

/**
 * Compact filter shape used in getContext.
 * Replaces `allowlistNodeIds` (up to ~1,250 tokens) with `bookmark_nodes: N` (count only).
 * Strips empty arrays and falsy values.
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

/**
 * Cap an array and return capped slice + metadata.
 * Use `capped` as the response array, `total`/`truncated` as envelope fields.
 */
export function withCap<T>(
  items: T[],
  cap: number,
): { capped: T[]; total: number; truncated: boolean } {
  const truncated = items.length > cap;
  return {
    capped:    truncated ? items.slice(0, cap) : items,
    total:     items.length,
    truncated,
  };
}
