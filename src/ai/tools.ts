/**
 * AI tool pure functions — zero VS Code imports.
 * 8 classic retrieval functions invoked by classic LanguageModelTools in extension.ts.
 * CT and BB tools (start_exploration, submit_findings)
 * are handled directly by NavigationEngine in toolProvider.ts.
 *
 * This file owns RETRIEVAL ONLY. All formatting/normalization lives in aiPresenter.ts.
 */
import { bfsFromNode } from 'graphology-traversal';
import type Graph from 'graphology';
import { z } from 'zod';
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type LineageNode,
  type ColumnDef,
  type ObjectType,
  type AnalysisType,
} from '../engine/types';
import { runAnalysis as runGraphAnalysis } from '../engine/graphAnalysis';
import { ColumnStore } from '../engine/columnStore';
import { searchCatalog, searchColumns, safeRegex, searchBodyScripts, type SearchableNode } from '../utils/modelSearch';
import { normalizeBodyScript } from '../utils/sql';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentColumnCompact, presentFkCompact,
  presentSchema, presentNeighbor, presentFilter,
} from './aiPresenter';


import { shouldInline, estimateTokens, REGEX_MAX_LENGTH, getEffectiveBudget } from './tokenBudget';
export { shouldInline, shouldSmInline, estimateTokens, getEffectiveBudget, setInlineTokenBudget, setSmInlineNodeCap } from './tokenBudget';

/** Max nodes for inline BFS delivery — above this, recommend state machine. */
export const BFS_INLINE_NODE_CAP = 200;
/** Max results returned in fallback (cross-schema) search. */
export const FALLBACK_RESULT_LIMIT = 10;


type FieldType = 'string' | 'array' | 'number' | 'object' | 'boolean';

/**
 * Zod schema for `start_exploration` tool input. Parsed at the boundary so malformed
 * payloads (e.g. missing `origin`) produce a structured `missing_field` error instead
 * of crashing `NavigationEngine.init` on `.toLowerCase()` of undefined.
 */
export const StartExplorationInputSchema = z.object({
  origin: z.string().min(1),
  question: z.string().optional(),
  targetColumns: z.array(z.string()).optional(),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional(),
  depth: z.number().int().positive().optional(),
  depth_enforcement: z.enum(['strict', 'soft', 'silent']).optional(),
  excludeTypes: z.array(z.string()).optional(),
  mission_brief: z.string().optional(),
  classification: z.enum(['business', 'technical', 'both']).optional(),
});

export type StartExplorationInput = z.infer<typeof StartExplorationInputSchema>;

/**
 * Zod schema for a single finding within `submit_findings`.
 */
const HopFindingSchema = z.object({
  focus_node_id: z.string(),
  detail_analysis: z.string(),
  summary: z.string(),
  verdict: z.enum(['analyze', 'pass', 'prune']),
  route_requests: z.array(z.object({
    nodeId: z.string(),
    question: z.string(),
    columns: z.array(z.string()).optional(),
  })).optional(),
  prune_neighbors: z.array(z.string()).optional(),
  complete: z.boolean().optional(),
  badge_label: z.string().optional(),
  note_caption: z.string().optional(),
  column_flow: z.array(z.object({
    out_col: z.string(),
    contributors: z.array(z.object({
      from_node: z.string(),
      from_col: z.string(),
      role: z.enum(['formula', 'rename', 'case', 'coalesce', 'join_value', 'aggregate', 'filter_only', 'source']),
    })),
  })).optional(),
});

/**
 * Zod schema for `submit_findings` tool input. 
 * Supports both a single finding object (Sliding Memory) 
 * and an array of finding objects (True Inline batch).
 */
export const SubmitFindingsInputSchema = z.union([
  HopFindingSchema,
  z.array(HopFindingSchema)
]);

export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInputSchema>;

/**
 * Lightweight runtime validation for LLM tool inputs.
 *
 * @remarks
 * This function ensures that tool inputs provided by the language model match the
 * expected schema. It returns a structured error if any required field is missing
 * or has the wrong type, allowing the AI to self-correct.
 *
 * @param input - The raw input object provided by the language model.
 * @param required - A map of required field names to their expected TypeScript types.
 * @returns An error object if validation fails, otherwise `null`.
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


/** Number of context lines shown in DDL/body search snippets. */
const SNIPPET_CONTEXT_LINES = 2;
const COLUMN_SEARCH_LIMIT = 50;
const PRESENT_RESULT_NAME_MAX_LENGTH = 60;
const PRESENT_RESULT_SUMMARY_HARD_LIMIT = 300;

/**
 * Builds a lookup map for edges between nodes.
 *
 * @param model - The full database model.
 * @returns A map where the key is "sourceId→targetId" and the value is the API-compatible edge type.
 */
export function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e.type));
  }
  return m;
}

/**
 * Builds a lookup map for nodes by their ID.
 *
 * @param model - The full database model.
 * @returns A map of node IDs to their respective LineageNode objects.
 */
export function buildNodeMap(model: DatabaseModel): Map<string, LineageNode> {
  const m = new Map<string, LineageNode>();
  for (const n of model.nodes) m.set(n.id, n);
  return m;
}

/**
 * Builds a map of lowercase "Schema.Name" to lists of unresolved (unrelated) references.
 *
 * @remarks
 * Unresolved references are identifiers found in the DDL during parsing that do not
 * exist in the current model. This metadata helps the AI understand potential
 * external dependencies or missing objects.
 *
 * @param model - The full database model.
 * @returns A map of object names to their unresolved reference strings.
 */
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


/**
 * Retrieves the column definitions for a specific node, preferring the ColumnStore if available.
 *
 * @param nodeId - The unique identifier of the node.
 * @param nodeMap - The ground-truth map of all nodes.
 * @param store - Optional column store for high-fidelity metadata.
 * @returns An array of column definitions, or `undefined` if the node is not found.
 */
export function getNodeColumns(
  nodeId: string, nodeMap: Map<string, LineageNode>,
  store?: ColumnStore,
): ColumnDef[] | undefined {
  return (typeof store?.getColumns === 'function' ? store.getColumns(nodeId) : undefined) ?? nodeMap.get(nodeId)?.columns;
}

/**
 * Retrieves the normalized DDL for a specific node.
 *
 * @param nodeId - The unique identifier of the node.
 * @param nodeMap - The ground-truth map of all nodes.
 * @param store - Optional column store for high-fidelity DDL.
 * @returns The normalized DDL string, or `undefined` if not available.
 */
export function getNodeDdl(
  nodeId: string, nodeMap: Map<string, LineageNode>,
  store?: ColumnStore,
): string | undefined {
  const raw = (typeof store?.getDdl === 'function' ? store.getDdl(nodeId) : undefined) ?? nodeMap.get(nodeId)?.bodyScript;
  return raw ? normalizeBodyScript(raw) : undefined;
}

/**
 * Constructs a detailed "Focus Node" object for use in exploration hop contexts.
 *
 * @remarks
 * This function packages all pertinent metadata for a node (DDL, columns, foreign keys,
 * and unresolved references) into a shape suitable for the AI agent to analyze during a hop.
 *
 * @param node - The node currently in focus.
 * @param nodeMap - The map of all nodes.
 * @param unrelatedMap - The map of unresolved references.
 * @param store - Optional high-fidelity column store.
 * @param ddlKey - The key to use for the DDL property (defaults to 'ddl').
 * @returns A record containing the focus node's metadata.
 */
/** Per-node DDL character cap for hop focus delivery. Verbose utility/log procs (LogMessage etc.)
 *  can balloon a hop payload 5x+; cap them and instruct the AI to fetch the full DDL on-demand
 *  via get_ddl_batch if the context is insufficient. */
const HOP_DDL_CHAR_CAP = 8000;

export function buildHopFocusNode(
  node: LineageNode,
  nodeMap: Map<string, LineageNode>,
  unrelatedMap: Map<string, string[]>,
  store?: ColumnStore,
  ddlKey = 'ddl',
): Record<string, unknown> {
  const focusNode: Record<string, unknown> = {
    id: node.id, s: node.schema, n: node.name, t: node.type,
  };
  const ddl = getNodeDdl(node.id, nodeMap, store);
  const cols = getNodeColumns(node.id, nodeMap, store);
  if (SCRIPT_TYPES.has(node.type) && ddl) {
    if (ddl.length > HOP_DDL_CHAR_CAP) {
      focusNode[ddlKey] = ddl.slice(0, HOP_DDL_CHAR_CAP) + '\n-- …DDL truncated…';
      focusNode.ddl_truncated = true;
      focusNode.ddl_original_chars = ddl.length;
      focusNode.ddl_hint = `DDL truncated at ${HOP_DDL_CHAR_CAP} chars (original ${ddl.length}). Call get_ddl_batch with this node id if the truncated portion is material to the analysis.`;
    } else {
      focusNode[ddlKey] = ddl;
    }
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


/**
 * Retrieves the high-level context of the current project for the AI.
 *
 * @remarks
 * This function builds a summary of the loaded model, including schema lists,
 * visible node counts, and token budget estimates. If the catalog is small enough,
 * it inlines the full object list and edges; otherwise, it provides a summary
 * and instructs the AI to use on-demand retrieval.
 *
 * @param model - The database model.
 * @param activeFilter - The current UI filter state.
 * @param projectName - The name of the active project.
 * @param savedViews - The list of user-saved bookmarks/views.
 * @param store - Optional column store.
 * @returns An object containing project metadata and potentially the full catalog.
 */
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


/**
 * Validates a search query for sanity.
 *
 * @param query - The user-provided search string.
 * @returns Success status or an error with a hint.
 */
export function validateQuery(query: string): { ok: true } | { ok: false; error: string; hint: string } {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { ok: false, error: 'query_too_short', hint: 'Use at least 2 characters.' };
  }
  if (/^[.*?+^$]+$/.test(trimmed)) {
    return { ok: false, error: 'query_too_broad', hint: 'Query matches everything. Be more specific or use schemas[] to narrow scope.' };
  }
  return { ok: true };
}


/**
 * Searches for objects in the model by name or column name.
 *
 * @remarks
 * This function performs a fuzzy or regex search across object names and column names.
 * It automatically handles schema mismatches by searching globally if a schema-restricted
 * search yields no results.
 *
 * @param model - The database model.
 * @param query - The search query.
 * @param types - Optional filter for object types.
 * @param schemas - Optional filter for schemas.
 * @param mode - Search mode ('substring' or 'regex').
 * @param activeFilter - Current UI filter state to tag results.
 * @returns A list of matches with metadata and AI hints.
 */
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
    in_user_filter: filterSchemaSet ? filterSchemaSet.has((((r as Record<string, unknown>).s as string) ?? '').toLowerCase()) : true,
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
        FALLBACK_RESULT_LIMIT,
        mode,
      );
      if (fallbackHits.length > 0) {
        const foundSchemas = [...new Set(fallbackHits.map(n => n.schema))];
        // Return fallback results as primary — AI can proceed immediately
        const fallbackResults = fallbackHits.slice(0, FALLBACK_RESULT_LIMIT).map(n => ({
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


const NEIGHBOR_CAP = 25;

/**
 * Retrieves full metadata for a specific database object, including DDL, columns, and neighbors.
 *
 * @remarks
 * This is the primary "drill-down" tool for the AI. It provides a high-fidelity view of a single node,
 * including its schema, name, type, and relationships. Upstream and downstream neighbors are capped
 * to prevent token overflow, but DDL and column lists are always delivered in full.
 *
 * @param model - The full database model.
 * @param id - The unique identifier of the object (e.g., "schema.name").
 * @param store - Optional column store for high-fidelity metadata.
 * @returns A detailed object representation or a "not_found" error.
 */
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

/**
 * Largest BFS depth from `origin` whose scope fits within `safeNodeCap`.
 *
 * @remarks
 * Used by the preflight scope-vs-budget gate in `lineage_start_exploration`. Walks
 * outwards from the origin and returns the depth just before the scope exceeds the
 * cap, clamping at 1 (callers never recommend `depth=0`). Returns 0 only when even
 * the origin + immediate neighbors exceed the cap, which signals an unwinnable
 * budget and should be surfaced as-is for the AI to re-ask the user.
 *
 * @param graph - Loaded lineage graph.
 * @param origin - Origin node id.
 * @param direction - BFS direction, same enum accepted by `lineage_start_exploration`.
 * @param safeNodeCap - Largest scope size that still leaves headroom in the round budget.
 * @returns Suggested depth, 1 or above when feasible, 0 when the budget is too tight.
 */
export function suggestNarrowerDepth(
  graph: Graph,
  origin: string,
  direction: 'upstream' | 'downstream' | 'bidirectional',
  safeNodeCap: number,
): number {
  const mode = direction === 'upstream' ? 'inbound' : direction === 'downstream' ? 'outbound' : 'directed';
  const depthMap = new Map<string, number>();
  let maxSafeDepth = 0;
  bfsFromNode(graph, origin, (key, _attr, depth) => {
    depthMap.set(key, depth);
    return false;
  }, { mode });
  // Count nodes at each depth and accumulate — pick the largest depth whose cumulative count fits.
  const byDepth: number[] = [];
  for (const d of depthMap.values()) byDepth[d] = (byDepth[d] ?? 0) + 1;
  let running = 0;
  for (let d = 0; d < byDepth.length; d++) {
    running += byDepth[d] ?? 0;
    if (running > safeNodeCap) break;
    maxSafeDepth = d;
  }
  return Math.max(maxSafeDepth, maxSafeDepth === 0 ? 0 : 1);
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

/**
 * Performs a Breadth-First Search (BFS) trace to explore data lineage.
 *
 * @remarks
 * This function supports two distinct modes:
 * 1. **Level Mode**: Explores upstream and downstream from a focal node up to a specified depth.
 * 2. **Path Mode**: Finds all nodes on all paths between an origin and a target node.
 *
 * It automatically manages token usage by checking if the resulting payload (including DDL)
 * fits within the effective budget. If it exceeds the budget, it returns a structural summary
 * and recommends the "state machine" (SM) mode for incremental exploration.
 *
 * @param model - The database model.
 * @param graph - The graphology instance representing the lineage.
 * @param id - The focal node identifier.
 * @param upstreamHops - Maximum depth to traverse upstream (Level Mode).
 * @param downstreamHops - Maximum depth to traverse downstream (Level Mode).
 * @param types - Optional object type filter.
 * @param schemas - Optional schema filter.
 * @param includeDdl - Whether to include full DDL/column definitions in the output.
 * @param store - Optional column store for high-fidelity data.
 * @param target - The destination node identifier (triggers Path Mode).
 * @returns A structured result containing nodes, edges, and delivery metadata.
 */
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


/**
 * Executes a structural graph analysis to identify hubs, islands, or longest paths.
 *
 * @remarks
 * This tool allows the AI to perform higher-level reasoning about the entire graph topology
 * without retrieving every node's metadata. It uses deterministic engine logic to find
 * architectural hotspots and change-risk areas.
 *
 * @param model - The database model.
 * @param graph - The graphology instance.
 * @param type - The type of analysis to perform ('hubs', 'islands', 'longest_path', 'cycles').
 * @param minDegree - Minimum degree for a node to be considered a hub.
 * @param maxSize - Maximum size for a connected component to be considered an island.
 * @param longestPathMinNodes - Minimum number of nodes for a path to be considered "long".
 * @returns A summary of the analysis results including grouped node IDs.
 */
export function runAnalysis(
  model: DatabaseModel,
  graph: Graph,
  type: AnalysisType,
  minDegree?: number,
  maxSize?: number,
  longestPathMinNodes?: number,
): object {
  const analysisConfig = {
    hubMinDegree:         minDegree           ?? DEFAULT_CONFIG.analysis.hubMinDegree,
    islandMaxSize:        maxSize             ?? DEFAULT_CONFIG.analysis.islandMaxSize,
    longestPathMinNodes:  longestPathMinNodes ?? DEFAULT_CONFIG.analysis.longestPathMinNodes,
  };

  const result = runGraphAnalysis(graph, type, analysisConfig, DEFAULT_CONFIG.maxNodes);
  return {
    type:         result.type,
    summary:      result.summary,
    groups:       result.groups,
    total_groups: result.groups.length,
  };
}

/**
 * Searches for substrings or patterns within the DDL/source code of scriptable objects.
 *
 * @remarks
 * This tool is essential for finding logic-level dependencies (e.g., specific business logic,
 * hardcoded strings, or column mappings) that are not captured as formal graph edges.
 * It searches through views, stored procedures, and functions.
 *
 * @param model - The database model.
 * @param query - The search string or regex pattern.
 * @param types - Optional filter for scriptable object types.
 * @param store - Optional column store for high-fidelity DDL.
 * @returns A list of matches with snippets and object metadata.
 */
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


export type AIHighlightRole = 'source' | 'transform' | 'target' | 'good' | 'warn' | 'fail';

export type PresentResultInput = {
  name: string;
  summary: string;
  title?: string;       // doc heading (≤80 chars) — names pipeline + key formula
  intro?: string;       // 2–4 sentence paragraph before the numbered sections
  closing?: string;     // 1–2 sentence cross-cutting risk/note after the sections
  loading_pattern?: string; // SP-only, AI-inferred. Rendered in metadata band above sections.
  description?: string;
  prune_node_ids?: string[];
  add_node_ids?: string[];    // NEW: incremental add
  is_update?: boolean;        // NEW: incremental update flag
  layout_direction?: 'LR' | 'TB';
  highlight_groups?: Array<{
    label: string;
    color: AIHighlightRole;
    node_ids: string[];
  }>;
  sections?: Array<{
    label: string;       // PRIMARY KEY for document grouping — unique per section
    node_ids?: string[]; // nodes that display this label as a badge chip (1..N)
    text: string;        // markdown description for this label group (1..1 per label)
  }>;
  notes?: Array<{
    node_id: string;
    text: string;
  }>;
};

export type PresentResultRequest = {
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

export type PresentResultError = { success: false; errors: string[]; hint: string };

const AI_HIGHLIGHT_ROLES = new Set<string>(['source', 'transform', 'target', 'good', 'warn', 'fail']);

/**
 * Assigns sequential numbers to sections and assembles the final markdown description.
 *
 * @remarks
 * This function is the "finisher" for the AI's lineage report. It ensures that the
 * numbered badges displayed on the visual graph (via `badges[]`) perfectly align with the
 * `## Heading` numbers in the sidebar description. It also handles stripping any leading
 * numbers the AI might have accidentally included in labels to maintain a deterministic,
 * system-managed numbering scheme.
 *
 * @param sections - AI-authored sections containing labels, node associations, and text.
 * @param opts - Optional wrapper blocks for the final document. `metadataBand`
 * is injected between `intro` and the first section.
 * @returns A pair of numbered badges for the graph and the fully assembled markdown description.
 */
export function orderAndAssemble(
  sections: Array<{ label: string; node_ids?: string[]; text: string }>,
  opts?: {
    title?: string;
    intro?: string;
    closing?: string;
    metadataBand?: string;
    /** Optional node lookup for injecting clickable H3 object-name headings per section. */
    nodeMap?: Map<string, { id: string; name: string }>;
  },
): { badges: Array<{ node_id: string; text: string }>; description: string } {
  // Strip leading "N " or "N. " so AI numbers don't interfere with label matching
  const stripLeadingNumber = (s: string) => s.replace(/^\d+[\.]?\s+/, '').trim();

  // First occurrence index per label — preserves AI's narrative order
  const labelToAiIndex = new Map<string, number>();
  sections.forEach((sec, i) => {
    const norm = stripLeadingNumber(sec.label);
    if (!labelToAiIndex.has(norm)) labelToAiIndex.set(norm, i);
  });

  // Unique labels in AI's sections[] order
  const uniqueLabels = [...new Set(sections.map(s => stripLeadingNumber(s.label)))];
  uniqueLabels.sort((a, b) => (labelToAiIndex.get(a) ?? 0) - (labelToAiIndex.get(b) ?? 0));

  // Assign step number N per unique label (1-based, in AI's narrative order)
  const labelToNumber = new Map<string, number>();
  uniqueLabels.forEach((label, i) => labelToNumber.set(label, i + 1));

  // Build (node_id → label) map from sections[].node_ids
  const nodeToLabel = new Map<string, string>();
  for (const sec of sections) {
    const label = stripLeadingNumber(sec.label);
    for (const id of sec.node_ids ?? []) nodeToLabel.set(id, label);
  }

  // Emit numbered badge chips, dropping any node whose label has no matching section.
  const numberedBadges = [...nodeToLabel.entries()]
    .map(([node_id, label]) => {
      const n = labelToNumber.get(label);
      return n !== undefined ? { node_id, text: `${n} ${label}`, _n: n } : null;
    })
    .filter((b): b is { node_id: string; text: string; _n: number } => b !== null)
    .sort((a, b) => a._n - b._n)
    .map(({ node_id, text }) => ({ node_id, text }));

  // Assemble markdown: title → intro → metadata band → ## sections → closing
  const sectionMap = new Map(sections.map(s => [stripLeadingNumber(s.label), s.text]));
  // First-occurrence node_ids list per unique label (AI-authored order preserved).
  const labelToNodeIds = new Map<string, string[]>();
  for (const sec of sections) {
    const label = stripLeadingNumber(sec.label);
    if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, sec.node_ids ?? []);
  }

  const parts: string[] = [];
  if (opts?.title)        parts.push(`# ${opts.title}`);
  if (opts?.intro)        parts.push(opts.intro);
  if (opts?.metadataBand) parts.push(opts.metadataBand);
  for (const label of uniqueLabels) {
    const n = labelToNumber.get(label)!;
    const text = sectionMap.get(label) ?? '';
    const nodeIds = labelToNodeIds.get(label) ?? [];
    let objectHeadings = '';
    if (opts?.nodeMap && nodeIds.length > 0) {
      const lines = nodeIds
        .map(id => opts.nodeMap!.get(id))
        .filter((node): node is { id: string; name: string } => !!node)
        .map(node => `### [${node.name}](#focus-node:${node.id})`);
      if (lines.length > 0) objectHeadings = lines.join('\n') + '\n\n';
    }
    parts.push(`## ${n} ${label}\n\n${objectHeadings}${text}`);
  }
  if (opts?.closing) parts.push(`---\n\n${opts.closing}`);

  return { badges: numberedBadges, description: parts.join('\n\n') };
}

/**
 * Normalizes and "auto-fixes" common AI output artifacts in the final presentation input.
 *
 * @remarks
 * LLMs often produce slightly malformed outputs such as double-escaped newlines,
 * excessive title lengths, or improper LaTeX formatting. This function applies
 * surgical corrections (e.g., converting `$$` math blocks to markdown fences)
 * to ensure the final UI renders perfectly without rejecting the AI's work for
 * minor stylistic issues.
 *
 * @param model - The database model.
 * @param input - The raw input from the AI.
 * @param resolvedNodeIds - The canonical set of node IDs in the current session.
 * @returns The fixed input object and a list of applied fixes for logging.
 */
export function autoFixPresentResult(
  model: DatabaseModel,
  input: PresentResultInput,
  resolvedNodeIds?: string[],
): { input: PresentResultInput; fixes: string[] } {
  const fixes: string[] = [];
  let fixed = { ...input };

  // 0. Normalize escaped newlines in description (LLMs sometimes double-escape)
  // Protect known LaTeX macros: \text, \times, \theta, \tau, \to, \neq, \nu, \nabla, etc.
  if (fixed.description && /\\n/.test(fixed.description)) {
    fixed = { ...fixed, description: fixed.description
      .replace(/\\n(?!(?:eq|eg|u|ot|abla|otin|i|mid|leq|geq)\b)/g, '\n')
      .replace(/\\t(?!(?:ext|imes|au|heta|o|op|ilde|frac|herefore|riangle)\b)/g, '\t') };
    fixes.push('Normalized escaped newlines in description');
  }

  // 1. Auto-truncate name at word boundary if too long
  if (fixed.name && fixed.name.length > PRESENT_RESULT_NAME_MAX_LENGTH) {
    const truncated = fixed.name.slice(0, PRESENT_RESULT_NAME_MAX_LENGTH).replace(/\s+\S*$/, '').trimEnd();
    fixed = { ...fixed, name: truncated || fixed.name.slice(0, PRESENT_RESULT_NAME_MAX_LENGTH) };
    fixes.push(`Truncated name to ${PRESENT_RESULT_NAME_MAX_LENGTH} chars`);
  }

  // 2. Auto-truncate title at word boundary if too long
  if (fixed.title && fixed.title.trim().length > 80) {
    const truncated = fixed.title.slice(0, 80).replace(/\s+\S*$/, '').trimEnd();
    fixed = { ...fixed, title: truncated || fixed.title.slice(0, 80) };
    fixes.push('Truncated title to 80 chars');
  }

  // 3. Auto-truncate summary at sentence boundary if too long
  if (fixed.summary && fixed.summary.length > PRESENT_RESULT_SUMMARY_HARD_LIMIT) {
    const truncated = fixed.summary.slice(0, PRESENT_RESULT_SUMMARY_HARD_LIMIT);
    const lastPeriod = truncated.lastIndexOf('.');
    fixed = { ...fixed, summary: lastPeriod > 80 ? truncated.slice(0, lastPeriod + 1) : truncated.trimEnd() };
    fixes.push(`Truncated summary to ${PRESENT_RESULT_SUMMARY_HARD_LIMIT} chars`);
  }

  // 4. Convert $$ block math to ```math code fences.
  //    Code fences are CommonMark structural elements — they can't break markdown.
  //    Block math: rendered via components.code override in AiDescriptionOverlay.
  //    Inline math ($...$): handled by remark-math + rehype-katex (span-level, safe).

  /** Detect lines that are clearly markdown, not math.
   *  If found inside a math block, the block is force-closed before this line. */
  const IS_MARKDOWN = /^#{1,6}\s|^```|^[-*+]\s|^>\s|`|\*\*\w/;

  /** Convert $$ block math to ```math code fences.
   *  Single-pass: normalize $$ to own lines, then convert to fences.
   *  If markdown appears inside a math block, force-close the fence.
   *  Auto-close unclosed \begin{env} before fence end.
   *  Strip orphan \end{env} and trailing \\ outside fences. */
  const fixLatex = (text: string): { text: string; changed: boolean } => {
    // Step 1: normalize $$ to own lines
    const rawLines = text.split('\n');
    const normalized: string[] = [];
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed === '$$') {
        normalized.push('$$');
      } else if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
        normalized.push('$$');
        normalized.push(trimmed.slice(2, -2).trim());
        normalized.push('$$');
      } else if (trimmed.startsWith('$$')) {
        normalized.push('$$');
        normalized.push(trimmed.slice(2).trim());
      } else if (trimmed.endsWith('$$') && !trimmed.startsWith('|')) {
        normalized.push(trimmed.slice(0, -2).trim());
        normalized.push('$$');
      } else {
        normalized.push(line);
      }
    }

    // Step 2: convert $$ open/close to ```math / ```
    let changed = false;
    const out: string[] = [];
    let insideMath = false;
    const openEnvs: string[] = []; // stack of unclosed \begin{env}

    const closeFence = () => {
      // Auto-close unclosed \begin{env} before fence end
      while (openEnvs.length > 0) {
        out.push('\\end{' + openEnvs.pop() + '}');
        changed = true;
      }
      out.push('```');
      insideMath = false;
    };

    for (const line of normalized) {
      const trimmed = line.trim();

      // $$ delimiter
      if (trimmed === '$$') {
        changed = true;
        if (!insideMath) {
          out.push('```math');
          insideMath = true;
        } else {
          closeFence();
        }
        continue;
      }

      // Inside math: check for markdown lines that shouldn't be here
      if (insideMath && IS_MARKDOWN.test(trimmed)) {
        changed = true;
        closeFence();
        // Emit the markdown line (strip trailing \\ which is a LaTeX artifact)
        out.push(line.replace(/\s*\\\\$/, ''));
        continue;
      }

      // Inside math: track \begin/\end for auto-close
      if (insideMath) {
        const beginMatch = trimmed.match(/\\begin\{(\w+)\}/);
        if (beginMatch) openEnvs.push(beginMatch[1]);
        const endMatch = trimmed.match(/\\end\{(\w+)\}/);
        if (endMatch && openEnvs.length > 0 && openEnvs[openEnvs.length - 1] === endMatch[1]) {
          openEnvs.pop();
        }
        out.push(line);
        continue;
      }

      // Outside math: strip orphan \end{env} on its own line
      if (/^\\end\{\w+\}\s*$/.test(trimmed)) {
        changed = true;
        continue;
      }

      // Outside math: strip trailing \\ (LaTeX row separator artifact)
      if (/\\\\\s*$/.test(trimmed)) {
        changed = true;
        out.push(line.replace(/\s*\\\\$/, ''));
        continue;
      }

      out.push(line);
    }

    // EOF inside math: close fence
    if (insideMath) {
      changed = true;
      closeFence();
    }

    return { text: out.join('\n'), changed };
  };

  // Apply LaTeX fix to description, section text, and notes
  if (fixed.description) {
    const r = fixLatex(fixed.description);
    if (r.changed) { fixed = { ...fixed, description: r.text }; fixes.push('Converted LaTeX to ```math blocks in description'); }
  }
  if (fixed.sections) {
    let sectionFixed = false;
    const newSections = fixed.sections.map(s => {
      if (!s.text) return s;
      const r = fixLatex(s.text);
      if (r.changed) { sectionFixed = true; return { ...s, text: r.text }; }
      return s;
    });
    if (sectionFixed) { fixed = { ...fixed, sections: newSections }; fixes.push('Converted LaTeX to ```math blocks in sections'); }
  }
  if (fixed.notes) {
    let noteFixed = false;
    const newNotes = fixed.notes.map(n => {
      if (!n.text) return n;
      const r = fixLatex(n.text);
      if (r.changed) { noteFixed = true; return { ...n, text: r.text }; }
      return n;
    });
    if (noteFixed) { fixed = { ...fixed, notes: newNotes }; fixes.push('Converted LaTeX to ```math blocks in notes'); }
  }

  const nodeIdSet = new Set(resolvedNodeIds ?? []);

  // 5. Drop empty notes & notes for nodes not in the resolved set
  if (fixed.notes) {
    const before = fixed.notes.length;
    const filtered = fixed.notes.filter(n => nodeIdSet.has(n.node_id) && n.text && n.text.trim().length > 0);
    fixed = { ...fixed, notes: filtered };
    const dropped = before - filtered.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned note(s)`);
  }

  // 6. Prune highlight_groups referencing nodes not in the resolved set
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

/**
 * Validates markdown structural integrity.
 *
 * @remarks
 * This function performs a pass to ensure that markdown elements (specifically code fences)
 * are properly closed. It prevents the UI from crashing or entering a broken state due to
 * malformed markdown generated by the AI.
 *
 * @param md - The markdown string to validate.
 * @returns A list of error strings, or an empty array if valid.
 */
export function validateMarkdownFormat(md: string): string[] {
  const errors: string[] = [];

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
 * Validates the full `present_result` input against mechanical contracts only.
 *
 * @remarks
 * Enforces naming length, summary length, mutual-exclusion between `description`
 * and `sections[]`, required fields, node-id resolution, and markdown-fence closure.
 *
 * @param input - The (possibly auto-fixed) AI input.
 * @param resolvedNodeIds - The canonical set of node IDs.
 * @param assembledBadges - Pre-assembled numbered badges for consistency.
 * @returns A successful request object or a structured error with correction hints.
 */
export function validatePresentResult(
  input: PresentResultInput,
  resolvedNodeIds: string[],
  assembledBadges?: Array<{ node_id: string; text: string }>,
): PresentResultRequest | PresentResultError {
  const errors: string[] = [];

  // Name validation
  if (!input.name || input.name.trim().length === 0) errors.push('name is required');
  else if (input.name.length > PRESENT_RESULT_NAME_MAX_LENGTH) errors.push(`name exceeds ${PRESENT_RESULT_NAME_MAX_LENGTH} characters`);

  // Node set must be non-empty (after resolve + prune)
  if (resolvedNodeIds.length === 0) {
    errors.push('No nodes in view — the result graph is empty or all nodes were pruned');
  }

  if (input.title && input.title.trim().length > 80) errors.push('title exceeds 80 characters');

  // summary required + length
  if (!input.summary || input.summary.trim().length === 0) {
    errors.push(`summary is required — one-line graph purpose (~120 chars, max ${PRESENT_RESULT_SUMMARY_HARD_LIMIT})`);
  } else if (input.summary.length > PRESENT_RESULT_SUMMARY_HARD_LIMIT) {
    errors.push(`summary exceeds hard limit (${PRESENT_RESULT_SUMMARY_HARD_LIMIT} chars) — aim for ~120 chars`);
  }

  const hasSections = !!(input.sections && input.sections.length > 0);
  const hasDescription = !!(input.description && input.description.trim().length > 0);

  if (!hasSections && !hasDescription) {
    errors.push('provide either sections[] (node groupings with labels) OR description (narrative summary) — at least one is required');
  }

  // description validation
  if (hasDescription) {
    // sections[] and description are mutually exclusive — contract, not content judgment
    if (hasSections) {
      errors.push('Provide either sections[] or description — not both. Use sections[] for structured output; description is the fallback for unstructured answers only');
    }
    // Markdown format validation (unclosed fences) — mechanical
    errors.push(...validateMarkdownFormat(input.description!));
  }

  // Sections validation — node_ids (when provided) must be valid; section text must be present.
  if (hasSections) {
    const resolvedSet = new Set(resolvedNodeIds);
    for (const sec of input.sections!) {
      if (sec.node_ids?.length) {
        const unknownIds = sec.node_ids.filter(id => !resolvedSet.has(id));
        if (unknownIds.length > 0) {
          errors.push(`Section "${sec.label}" node_ids contains unknown IDs: ${unknownIds.slice(0, 3).join(', ')}${unknownIds.length > 3 ? ' ...' : ''} — use IDs from the result graph`);
        }
      }
      if (!sec.text || sec.text.trim().length === 0) {
        errors.push(`Section "${sec.label}" is missing text — write the per-node content from the detail archive`);
      }
      if (sec.text) errors.push(...validateMarkdownFormat(sec.text).map(e => `Section "${sec.label}": ${e}`));
    }
  }

  // Notes validation
  if (input.notes?.length) {
    for (const note of input.notes) {
      if (!note.text || note.text.trim().length === 0) {
        errors.push(`Note for "${note.node_id}" is missing text`);
      }
    }
  }

  // highlight_groups validation
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
      else if (e.startsWith('title ')) failedFields.add('title');
      else if (e.startsWith('closing ')) failedFields.add('closing');
      else if (e.includes('summary')) failedFields.add('summary');
      else if (e.includes('description') || e.includes('sections')) {
        failedFields.add('description');
        failedFields.add('sections');
      }
      else if (e.startsWith('Section ')) failedFields.add('sections');
      else if (e.startsWith('Note for ')) failedFields.add('notes');
      else if (e.includes('highlight_groups') || e.startsWith('Group ')) failedFields.add('highlight_groups');
      else if (e.includes('No nodes')) failedFields.add('nodes');
    }
    const fieldList = [...failedFields];
    const hint = fieldList.length === 1
      ? `Fix ${fieldList[0]} only. Keep all other fields (notes, summary, highlight_groups) exactly as submitted.`
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
    badges: assembledBadges ?? [],
    notes: input.notes ?? [],
  };
}

/**
 * Retrieves DDL for a batch of object IDs.
 *
 * @remarks
 * This is a high-performance batch retrieval tool. It ensures the AI can retrieve
 * multiple DDL scripts in a single turn without hitting the per-message token cap
 * (if individual scripts are small) or requiring multiple tool calls.
 *
 * @param model - The database model.
 * @param ids - The list of object IDs.
 * @param store - Optional column store for high-fidelity DDL.
 * @returns A list of DDL results, including object types.
 */
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

/**
 * Structural summary of the final presentation result.
 */
export interface PresentResultResult {
  success: boolean;
  name: string;
  summary: string;
  description?: string;
  node_count: number;
}
