/**
 * AI tool pure functions — zero VS Code imports.
 * All 9 functions are invoked by the registered LanguageModelTools in extension.ts.
 *
 * This file owns RETRIEVAL ONLY. All formatting/normalization lives in aiPresenter.ts.
 */
import { bfsFromNode } from 'graphology-traversal';
import type Graph from 'graphology';
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type LineageNode,
  type ObjectType,
  type AnalysisType,
} from '../engine/types';
import { runAnalysis as runGraphAnalysis } from '../engine/graphAnalysis';
import { searchCatalog, searchBodyScripts, safeRegex, type SearchableNode } from '../utils/modelSearch';
import { normalizeBodyScript, compileSqlLikePatterns, matchesAnySqlLike } from '../utils/sql';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentSchema, presentNeighbor, presentFilter,
} from './aiPresenter';

// ─── Caps ────────────────────────────────────────────────────────────────────

export const AI_CAPS = {
  BFS_MAX_NODES:       200,
  BFS_MAX_EDGES:       300,
  SEARCH_MAX_RESULTS:   50,
  REGEX_MAX_LENGTH:    200,
  ANALYSIS_MAX_GROUPS: 100,
  MAX_DDL_CHARS:     10000,   // per object; 500000 = effectively unlimited
  DDL_BATCH_CAP:        20,   // max IDs per getDdlBatch call
} as const;

/** Mutable override type for per-request cap tuning (auto-scale + VS Code settings). */
export type AiCapsOverride = { [K in keyof typeof AI_CAPS]?: number };

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Number of context lines shown in DDL/body search snippets. */
const SNIPPET_CONTEXT_LINES = 2;

/** Build source→target edge type lookup for the entire model (cheap one-pass). */
function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e.type));
  }
  return m;
}

/** Build id→node lookup. */
function buildNodeMap(model: DatabaseModel): Map<string, LineageNode> {
  const m = new Map<string, LineageNode>();
  for (const n of model.nodes) m.set(n.id, n);
  return m;
}

/** Build lowercase "Schema.Name" → unrelated refs lookup from parse stats. */
function buildUnrelatedMap(model: DatabaseModel): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!model.parseStats?.spDetails) return m;
  for (const d of model.parseStats.spDetails) {
    if (d.unrelated?.length) {
      m.set(d.name.toLowerCase(), d.unrelated.map(r => r.replace(/ \(exec\)$/, '')));
    }
  }
  return m;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type NotFoundError = { error: 'not_found'; id: string; hint: string };
export type InvalidRegex  = { error: 'invalid_regex'; hint: string };

// ─── Tool 1: lineage_get_context ─────────────────────────────────────────────

/** Threshold: models at or below this size include full object catalog in get_context. */
const SMALL_MODEL_THRESHOLD = 150;

export function getContext(
  model: DatabaseModel,
  activeFilter: SerializedFilterState | null,
  projectName: string | null,
  savedViews: FilterProfile[],
) {
  const visibleNodes = activeFilter
    ? model.nodes.filter(n => {
        const schemas = new Set(activeFilter.schemas);
        const types   = new Set(activeFilter.types);
        if (schemas.size > 0 && !schemas.has(n.schema)) return false;
        if (types.size > 0 && !types.has(n.type)) return false;
        return true;
      }).length
    : model.nodes.length;

  const isSmall = model.nodes.length <= SMALL_MODEL_THRESHOLD;

  return {
    project_name:  projectName,
    source_type:   model.dbPlatform ? 'database' : 'dacpac',
    db_platform:   model.dbPlatform ?? null,
    model_size:    isSmall ? 'small' as const : 'large' as const,
    model_stats:   { nodes: model.nodes.length, edges: model.edges.length },
    schemas:       model.schemas.map(s => presentSchema(s)),
    visible_nodes: visibleNodes,
    filter:        activeFilter ? presentFilter(activeFilter) : null,
    saved_views:   savedViews.map(v => ({ id: v.id, name: v.name })),
    // Small model: include full catalog so AI can skip search_objects and go straight to BFS
    ...(isSmall && {
      objects: model.nodes.map(n => presentNode(n, model.neighborIndex)),
    }),
    // Large model: tell AI how many refs are outside the loaded model
    ...(!isSmall && model.parseStats && {
      unresolved_ref_count: model.parseStats.droppedRefs?.length ?? 0,
    }),
  };
}

// ─── Tool 2: lineage_get_schema_summary ──────────────────────────────────────

export function getSchemasSummary(model: DatabaseModel) {
  return {
    schemas:     model.schemas.map(s => presentSchema(s)),
    total_nodes: model.nodes.length,
    total_edges: model.edges.length,
  };
}

// ─── Smart search middleware ─────────────────────────────────────────────────

/** Result of parsing a smart query like "financehub.revenue" or "financehub revenue". */
export type SmartQueryResult =
  | { ok: true; nameQuery: string; schemaHints: string[] | null }
  | { ok: false; error: string; hint: string };

/**
 * Parse a natural-language query into name query + schema hints.
 * - "financehub.revenue" → schema hint "financehub", name "revenue"
 * - "financehub revenue" → if "financehub" matches a known schema, split; otherwise treat as single query
 * - "revenue" → no schema hint
 * - "." / "*" / single char → rejected as too broad
 *
 * Schema matching is case-insensitive substring: "financehub" matches "consumption_financehub".
 */
export function parseSmartQuery(
  query: string,
  schemaNames: string[],
): SmartQueryResult {
  const trimmed = query.trim();
  // Reject garbage: empty, single char, or pure wildcards
  if (trimmed.length < 2) {
    return { ok: false, error: 'query_too_short', hint: 'Use at least 2 characters. To filter by schema, use the schemas[] parameter.' };
  }
  if (/^[.*?+^$]+$/.test(trimmed)) {
    return { ok: false, error: 'query_too_broad', hint: 'Query matches everything. Be more specific or use schemas[] to narrow scope.' };
  }

  // Dot-split: "financehub.revenue" → schema hint + name
  const dotIdx = trimmed.indexOf('.');
  if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
    const left = trimmed.slice(0, dotIdx).trim();
    const right = trimmed.slice(dotIdx + 1).trim();
    if (left.length > 0 && right.length > 0) {
      const matched = findMatchingSchemas(left, schemaNames);
      if (matched.length > 0) {
        return { ok: true, nameQuery: right, schemaHints: matched };
      }
      // Dot present but left doesn't match any schema — treat as single query
    }
  }

  // Space-split: "financehub revenue" → try left as schema hint
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx > 0 && spaceIdx < trimmed.length - 1) {
    const left = trimmed.slice(0, spaceIdx).trim();
    const right = trimmed.slice(spaceIdx + 1).trim();
    if (left.length >= 2 && right.length >= 1) {
      const matched = findMatchingSchemas(left, schemaNames);
      if (matched.length > 0) {
        return { ok: true, nameQuery: right, schemaHints: matched };
      }
    }
    // No schema match — fall through to use full query
  }

  return { ok: true, nameQuery: trimmed, schemaHints: null };
}

/** Case-insensitive substring match of hint against known schema names. */
function findMatchingSchemas(hint: string, schemaNames: string[]): string[] {
  const lower = hint.toLowerCase();
  return schemaNames.filter(s => s.toLowerCase().includes(lower));
}

// ─── Tool 3: lineage_search_objects ──────────────────────────────────────────

export function searchObjects(
  model: DatabaseModel,
  query: string,
  types?: ObjectType[],
  schemas?: string[],
  externalSubtypes?: ('et' | 'file' | 'db')[],
  includeBody?: boolean,
  excludeSchemas?: string[],
  excludeTypes?: ObjectType[],
  mode: 'substring' | 'regex' = 'substring',
  caps?: AiCapsOverride,
) {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (query.length > effectiveCaps.REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: `Query exceeds maximum length of ${effectiveCaps.REGEX_MAX_LENGTH} characters.` };
  }

  let effectiveQuery = query;
  let effectiveSchemas = schemas;

  // Smart search middleware: only for substring mode (regex syntax conflicts with schema.name splitting)
  if (mode !== 'regex') {
    const schemaNames = model.schemas.map(s => s.name);
    const parsed = parseSmartQuery(query, schemaNames);
    if (!parsed.ok) {
      return { error: parsed.error, hint: parsed.hint };
    }
    effectiveQuery = parsed.nameQuery;
    if (parsed.schemaHints) {
      effectiveSchemas = effectiveSchemas
        ? [...new Set([...effectiveSchemas, ...parsed.schemaHints])]
        : parsed.schemaHints;
    }
  }

  const typeSet                = types         ? new Set<ObjectType>(types)           : undefined;
  const schemaSet              = effectiveSchemas ? new Set<string>(effectiveSchemas)   : undefined;
  const excludeTypeSet         = excludeTypes  ? new Set<ObjectType>(excludeTypes)    : null;
  // exclude_schemas: SQL-style patterns — % matches any sequence; all other chars literal (case-insensitive)
  const excludeSchemaMatchers  = compileSqlLikePatterns(excludeSchemas);

  const nameHits = searchCatalog(
    model.nodes as SearchableNode[],
    effectiveQuery,
    typeSet,
    schemaSet,
    effectiveCaps.SEARCH_MAX_RESULTS,
    mode,
  );

  // Apply externalSubtypes + exclude filters
  const externalSet = externalSubtypes && externalSubtypes.length > 0 ? new Set(externalSubtypes) : null;
  const filtered = nameHits.filter(n => {
    if (externalSet && n.type === 'external' && !(n.externalType && externalSet.has(n.externalType as 'et' | 'file' | 'db'))) return false;
    if (excludeSchemaMatchers && matchesAnySqlLike(n.schema, excludeSchemaMatchers)) return false;
    if (excludeTypeSet        && excludeTypeSet.has(n.type))                  return false;
    return true;
  });

  const nameResults = filtered.map(n => ({
    ...presentNode(n, model.neighborIndex),
    match: 'name' as const,
  }));

  let results: object[] = nameResults;
  let bodyTruncated = false;

  if (includeBody) {
    // Body types = intersection of requested types with body-scriptable types
    const scriptableTypes: ObjectType[] = ['view', 'procedure', 'function'];
    const bodyTypeSet: Set<ObjectType> = typeSet
      ? new Set(scriptableTypes.filter(t => typeSet.has(t)))
      : new Set<ObjectType>(scriptableTypes);

    if (bodyTypeSet.size > 0) {
      const bodyHits = searchBodyScripts(
        model.nodes as SearchableNode[],
        effectiveQuery,
        bodyTypeSet,
        SNIPPET_CONTEXT_LINES,
        effectiveCaps.SEARCH_MAX_RESULTS,
      );
      bodyTruncated = bodyHits.length >= effectiveCaps.SEARCH_MAX_RESULTS;
      // Deduplicate against name hits using source node IDs (typed — avoids casting nameResults)
      const seenIds = new Set(filtered.map(n => n.id));
      const bodyResults = bodyHits
        .filter(m => !seenIds.has(m.node.id))
        .map(m => ({
          ...presentNode(m.node, model.neighborIndex),
          match: 'body' as const,
          snippet: m.snippet,
        }));
      results = [...nameResults, ...bodyResults];
    }
  }

  const base = {
    results,
    total:     results.length,
    truncated: nameHits.length >= effectiveCaps.SEARCH_MAX_RESULTS || bodyTruncated,
  };

  if (results.length === 0) {
    return { ...base, hint: 'No matches. Try a shorter substring, check spelling, or use schema names from lineage_get_context.' };
  }
  return base;
}

// ─── Tool 4: lineage_get_object_detail ───────────────────────────────────────

const NEIGHBOR_CAP = 25;

export function getObjectDetail(
  model: DatabaseModel,
  id: string,
  caps?: AiCapsOverride,
): object {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;

  const nodeMap   = buildNodeMap(model);
  const node      = nodeMap.get(id);
  if (!node) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }

  const neighbors = model.neighborIndex[id] ?? { in: [], out: [] };
  const edgeMap   = buildEdgeTypeMap(model);

  const upRaw  = neighbors.in;
  const dnRaw  = neighbors.out;
  const up     = upRaw.slice(0, NEIGHBOR_CAP).map(nid => presentNeighbor(nid, id, nodeMap, edgeMap, true));
  const dn     = dnRaw.slice(0, NEIGHBOR_CAP).map(nid => presentNeighbor(nid, id, nodeMap, edgeMap, false));
  const upMore = Math.max(0, upRaw.length - NEIGHBOR_CAP);
  const dnMore = Math.max(0, dnRaw.length - NEIGHBOR_CAP);

  const columns    = node.columns?.map(c => presentColumn(c)) ?? undefined;
  const foreignKeys = node.fks?.map(fk => ({
    name:        fk.name,
    columns:     fk.columns,
    ref_schema:  fk.refSchema,
    ref_table:   fk.refTable,
    ref_columns: fk.refColumns,
    on_delete:   fk.onDelete,
  })) ?? null;

  const base: Record<string, unknown> = strip({
    id:           node.id,
    schema:       node.schema,
    name:         node.name,
    type:         node.type,
    external_type: node.externalType || undefined,
    external_url:  node.externalUrl  || undefined,
    columns,
    foreign_keys:  foreignKeys || undefined,
    up:            up.length > 0 ? up : undefined,
    dn:            dn.length > 0 ? dn : undefined,
    up_more:       upMore > 0 ? upMore : undefined,
    dn_more:       dnMore > 0 ? dnMore : undefined,
  } as Record<string, unknown>);

  const ddl = node.bodyScript ? normalizeBodyScript(node.bodyScript) : null;

  // Attach unresolved refs for scriptable nodes
  const unrelMap = buildUnrelatedMap(model);
  const unrelKey = `${node.schema}.${node.name}`.toLowerCase();
  const unresolved_refs = unrelMap.get(unrelKey) ?? undefined;

  if (ddl && ddl.length > effectiveCaps.MAX_DDL_CHARS) {
    return {
      ...base,
      ddl: null,
      ddl_too_large: true,
      ddl_chars: ddl.length,
      ddl_hint: `DDL is ${ddl.length} chars, limit is ${effectiveCaps.MAX_DDL_CHARS}. ` +
                `Raise dataLineageViz.ai.maxDdlChars (max 500000) or use a large-context model (auto-scales).`,
      unresolved_refs,
    };
  }

  return { ...base, ddl, unresolved_refs };
}

// ─── Tool 5: lineage_run_bfs_trace ────────────────────────────────────────────
// Compound tool: BFS + optional DDL/columns per node (include_ddl=true, the default).
// For scriptable nodes (procedure/view/function): includes normalized DDL.
// For table/external nodes: includes compact column list instead.
// Include filters (types/schemas) are applied first; exclude filters are post-filters.
// excluded_count is added to the response when any exclusions were applied.

const SCRIPT_TYPES: Set<ObjectType> = new Set(['view', 'procedure', 'function']);

/** Run bidirectional BFS and return depth maps for each direction. */
function executeBfs(
  graph: Graph, id: string, upstreamHops: number, downstreamHops: number,
): { upDepth: Map<string, number>; downDepth: Map<string, number> } {
  const upDepth   = new Map<string, number>();
  const downDepth = new Map<string, number>();
  if (upstreamHops > 0) {
    bfsFromNode(graph, id, (node, _attr, depth) => {
      if (depth > upstreamHops) return true;
      upDepth.set(node, depth);
    }, { mode: 'inbound' });
  }
  upDepth.set(id, 0);
  if (downstreamHops > 0) {
    bfsFromNode(graph, id, (node, _attr, depth) => {
      if (depth > downstreamHops) return true;
      downDepth.set(node, depth);
    }, { mode: 'outbound' });
  }
  downDepth.set(id, 0);
  return { upDepth, downDepth };
}

/** Apply include + exclude filters to a node ID set. Returns filtered IDs and excluded count. */
function applyBfsFilters(
  allNodeIds: Set<string>,
  nodeMap: Map<string, LineageNode>,
  typeSet: Set<ObjectType> | null,
  schemaSet: Set<string> | null,
  excludeSchemaMatchers: RegExp[] | null,
  excludeTypeSet: Set<ObjectType> | null,
): { filteredIds: string[]; excludedCount: number } {
  const afterInclude = [...allNodeIds].filter(nid => {
    const n = nodeMap.get(nid);
    if (!n) return false;
    if (typeSet   && !typeSet.has(n.type))     return false;
    if (schemaSet && !schemaSet.has(n.schema)) return false;
    return true;
  });
  const hasExclusions = excludeSchemaMatchers !== null || excludeTypeSet !== null;
  const filteredIds = hasExclusions
    ? afterInclude.filter(nid => {
        const n = nodeMap.get(nid);
        if (!n) return true;
        if (excludeSchemaMatchers && matchesAnySqlLike(n.schema, excludeSchemaMatchers)) return false;
        if (excludeTypeSet        && excludeTypeSet.has(n.type))                         return false;
        return true;
      })
    : afterInclude;
  return { filteredIds, excludedCount: afterInclude.length - filteredIds.length };
}

/** Attach DDL or column list to a BFS node base object, plus unresolved_refs when available. */
function attachDdl(
  base: Record<string, unknown>,
  node: LineageNode | undefined,
  includeDdl: boolean,
  maxDdlChars: number,
  unrelMap?: Map<string, string[]>,
): Record<string, unknown> {
  if (!includeDdl || !node) return base;
  let result = base;
  if (SCRIPT_TYPES.has(node.type) && node.bodyScript) {
    const ddl = normalizeBodyScript(node.bodyScript);
    if (ddl.length > maxDdlChars) {
      result = { ...result, ddl_too_large: true, ddl_chars: ddl.length };
    } else {
      result = { ...result, ddl };
    }
    // Attach unresolved refs for scriptable nodes — tells AI which DDL refs are outside the model
    if (unrelMap) {
      const key = `${node.schema}.${node.name}`.toLowerCase();
      const unrel = unrelMap.get(key);
      if (unrel) result = { ...result, unresolved_refs: unrel };
    }
    return result;
  }
  if (node.columns && node.columns.length > 0) {
    return { ...result, cols: node.columns.map(c => presentColumn(c)) };
  }
  return result;
}

export function runBfsTrace(
  model: DatabaseModel,
  graph: Graph,
  id: string,
  upstreamHops:    number = 3,
  downstreamHops:  number = 3,
  types?:          ObjectType[],
  schemas?:        string[],
  includeDdl:      boolean = true,
  excludeSchemas?: string[],
  excludeTypes?:   ObjectType[],
  caps?:           AiCapsOverride,
): object {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (!graph.hasNode(id)) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }

  const { upDepth, downDepth } = executeBfs(graph, id, upstreamHops, downstreamHops);
  const allNodeIds    = new Set([...upDepth.keys(), ...downDepth.keys()]);
  const nodeMap       = buildNodeMap(model);
  const typeSet       = types        ? new Set<ObjectType>(types)   : null;
  const schemaSet     = schemas      ? new Set<string>(schemas)     : null;
  // exclude_schemas: SQL-style patterns — % matches any sequence; all other chars literal (case-insensitive)
  const excludeSchemaMatchers = compileSqlLikePatterns(excludeSchemas);
  const excludeTypeSet        = excludeTypes ? new Set<ObjectType>(excludeTypes) : null;

  const { filteredIds, excludedCount } = applyBfsFilters(
    allNodeIds, nodeMap, typeSet, schemaSet, excludeSchemaMatchers, excludeTypeSet,
  );

  // Collect edges between filtered nodes
  const filteredSet = new Set(filteredIds);
  const allEdges: [string, string, string][] = [];
  for (const e of model.edges) {
    if (filteredSet.has(e.source) && filteredSet.has(e.target)) {
      allEdges.push([e.source, e.target, edgeApiType(e.type)]);
    }
  }

  const totalNodes  = filteredIds.length;
  const totalEdges  = allEdges.length;
  const truncated   = totalNodes > effectiveCaps.BFS_MAX_NODES || totalEdges > effectiveCaps.BFS_MAX_EDGES;
  const cappedIds   = filteredIds.slice(0, effectiveCaps.BFS_MAX_NODES);
  const cappedSet   = new Set(cappedIds);
  const cappedEdges = allEdges
    .filter(([s, t]) => cappedSet.has(s) && cappedSet.has(t))
    .slice(0, effectiveCaps.BFS_MAX_EDGES);

  const unrelMap = includeDdl ? buildUnrelatedMap(model) : undefined;

  const nodes = cappedIds.map(nid => {
    const n    = nodeMap.get(nid);
    const base = strip({
      id:  nid,
      s:   n?.schema       || undefined,
      n:   n?.name         ?? nid,
      t:   n?.type         ?? 'table',
      ext: n?.externalType || undefined,
      up:  upDepth.get(nid),
      dn:  downDepth.get(nid),
    } as Record<string, unknown>);
    return attachDdl(base, n, includeDdl, effectiveCaps.MAX_DDL_CHARS, unrelMap);
  });

  return {
    origin:      id,
    nodes,
    edges:       cappedEdges,
    truncated,
    total_nodes: totalNodes,
    total_edges: totalEdges,
    ...(excludedCount > 0 ? { excluded_count: excludedCount, excluded_note: `${excludedCount} node(s) removed by exclude filters. Edges to excluded nodes are also absent from results.` } : {}),
    ...(truncated ? { truncation_note: `Showing ${cappedIds.length} of ${totalNodes} nodes and ${cappedEdges.length} of ${totalEdges} edges. Narrow scope with types/schemas filters or reduce hops.` } : {}),
  };
}

// ─── Tool 6: lineage_run_analysis ─────────────────────────────────────────────

export function runAnalysis(
  model: DatabaseModel,
  graph: Graph,
  type: AnalysisType,
  minDegree?: number,
  maxSize?: number,
  caps?: AiCapsOverride,
): object {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  const analysisConfig = {
    hubMinDegree:         minDegree ?? DEFAULT_CONFIG.analysis.hubMinDegree,
    islandMaxSize:        maxSize   ?? DEFAULT_CONFIG.analysis.islandMaxSize,
    longestPathMinNodes:  DEFAULT_CONFIG.analysis.longestPathMinNodes,
  };

  const result = runGraphAnalysis(graph, type, analysisConfig, DEFAULT_CONFIG.maxNodes);
  const totalGroups = result.groups.length;
  const truncated   = totalGroups > effectiveCaps.ANALYSIS_MAX_GROUPS;
  const groups      = result.groups.slice(0, effectiveCaps.ANALYSIS_MAX_GROUPS);

  return {
    type:         result.type,
    summary:      result.summary,
    groups,
    total_groups: totalGroups,
    truncated,
    ...(truncated ? { truncation_note: `Showing ${groups.length} of ${totalGroups} groups. Use min_degree or max_size to narrow results.` } : {}),
  };
}

// ─── Tool 7: lineage_search_ddl ──────────────────────────────────────────────

export function searchDdl(
  model: DatabaseModel,
  query: string,
  types?: ('view' | 'procedure' | 'function')[],
  caps?: AiCapsOverride,
): object {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (query.length > effectiveCaps.REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: `Query exceeds maximum length of ${effectiveCaps.REGEX_MAX_LENGTH} characters.` };
  }

  // Reject invalid / catastrophically slow regex
  if (safeRegex(query) === null) {
    return { error: 'invalid_regex' as const, hint: 'Simplify the pattern — avoid nested quantifiers.' };
  }

  const ddlTypes: ObjectType[] = types
    ? (types as ObjectType[])
    : ['view', 'procedure', 'function'];
  const typeSet = new Set<ObjectType>(ddlTypes);

  const matches = searchBodyScripts(
    model.nodes as SearchableNode[],
    query,
    typeSet,
    2,
    effectiveCaps.SEARCH_MAX_RESULTS,
  );

  const results = matches.map(m => ({
    id:      m.node.id,
    name:    m.node.name,
    type:    m.node.type,
    matches: [m.snippet],
  }));

  const base = {
    results,
    total:     results.length,
    truncated: matches.length >= effectiveCaps.SEARCH_MAX_RESULTS,
  };

  if (results.length === 0) {
    return { ...base, hint: 'No matches. Try a shorter substring, check spelling, or call lineage_search_objects to confirm object names.' };
  }
  return base;
}

// ─── Tool 8: lineage_create_ai_view ──────────────────────────────────────────

export type AIHighlightColor = 'bu' | 'gn' | 'rd' | 'ye' | 'or';
export type AiBadgeColor = AIHighlightColor | 'gy';

export type CreateAiViewInput = {
  name: string;
  node_ids: string[];
  narrative?: string;
  layout_direction?: 'LR' | 'TB';
  highlight_groups?: Array<{
    label: string;
    color: AIHighlightColor;
    node_ids: string[];
  }>;
  badges?: Array<{
    node_id: string;
    text: string;
    color?: AiBadgeColor;
  }>;
  notes?: Array<{
    node_id: string;
    text: string;
    color?: AiBadgeColor;
  }>;
};

export type CreateAiViewRequest = {
  success: true;
  name: string;
  node_ids: string[];
  narrative?: string;
  layout_direction: 'LR' | 'TB';
  highlight_groups: Array<{ label: string; color: AIHighlightColor; node_ids: string[] }>;
  badges: Array<{ node_id: string; text: string; color?: AiBadgeColor }>;
  notes: Array<{ node_id: string; text: string; color?: AiBadgeColor }>;
};

export type CreateAiViewError = { success: false; errors: string[]; hint: string };

const AI_HIGHLIGHT_COLORS = new Set<string>(['bu', 'gn', 'rd', 'ye', 'or']);
const AI_BADGE_COLORS = new Set<string>(['bu', 'gn', 'rd', 'ye', 'or', 'gy']);

export function autoFixCreateAiView(
  model: DatabaseModel,
  input: CreateAiViewInput,
): { input: CreateAiViewInput; fixes: string[] } {
  const fixes: string[] = [];
  let fixed = { ...input };

  // 1. Filter out unknown node_ids (as long as at least 1 valid ID remains)
  if (fixed.node_ids?.length > 0) {
    const unknown = fixed.node_ids.filter(id => !model.catalog[id]);
    const valid = fixed.node_ids.filter(id => model.catalog[id]);
    if (unknown.length > 0 && valid.length >= 1) {
      fixes.push(`Removed ${unknown.length} unknown ID(s): ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ' ...' : ''}`);
      fixed = { ...fixed, node_ids: valid };
    }
  }

  const nodeIdSet = new Set(fixed.node_ids ?? []);

  // 2. Truncate badge text > 15 chars, drop empty badges & badges for removed nodes
  if (fixed.badges) {
    fixed = {
      ...fixed,
      badges: fixed.badges
        .filter(b => {
          if (!nodeIdSet.has(b.node_id)) { fixes.push(`Dropped badge for removed node "${b.node_id}"`); return false; }
          if (!b.text || b.text.trim().length === 0) { fixes.push('Dropped empty badge'); return false; }
          return true;
        })
        .map(b => {
          if (b.text.length > 15) {
            fixes.push(`Truncated badge "${b.text}" → "${b.text.slice(0, 15)}"`);
            return { ...b, text: b.text.slice(0, 15) };
          }
          return b;
        }),
    };
  }

  // 3. Drop empty notes, truncate > 120 chars, drop notes for removed nodes, cap at 10
  if (fixed.notes) {
    const before = fixed.notes.length;
    let filtered = fixed.notes
      .filter(n => nodeIdSet.has(n.node_id) && n.text && n.text.trim().length > 0)
      .map(n => {
        if (n.text.length > 120) {
          fixes.push(`Truncated note for "${n.node_id}" to 120 chars`);
          return { ...n, text: n.text.slice(0, 120) };
        }
        return n;
      });
    if (filtered.length > 10) {
      fixes.push(`Capped notes from ${filtered.length} to 10 (max per view)`);
      filtered = filtered.slice(0, 10);
    }
    fixed = { ...fixed, notes: filtered };
    const dropped = before - (fixed.notes?.length ?? 0);
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned note(s)`);
  }

  // 4. Truncate narrative > 500 chars
  if (fixed.narrative && fixed.narrative.length > 500) {
    fixes.push(`Truncated narrative from ${fixed.narrative.length} to 500 chars`);
    fixed = { ...fixed, narrative: fixed.narrative.slice(0, 500) };
  }

  // 5. Prune highlight_groups referencing removed nodes
  if (fixed.highlight_groups) {
    fixed = {
      ...fixed,
      highlight_groups: fixed.highlight_groups
        .map(g => ({ ...g, node_ids: g.node_ids.filter(id => nodeIdSet.has(id)) }))
        .filter(g => g.node_ids.length > 0),
    };
  }

  return { input: fixed, fixes };
}

export function validateCreateAiView(
  model: DatabaseModel,
  input: CreateAiViewInput,
): CreateAiViewRequest | CreateAiViewError {
  const errors: string[] = [];

  // Name validation
  if (!input.name || input.name.trim().length === 0) errors.push('name is required');
  else if (input.name.length > 60) errors.push('name exceeds 60 characters');

  // node_ids validation (structural only — unknown IDs handled by autoFix)
  if (!input.node_ids || input.node_ids.length === 0) {
    errors.push('node_ids must contain at least 1 ID');
  } else if (input.node_ids.length > 30) {
    errors.push('node_ids exceeds maximum of 30 IDs — create multiple focused views instead');
  }

  // highlight_groups validation (structural + color validity — autoFix does not normalize colors)
  const nodeIdSet = new Set(input.node_ids ?? []);
  if (input.highlight_groups) {
    if (input.highlight_groups.length > 5) errors.push('highlight_groups exceeds maximum of 5');
    for (const g of input.highlight_groups) {
      if (!g.label) errors.push('Group label is required');
      if (!AI_HIGHLIGHT_COLORS.has(g.color)) errors.push(`Group "${g.label}" has invalid color "${g.color}"`);
    }
  }

  // Color validity only — text length and orphan checks handled by autoFix
  if (input.badges) {
    for (const b of input.badges) {
      if (b.color && !AI_BADGE_COLORS.has(b.color)) errors.push(`Badge color "${b.color}" is invalid`);
    }
  }
  if (input.notes) {
    for (const n of input.notes) {
      if (n.color && !AI_BADGE_COLORS.has(n.color)) errors.push(`Note color "${n.color}" is invalid`);
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      hint: 'Fix the listed errors and retry.',
    };
  }

  return {
    success: true,
    name: input.name.trim(),
    node_ids: input.node_ids,
    narrative: input.narrative,
    layout_direction: input.layout_direction ?? 'TB',
    highlight_groups: input.highlight_groups ?? [],
    badges: input.badges ?? [],
    notes: input.notes ?? [],
  };
}

// ─── Tool 9: lineage_get_ddl_batch ───────────────────────────────────────────

export function getDdlBatch(
  model: DatabaseModel,
  ids: string[],
  caps?: AiCapsOverride,
): object {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  const cappedIds = ids.slice(0, effectiveCaps.DDL_BATCH_CAP);
  const nodeMap   = buildNodeMap(model);

  const results = cappedIds.map(id => {
    const node = nodeMap.get(id);
    if (!node) {
      return strip({ id, error: 'not_found' } as Record<string, unknown>);
    }
    if (!node.bodyScript) {
      // Tables and external nodes have no DDL body — return type only
      return strip({ id, t: node.type } as Record<string, unknown>);
    }
    const ddl = normalizeBodyScript(node.bodyScript);
    if (ddl.length > effectiveCaps.MAX_DDL_CHARS) {
      return strip({
        id, t: node.type,
        ddl_too_large: true,
        ddl_chars: ddl.length,
      } as Record<string, unknown>);
    }
    return strip({ id, t: node.type, ddl } as Record<string, unknown>);
  });

  const truncated = ids.length > effectiveCaps.DDL_BATCH_CAP;
  return {
    results,
    total:     results.length,
    truncated,
    ...(truncated ? {
      truncation_note: `Showing ${cappedIds.length} of ${ids.length} IDs. Split into multiple calls if needed.`,
    } : {}),
  };
}

