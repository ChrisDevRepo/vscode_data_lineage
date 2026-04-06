/**
 * AI tool pure functions — zero VS Code imports.
 * 8 classic retrieval functions invoked by classic LanguageModelTools in extension.ts.
 * CT and BB tools (start_column_trace, submit_hop_analysis, start_exploration, submit_findings)
 * are handled directly by ColumnTraceState and BlackboardState in extension.ts.
 *
 * This file owns RETRIEVAL ONLY. All formatting/normalization lives in aiPresenter.ts.
 */
import { bfsFromNode } from 'graphology-traversal';
import type Graph from 'graphology';
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type LineageNode,
  type ColumnDef,
  type ObjectType,
  type AnalysisType,
} from '../engine/types';
import { runAnalysis as runGraphAnalysis } from '../engine/graphAnalysis';
import { searchCatalog, searchColumns, safeRegex, searchBodyScripts, type SearchableNode } from '../utils/modelSearch';
import { normalizeBodyScript } from '../utils/sql';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentColumnCompact, presentFkCompact,
  presentSchema, presentNeighbor, presentFilter,
} from './aiPresenter';

// ─── Token budget (delivery mode only — no per-tool caps) ──────────────────

import { shouldInline, estimateTokens, INLINE_TOKEN_BUDGET, REGEX_MAX_LENGTH, getEffectiveBudget } from './tokenBudget';
export { shouldInline, estimateTokens, INLINE_TOKEN_BUDGET, getEffectiveBudget } from './tokenBudget';

/** Max nodes for inline BFS delivery — above this, recommend state machine. */
const BFS_INLINE_NODE_CAP = 200;

// ─── Input validation ────────────────────────────────────────────────────────

type FieldType = 'string' | 'array' | 'number' | 'object' | 'boolean';

/**
 * Lightweight runtime validation for LLM tool inputs. Returns null if valid,
 * or a structured error if any required field is missing or has the wrong type.
 * No external dependencies (not Zod) — keeps the extension lean.
 */
export function validateToolInput(
  input: unknown,
  required: Record<string, FieldType>,
): { error: string; hint: string } | null {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { error: 'invalid_input', hint: 'Tool input must be an object.' };
  }
  const obj = input as Record<string, unknown>;
  for (const [field, expectedType] of Object.entries(required)) {
    const val = obj[field];
    if (val === undefined || val === null) {
      return { error: 'missing_field', hint: `Required field "${field}" is missing.` };
    }
    if (expectedType === 'array') {
      if (!Array.isArray(val)) {
        return { error: 'wrong_type', hint: `Field "${field}" must be an array, got ${typeof val}.` };
      }
    } else if (typeof val !== expectedType) {
      return { error: 'wrong_type', hint: `Field "${field}" must be ${expectedType}, got ${typeof val}.` };
    }
  }
  return null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Number of context lines shown in DDL/body search snippets. */
const SNIPPET_CONTEXT_LINES = 2;
const COLUMN_SEARCH_LIMIT = 50;
const ENRICH_VIEW_NAME_MAX_LENGTH = 60;
const ENRICH_VIEW_SUMMARY_HARD_LIMIT = 300;

/** Build source→target edge type lookup for the entire model (cheap one-pass). */
export function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e.type));
  }
  return m;
}

/** Build id→node lookup. */
export function buildNodeMap(model: DatabaseModel): Map<string, LineageNode> {
  const m = new Map<string, LineageNode>();
  for (const n of model.nodes) m.set(n.id, n);
  return m;
}

/** Build lowercase "Schema.Name" → unrelated refs lookup from parse stats. */
export function buildUnrelatedMap(model: DatabaseModel): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!model.parseStats?.spDetails) return m;
  for (const d of model.parseStats.spDetails) {
    if (d.unrelated?.length) {
      m.set(d.name.toLowerCase(), d.unrelated.map(r => r.replace(/ \(exec\)$/, '')));
    }
  }
  return m;
}

// ─── Shared SM helpers (used by CT, BB, and classical tools) ─────────────────

/** Shared column access — used by classical tools, CT, and BB. */
export function getNodeColumns(
  nodeId: string, nodeMap: Map<string, LineageNode>,
  store?: import('../engine/columnStore').ColumnStore,
): ColumnDef[] | undefined {
  return store?.getColumns(nodeId) ?? nodeMap.get(nodeId)?.columns;
}

/** Shared DDL access — normalized. Used by classical tools, CT, and BB. */
export function getNodeDdl(
  nodeId: string, nodeMap: Map<string, LineageNode>,
  store?: import('../engine/columnStore').ColumnStore,
): string | undefined {
  const raw = store?.getDdl(nodeId) ?? nodeMap.get(nodeId)?.bodyScript;
  return raw ? normalizeBodyScript(raw) : undefined;
}

/** Build focus node detail for hop context — shared by CT and BB. */
export function buildHopFocusNode(
  node: LineageNode,
  nodeMap: Map<string, LineageNode>,
  unrelatedMap: Map<string, string[]>,
  store?: import('../engine/columnStore').ColumnStore,
  ddlKey = 'ddl',
): Record<string, unknown> {
  const focusNode: Record<string, unknown> = {
    id: node.id, s: node.schema, n: node.name, t: node.type,
  };
  const ddl = getNodeDdl(node.id, nodeMap, store);
  const cols = getNodeColumns(node.id, nodeMap, store);
  if (SCRIPT_TYPES.has(node.type) && ddl) {
    focusNode[ddlKey] = ddl;
  } else if (cols?.length) {
    focusNode.cols = cols.map(c => presentColumnCompact(c));
  }
  if (node.fks?.length) {
    focusNode.fks = node.fks.map(fk => presentFkCompact(fk));
  }
  const unrelKey = `${node.schema}.${node.name}`.toLowerCase();
  const unrel = unrelatedMap.get(unrelKey);
  if (unrel?.length) focusNode.unresolved_refs = unrel;
  return strip(focusNode) as Record<string, unknown>;
}

// ─── Tool 1: lineage_get_context ─────────────────────────────────────────────

export function getContext(
  model: DatabaseModel,
  activeFilter: SerializedFilterState | null,
  projectName: string | null,
  savedViews: FilterProfile[],
  store?: import('../engine/columnStore').ColumnStore,
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

  // Build full catalog payload, then measure — token budget decides inline vs on-demand
  const catalog = model.nodes.map(n => {
    const base = presentNode(n, model.neighborIndex);
    const ddlBody = store?.getDdl(n.id) ?? n.bodyScript;
    if (SCRIPT_TYPES.has(n.type) && ddlBody) {
      const ddl = normalizeBodyScript(ddlBody);
      return { ...base, ddl };
    }
    const cols = store?.getColumns(n.id) ?? n.columns;
    if (cols && cols.length > 0) {
      const enriched: Record<string, unknown> = { ...base, cols: cols.map(c => presentColumn(c)) };
      if (n.fks && n.fks.length > 0) {
        enriched.fks = n.fks.map(fk => ({
          name: fk.name, columns: fk.columns,
          ref_schema: fk.refSchema, ref_table: fk.refTable,
          ref_columns: fk.refColumns, on_delete: fk.onDelete,
        }));
      }
      return strip(enriched);
    }
    return base;
  });
  const edges = model.edges.map(e => [e.source, e.target, edgeApiType(e.type)]);
  const catalogChars = JSON.stringify(catalog).length + JSON.stringify(edges).length;
  const isInline = shouldInline(catalogChars);

  return {
    project_name:  projectName,
    source_type:   model.dbPlatform ? 'database' : 'dacpac',
    db_platform:   model.dbPlatform ?? null,
    model_size:    isInline ? 'small' as const : 'large' as const,
    model_stats:   { nodes: model.nodes.length, edges: model.edges.length },
    schemas:       model.schemas.map(s => presentSchema(s)),
    visible_nodes: visibleNodes,
    filter:        activeFilter ? presentFilter(activeFilter) : null,
    saved_views:   savedViews.map(v => ({ id: v.id, name: v.name })),
    // Token budget check: inline full catalog when payload fits, otherwise summary only
    ...(isInline && { objects: catalog, edges }),
    ...(!isInline && model.parseStats && {
      unresolved_ref_count: model.parseStats.droppedRefs?.length ?? 0,
    }),
    _token_estimate: { catalog_chars: catalogChars, estimated_tokens: estimateTokens(catalogChars), budget: getEffectiveBudget(), decision: isInline ? 'inline' : 'on_demand' },
  };
}

// ─── Query validation ───────────────────────────────────────────────────────

/** Reject garbage queries (empty, single char, pure wildcards). */
function validateQuery(query: string): { ok: true } | { ok: false; error: string; hint: string } {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { ok: false, error: 'query_too_short', hint: 'Use at least 2 characters.' };
  }
  if (/^[.*?+^$]+$/.test(trimmed)) {
    return { ok: false, error: 'query_too_broad', hint: 'Query matches everything. Be more specific or use schemas[] to narrow scope.' };
  }
  return { ok: true };
}

// ─── Tool 2: lineage_search_objects ──────────────────────────────────────────

export function searchObjects(
  model: DatabaseModel,
  query: string,
  types?: ObjectType[],
  schemas?: string[],
  mode: 'substring' | 'regex' = 'substring',
  activeFilter?: SerializedFilterState | null,
) {
  if (query.length > REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` };
  }

  // Validate query (reject garbage)
  if (mode !== 'regex') {
    const validation = validateQuery(query);
    if (!validation.ok) {
      return { error: validation.error, hint: validation.hint };
    }
  }

  const effectiveQuery = query.trim();
  const appliedSchemaFilter: string[] | null = schemas && schemas.length > 0 ? [...schemas] : null;
  const typeSet   = types   ? new Set<ObjectType>(types)   : undefined;
  const schemaSet = appliedSchemaFilter ? new Set<string>(schemas!) : undefined;

  const nameHits = searchCatalog(
    model.nodes as SearchableNode[],
    effectiveQuery,
    typeSet,
    schemaSet,
    Number.MAX_SAFE_INTEGER,
    mode,
  );

  // Column name search (tables/external only, always-on, respects schema/type filters)
  let columnNodes = model.nodes as SearchableNode[];
  if (schemaSet && schemaSet.size > 0) columnNodes = columnNodes.filter(n => schemaSet.has(n.schema));
  if (typeSet && typeSet.size > 0) columnNodes = columnNodes.filter(n => typeSet.has(n.type));
  const columnHits = mode === 'substring'
    ? searchColumns(columnNodes, effectiveQuery, COLUMN_SEARCH_LIMIT)
    : [];
  const seenIds = new Set(nameHits.map(n => n.id));

  const results = [
    ...nameHits.map(n => ({
      ...presentNode(n, model.neighborIndex),
      match: 'name' as const,
    })),
    ...columnHits
      .filter(h => !seenIds.has(h.node.id))
      .map(h => ({
        ...presentNode(h.node, model.neighborIndex),
        match: 'column' as const,
        matched_columns: h.snippet,
      })),
  ];

  // Tag each result with in_user_filter so AI knows what the user currently sees
  const filterSchemaSet = activeFilter?.schemas?.length
    ? new Set(activeFilter.schemas.map(s => s.toLowerCase()))
    : null;
  const taggedResults = results.map(r => ({
    ...r,
    in_user_filter: filterSchemaSet ? filterSchemaSet.has(((r as any).s ?? '').toLowerCase()) : true,
  }));

  const visibleNodeCount = activeFilter
    ? model.nodes.filter(n => {
        const schemaOk = !activeFilter.schemas?.length || activeFilter.schemas.some(s => s.toLowerCase() === n.schema.toLowerCase());
        const typeOk = !activeFilter.types?.length || activeFilter.types.includes(n.type as ObjectType);
        return schemaOk && typeOk;
      }).length
    : model.nodes.length;
  const filterContext = {
    active_schemas: activeFilter?.schemas?.length ? activeFilter.schemas : null,
    active_types: activeFilter?.types?.length ? activeFilter.types : null,
    focus_schemas: activeFilter?.focusSchemas?.length ? activeFilter.focusSchemas : null,
    hide_isolated: activeFilter?.hideIsolated ?? false,
    visible_node_count: visibleNodeCount,
    total_node_count: model.nodes.length,
    all_schemas: [...new Set(model.nodes.map(n => n.schema))],
  };

  const base = {
    results: taggedResults,
    total: taggedResults.length,
    filter_context: filterContext,
  };

  if (taggedResults.length === 0) {
    // Schema mismatch detection: schema-filtered search empty, but name exists elsewhere?
    if (appliedSchemaFilter) {
      const fallbackHits = searchCatalog(
        model.nodes as SearchableNode[],
        effectiveQuery,
        typeSet,
        undefined, // no schema filter
        10,
        mode,
      );
      if (fallbackHits.length > 0) {
        const foundSchemas = [...new Set(fallbackHits.map(n => n.schema))];
        // Return fallback results as primary — AI can proceed immediately
        const fallbackResults = fallbackHits.slice(0, 10).map(n => ({
          ...presentNode(n, model.neighborIndex),
          match: 'name' as const,
          in_user_filter: filterSchemaSet ? filterSchemaSet.has(n.schema.toLowerCase()) : true,
        }));
        return {
          results: fallbackResults,
          total: fallbackResults.length,
          filter_context: filterContext,
          ai_hint: `0 results in schemas [${appliedSchemaFilter.join(', ')}]. Found "${effectiveQuery}" in [${foundSchemas.join(', ')}]. Results shown from matched schemas.`,
          schema_correction: {
            requested_schemas: appliedSchemaFilter,
            actual_schemas: foundSchemas,
          },
        };
      }
    }
    return {
      ...base,
      ai_hint: `No results for "${effectiveQuery}". Try search_ddl for DDL body matches, try regex mode, or broaden with fewer filters.`,
    };
  }
  return base;
}

// ─── Tool 3: lineage_get_object_detail ───────────────────────────────────────

const NEIGHBOR_CAP = 25;

export function getObjectDetail(
  model: DatabaseModel,
  id: string,
  store?: import('../engine/columnStore').ColumnStore,
): object {
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

  const cols = getNodeColumns(node.id, nodeMap, store);
  const columns    = cols?.map(c => presentColumn(c)) ?? undefined;
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

  const ddl = getNodeDdl(node.id, nodeMap, store) ?? null;

  // Attach unresolved refs for scriptable nodes
  const unrelMap = buildUnrelatedMap(model);
  const unrelKey = `${node.schema}.${node.name}`.toLowerCase();
  const unresolved_refs = unrelMap.get(unrelKey) ?? undefined;

  // Never truncate DDL — zero-truncation guarantee
  return { ...base, ddl, unresolved_refs };
}

// ─── Tool 4: lineage_run_bfs_trace ────────────────────────────────────────────
// Two modes:
//   Level BFS:  origin + upstream_hops + downstream_hops → explore by depth
//   Path BFS:   origin + target → all nodes on paths between start and end
// shouldInline() gates delivery mode: fits → full DDL, exceeds → on_demand hint.
// types[] and schemas[] are include-only filters (no exclude).

export const SCRIPT_TYPES: Set<ObjectType> = new Set(['view', 'procedure', 'function']);

/** Find all node IDs on any path between start and end (BFS from both sides, intersect). */
function findPathNodes(
  graph: Graph, startId: string, endId: string,
): Set<string> {
  // BFS downstream from start — collect all reachable nodes
  const fromStart = new Set<string>();
  bfsFromNode(graph, startId, (node) => { fromStart.add(node); }, { mode: 'outbound' });
  fromStart.add(startId);

  // BFS upstream from end — collect all reachable nodes
  const fromEnd = new Set<string>();
  bfsFromNode(graph, endId, (node) => { fromEnd.add(node); }, { mode: 'inbound' });
  fromEnd.add(endId);

  // Intersect: nodes reachable downstream from start AND upstream from end
  const pathNodes = new Set<string>();
  for (const nid of fromStart) {
    if (fromEnd.has(nid)) pathNodes.add(nid);
  }
  return pathNodes;
}

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

/** Apply include filters to a node ID set. Returns filtered IDs. */
function applyBfsFilters(
  allNodeIds: Set<string>,
  nodeMap: Map<string, LineageNode>,
  typeSet: Set<ObjectType> | null,
  schemaSet: Set<string> | null,
): string[] {
  return [...allNodeIds].filter(nid => {
    const n = nodeMap.get(nid);
    if (!n) return false;
    if (typeSet   && !typeSet.has(n.type))     return false;
    if (schemaSet && !schemaSet.has(n.schema)) return false;
    return true;
  });
}

/** Attach DDL or column list to a BFS node, plus unresolved_refs. Never truncates DDL. */
function attachDdl(
  base: Record<string, unknown>,
  node: LineageNode | undefined,
  includeDdl: boolean,
  unrelMap?: Map<string, string[]>,
  store?: import('../engine/columnStore').ColumnStore,
): Record<string, unknown> {
  if (!includeDdl || !node) return base;
  let result = base;
  const ddlBody = store?.getDdl(node.id) ?? node.bodyScript;
  if (SCRIPT_TYPES.has(node.type) && ddlBody) {
    const ddl = normalizeBodyScript(ddlBody);
    result = { ...result, ddl };
    if (unrelMap) {
      const key = `${node.schema}.${node.name}`.toLowerCase();
      const unrel = unrelMap.get(key);
      if (unrel) result = { ...result, unresolved_refs: unrel };
    }
    return result;
  }
  const cols = store?.getColumns(node.id) ?? node.columns;
  if (cols && cols.length > 0) {
    return { ...result, cols: cols.map(c => presentColumn(c)) };
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
  store?: import('../engine/columnStore').ColumnStore,
  target?: string,
): object {
  if (!graph.hasNode(id)) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }
  if (target && !graph.hasNode(target)) {
    return { error: 'not_found' as const, id: target, hint: 'Target node not found. Call lineage_search_objects to find the exact object ID.' };
  }

  // Path BFS (start→end) or Level BFS (depth-based)
  let allNodeIds: Set<string>;
  let upDepth: Map<string, number>;
  let downDepth: Map<string, number>;

  if (target) {
    // Path mode: find all nodes on paths between start and end
    allNodeIds = findPathNodes(graph, id, target);
    if (allNodeIds.size === 0) {
      return { error: 'no_path' as const, origin: id, target, hint: `No path found from ${id} to ${target}. They may not be connected.` };
    }
    // No depth info in path mode — set both to 0
    upDepth = new Map(); downDepth = new Map();
    for (const nid of allNodeIds) { upDepth.set(nid, 0); downDepth.set(nid, 0); }
  } else {
    // Level mode: explore by depth from origin
    const bfs = executeBfs(graph, id, upstreamHops, downstreamHops);
    upDepth = bfs.upDepth; downDepth = bfs.downDepth;
    allNodeIds = new Set([...upDepth.keys(), ...downDepth.keys()]);
  }
  const nodeMap       = buildNodeMap(model);
  const typeSet       = types   ? new Set<ObjectType>(types)   : null;
  const schemaSet     = schemas ? new Set<string>(schemas)     : null;

  const filteredIds = applyBfsFilters(allNodeIds, nodeMap, typeSet, schemaSet);

  // Collect ALL edges between filtered nodes — no slicing
  const filteredSet = new Set(filteredIds);
  const allEdges: [string, string, string][] = [];
  for (const e of model.edges) {
    if (filteredSet.has(e.source) && filteredSet.has(e.target)) {
      allEdges.push([e.source, e.target, edgeApiType(e.type)]);
    }
  }

  // Large scope → recommend state machine delivery (same data, different delivery mode)
  if (filteredIds.length > BFS_INLINE_NODE_CAP) {
    const schemaBreakdown: Record<string, number> = {};
    for (const nid of filteredIds) {
      const n = nodeMap.get(nid);
      if (n) schemaBreakdown[n.schema] = (schemaBreakdown[n.schema] || 0) + 1;
    }
    return {
      delivery: 'state_machine_recommended' as const,
      origin: id, ...(target ? { target } : {}),
      total_nodes: filteredIds.length,
      total_edges: allEdges.length,
      schemas: schemaBreakdown,
      hint: `BFS result has ${filteredIds.length} nodes (>${BFS_INLINE_NODE_CAP}). Use start_exploration for hop-by-hop analysis with verdicts, or narrow with schema/type filters.`,
    };
  }

  // Detect depth-limited boundary nodes (level mode only, not path mode)
  const depthLimitedNodes: Array<{ id: string; direction: string; connections_beyond: number }> = [];
  if (!target) {
    for (const nid of filteredIds) {
      // Check upstream boundary: node at max upstream depth with more inbound neighbors beyond
      if (upstreamHops > 0 && upDepth.get(nid) === upstreamHops) {
        const beyondCount = (graph.hasNode(nid) ? graph.inboundNeighbors(nid) : [])
          .filter(n => !filteredSet.has(n)).length;
        if (beyondCount > 0) depthLimitedNodes.push({ id: nid, direction: 'upstream', connections_beyond: beyondCount });
      }
      // Check downstream boundary: node at max downstream depth with more outbound neighbors beyond
      if (downstreamHops > 0 && downDepth.get(nid) === downstreamHops) {
        const beyondCount = (graph.hasNode(nid) ? graph.outboundNeighbors(nid) : [])
          .filter(n => !filteredSet.has(n)).length;
        if (beyondCount > 0) depthLimitedNodes.push({ id: nid, direction: 'downstream', connections_beyond: beyondCount });
      }
    }
  }

  const unrelMap = includeDdl ? buildUnrelatedMap(model) : undefined;

  // Build node metadata (always complete — no slicing)
  const buildNodeBase = (nid: string) => {
    const n = nodeMap.get(nid);
    return strip({
      id:  nid,
      s:   n?.schema       || undefined,
      n:   n?.name         ?? nid,
      t:   n?.type         ?? 'table',
      ext: n?.externalType || undefined,
      up:  upDepth.get(nid),
      dn:  downDepth.get(nid),
    } as Record<string, unknown>);
  };

  // Token gate: full result with DDL vs lightweight without DDL
  if (includeDdl) {
    const nodesWithDdl = filteredIds.map(nid =>
      attachDdl(buildNodeBase(nid), nodeMap.get(nid), true, unrelMap, store));
    const totalChars = JSON.stringify({ nodes: nodesWithDdl, edges: allEdges }).length;

    const baseResult = { origin: id, ...(target ? { target } : {}), mode: target ? 'path' as const : 'level' as const };

    if (shouldInline(totalChars)) {
      return { ...baseResult, nodes: nodesWithDdl, edges: allEdges, delivery: 'inline' as const,
        ...(depthLimitedNodes.length > 0 && { depth_limited_nodes: depthLimitedNodes }) };
    }

    // Exceeds budget — return without DDL, hint to use follow-up tools or start_trace
    const nodesLight = filteredIds.map(nid =>
      attachDdl(buildNodeBase(nid), nodeMap.get(nid), false, undefined, store));
    return {
      ...baseResult,
      nodes:  nodesLight,
      edges:  allEdges,
      delivery: 'on_demand' as const,
      total_nodes: filteredIds.length,
      total_edges: allEdges.length,
      scope_ddl_chars: totalChars,
      budget_tokens: getEffectiveBudget(),
      ai_hint: 'Scope DDL exceeds token budget. DDL omitted. Use get_ddl_batch for specific nodes, or start_exploration for hop-by-hop analysis. Do NOT ask the user — pick the best approach.',
      ...(depthLimitedNodes.length > 0 && { depth_limited_nodes: depthLimitedNodes }),
    };
  }

  // include_ddl=false: structure only
  const baseResult = { origin: id, ...(target ? { target } : {}), mode: target ? 'path' as const : 'level' as const };
  const nodes = filteredIds.map(nid =>
    attachDdl(buildNodeBase(nid), nodeMap.get(nid), false, undefined, store));
  return { ...baseResult, nodes, edges: allEdges, delivery: 'inline' as const,
    ...(depthLimitedNodes.length > 0 && { depth_limited_nodes: depthLimitedNodes }) };
}

// ─── Tool 5: lineage_run_analysis ─────────────────────────────────────────────

export function runAnalysis(
  model: DatabaseModel,
  graph: Graph,
  type: AnalysisType,
  minDegree?: number,
  maxSize?: number,
): object {
  const analysisConfig = {
    hubMinDegree:         minDegree ?? DEFAULT_CONFIG.analysis.hubMinDegree,
    islandMaxSize:        maxSize   ?? DEFAULT_CONFIG.analysis.islandMaxSize,
    longestPathMinNodes:  DEFAULT_CONFIG.analysis.longestPathMinNodes,
  };

  const result = runGraphAnalysis(graph, type, analysisConfig, DEFAULT_CONFIG.maxNodes);
  return {
    type:         result.type,
    summary:      result.summary,
    groups:       result.groups,
    total_groups: result.groups.length,
  };
}

// ─── Tool 6: lineage_search_ddl ──────────────────────────────────────────────

export function searchDdl(
  model: DatabaseModel,
  query: string,
  types?: ('view' | 'procedure' | 'function')[],
  store?: import('../engine/columnStore').ColumnStore,
): object {
  if (query.length > REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` };
  }

  // Reject invalid / catastrophically slow regex
  if (safeRegex(query) === null) {
    return { error: 'invalid_regex' as const, hint: 'Simplify the pattern — avoid nested quantifiers.' };
  }

  const ddlTypes: ObjectType[] = types
    ? (types as ObjectType[])
    : [...SCRIPT_TYPES];
  const typeSet = new Set<ObjectType>(ddlTypes);

  // Build searchable nodes with DDL from ColumnStore (or inline fallback for tests)
  const searchableNodes: SearchableNode[] = model.nodes.map(n => ({
    ...n,
    bodyScript: store?.getDdl(n.id) ?? n.bodyScript,
  }));
  const matches = searchBodyScripts(
    searchableNodes,
    query,
    typeSet,
    SNIPPET_CONTEXT_LINES,
    Number.MAX_SAFE_INTEGER,
  );

  const results = matches.map(m => ({
    id:      m.node.id,
    name:    m.node.name,
    type:    m.node.type,
    matches: [m.snippet],
  }));

  if (results.length === 0) {
    return { results, total: 0, hint: 'No matches. Try a shorter substring, check spelling, or call lineage_search_objects to confirm object names.' };
  }
  return { results, total: results.length };
}

// ─── Tool 7: lineage_enrich_view ─────────────────────────────────────────────

export type AIHighlightRole = 'source' | 'transform' | 'target' | 'good' | 'warn' | 'fail';

export type EnrichViewInput = {
  name: string;
  summary: string;
  description?: string;
  prune_node_ids?: string[];
  layout_direction?: 'LR' | 'TB';
  highlight_groups?: Array<{
    label: string;
    color: AIHighlightRole;
    node_ids: string[];
  }>;
  badges?: Array<{
    node_id: string;
    text: string;
  }>;
  notes?: Array<{
    node_id: string;
    text: string;
  }>;
  node_ids?: string[];  // fallback only: used when no stored result graph exists
};

export type EnrichViewRequest = {
  success: true;
  name: string;
  node_ids: string[];
  summary: string;
  description?: string;
  layout_direction: 'LR' | 'TB';
  highlight_groups: Array<{ label: string; color: AIHighlightRole; node_ids: string[] }>;
  badges: Array<{ node_id: string; text: string }>;
  notes: Array<{ node_id: string; text: string }>;
};

export type EnrichViewError = { success: false; errors: string[]; hint: string };

const AI_HIGHLIGHT_ROLES = new Set<string>(['source', 'transform', 'target', 'good', 'warn', 'fail']);

/**
 * Auto-fix common issues in enrich_view input.
 * @param model — database model (only used for fallback catalog validation)
 * @param input — raw AI input
 * @param resolvedNodeIds — canonical node set from stored result graph (if available)
 */
export function autoFixEnrichView(
  model: DatabaseModel,
  input: EnrichViewInput,
  resolvedNodeIds?: string[],
): { input: EnrichViewInput; fixes: string[] } {
  const fixes: string[] = [];
  let fixed = { ...input };

  // 0. Normalize escaped newlines in description (LLMs sometimes double-escape)
  if (fixed.description && /\\n/.test(fixed.description)) {
    fixed = { ...fixed, description: fixed.description.replace(/\\n/g, '\n').replace(/\\t/g, '\t') };
    fixes.push('Normalized escaped newlines in description');
  }

  // 1. Filter unknown node_ids — only for fallback mode (no stored graph)
  if (!resolvedNodeIds && fixed.node_ids?.length) {
    const unknown = fixed.node_ids.filter(id => !model.catalog[id]);
    const valid = fixed.node_ids.filter(id => model.catalog[id]);
    if (unknown.length > 0 && valid.length >= 1) {
      fixes.push(`Removed ${unknown.length} unknown ID(s): ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ' ...' : ''}`);
      fixed = { ...fixed, node_ids: valid };
    }
  }

  // Use resolved graph node set or fallback to input.node_ids
  const nodeIdSet = new Set(resolvedNodeIds ?? fixed.node_ids ?? []);

  // 2. Drop empty badges & badges for nodes not in the resolved set
  if (fixed.badges) {
    const before = fixed.badges.length;
    const filtered = fixed.badges.filter(b => nodeIdSet.has(b.node_id) && b.text && b.text.trim().length > 0);
    fixed = { ...fixed, badges: filtered };
    const dropped = before - filtered.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned badge(s)`);
  }

  // 3. Drop empty notes & notes for nodes not in the resolved set
  if (fixed.notes) {
    const before = fixed.notes.length;
    const filtered = fixed.notes.filter(n => nodeIdSet.has(n.node_id) && n.text && n.text.trim().length > 0);
    fixed = { ...fixed, notes: filtered };
    const dropped = before - filtered.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned note(s)`);
  }

  // 4. Prune highlight_groups referencing nodes not in the resolved set
  if (fixed.highlight_groups) {
    const before = fixed.highlight_groups.length;
    const pruned = fixed.highlight_groups
      .map(g => ({ ...g, node_ids: g.node_ids.filter(id => nodeIdSet.has(id)) }))
      .filter(g => g.node_ids.length > 0);
    fixed = { ...fixed, highlight_groups: pruned };
    const dropped = before - pruned.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} orphaned highlight group(s)`);
  }

  return { input: fixed, fixes };
}

/** Validate markdown format — returns error strings (empty = valid). */
export function validateMarkdownFormat(md: string): string[] {
  const errors: string[] = [];

  // Reject \begin{...} environments (fragile in remark-math, breaks rendering)
  const beginMatch = md.match(/\\begin\{([^}]+)\}/);
  if (beginMatch) {
    errors.push(
      `description contains \\begin{${beginMatch[1]}} — use a \`\`\`math block for simple formulas or rewrite as a table`,
    );
  }

  // Reject unbalanced $$ delimiters (odd count → unclosed block corrupts all subsequent markdown)
  const ddCount = (md.match(/\$\$/g) || []).length;
  if (ddCount % 2 !== 0) {
    errors.push(
      'description has unbalanced $$ delimiters — use ```math fenced blocks for display math',
    );
  }

  // Reject unclosed fenced blocks (walk lines, track open/close state)
  let insideFence = false;
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!insideFence && trimmed.startsWith('```')) {
      insideFence = true;
    } else if (insideFence && trimmed === '```') {
      insideFence = false;
    }
  }
  if (insideFence) {
    errors.push(
      'description has an unclosed fenced block — ensure closing ``` is present',
    );
  }

  return errors;
}

/**
 * Validate enrich_view input.
 * @param input — auto-fixed AI input
 * @param resolvedNodeIds — canonical node set (from stored graph or fallback)
 */
export function validateEnrichView(
  input: EnrichViewInput,
  resolvedNodeIds: string[],
): EnrichViewRequest | EnrichViewError {
  const errors: string[] = [];

  // Name validation
  if (!input.name || input.name.trim().length === 0) errors.push('name is required');
  else if (input.name.length > ENRICH_VIEW_NAME_MAX_LENGTH) errors.push(`name exceeds ${ENRICH_VIEW_NAME_MAX_LENGTH} characters`);

  // Node set must be non-empty (after resolve + prune)
  if (resolvedNodeIds.length === 0) {
    errors.push('No nodes in view — the result graph is empty or all nodes were pruned');
  }

  // summary required + length: soft 120 (instructed), hard 300 (rejected)
  if (!input.summary || input.summary.trim().length === 0) {
    errors.push(`summary is required — one-line graph purpose (~120 chars, max ${ENRICH_VIEW_SUMMARY_HARD_LIMIT})`);
  } else if (input.summary.length > ENRICH_VIEW_SUMMARY_HARD_LIMIT) {
    errors.push(`summary exceeds hard limit (${ENRICH_VIEW_SUMMARY_HARD_LIMIT} chars) — aim for ~120 chars`);
  }

  // description optional — if provided, validate structure + markdown format
  if (input.description && input.description.trim().length > 0) {
    // Must have structure: ## headings or multiple paragraphs
    if (!input.description.includes('##') && !input.description.includes('\n\n')) {
      errors.push('description must use ## headings or multiple paragraphs — not a single block of text');
    }
    // Must not be a graph walkthrough
    const descLower = input.description.trimStart().toLowerCase();
    const WALKTHROUGH_PREFIXES = ['traces how', 'shows the', 'data flows', 'this view shows', 'visualizes'];
    if (WALKTHROUGH_PREFIXES.some(p => descLower.startsWith(p))) {
      errors.push('description re-describes the graph — explain business logic, formulas, column mappings instead');
    }
    // Markdown format validation (LaTeX delimiters, math blocks)
    errors.push(...validateMarkdownFormat(input.description));
  }

  // highlight_groups validation (structural + color validity)
  if (input.highlight_groups) {
    if (input.highlight_groups.length > 5) errors.push('highlight_groups exceeds maximum of 5');
    for (const g of input.highlight_groups) {
      if (!g.label) errors.push('Group label is required');
      if (!AI_HIGHLIGHT_ROLES.has(g.color)) errors.push(`Group "${g.label}" has invalid role "${g.color}"`);
    }
  }

  if (errors.length > 0) {
    // Identify which fields failed so the hint tells the AI exactly what to fix
    const failedFields = new Set<string>();
    for (const e of errors) {
      if (e.startsWith('name ') || e.startsWith('name exceeds')) failedFields.add('name');
      else if (e.includes('summary')) failedFields.add('summary');
      else if (e.includes('description')) failedFields.add('description');
      else if (e.includes('highlight_groups') || e.startsWith('Group ')) failedFields.add('highlight_groups');
      else if (e.includes('No nodes')) failedFields.add('nodes');
    }
    const fieldList = [...failedFields];
    const hint = fieldList.length === 1
      ? `Fix ${fieldList[0]} only. Keep all other fields (badges, notes, summary, highlight_groups) exactly as submitted.`
      : `Fix these fields: ${fieldList.join(', ')}. Keep all other fields exactly as submitted.`;
    return { success: false, errors, hint };
  }

  return {
    success: true,
    name: input.name.trim(),
    node_ids: resolvedNodeIds,
    summary: input.summary,
    description: input.description,
    layout_direction: input.layout_direction ?? 'TB',
    highlight_groups: input.highlight_groups ?? [],
    badges: input.badges ?? [],
    notes: input.notes ?? [],
  };
}

// ─── Tool 8: lineage_get_ddl_batch ───────────────────────────────────────────

export function getDdlBatch(
  model: DatabaseModel,
  ids: string[],
  store?: import('../engine/columnStore').ColumnStore,
): object {
  const nodeMap = buildNodeMap(model);

  // Never truncate — return full DDL for all requested IDs
  const results = ids.map(id => {
    const node = nodeMap.get(id);
    if (!node) {
      return strip({ id, error: 'not_found' } as Record<string, unknown>);
    }
    const rawDdl = store?.getDdl(id) ?? node.bodyScript;
    if (!rawDdl) {
      return strip({ id, t: node.type } as Record<string, unknown>);
    }
    const ddl = normalizeBodyScript(rawDdl);
    return strip({ id, t: node.type, ddl } as Record<string, unknown>);
  });

  return { results, total: results.length };
}

