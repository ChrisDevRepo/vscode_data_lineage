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
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type LineageNode,
  type ColumnDef,
  type ObjectType,
  type AnalysisType,
  type NeighborIndex,
} from '../../engine/types';
import { normalizeName } from '../../engine/modelBuilder';
import { runAnalysis as runGraphAnalysis } from '../../engine/graphAnalysis';
import { ColumnStore } from '../../engine/columnStore';
import { searchCatalog, searchColumns, safeRegex, searchBodyScripts, type SearchableNode } from '../../utils/modelSearch';
import { normalizeBodyScript } from '../../utils/sql';
import { normalizeSearchQueryInput } from '../infra/inputNormalization';
import type { SerializedFilterState, FilterProfile } from '../../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentColumnCompact, presentFkCompact,
  presentSchema, presentNeighbor, presentFilter,
} from '../infra/aiPresenter';
import { type GetScopeBundleInput } from './toolSchemas';


import { shouldInline, estimateTokens, REGEX_MAX_LENGTH, getEffectiveBudget, checkScopeBudget } from '../infra/tokenBudget';
export { shouldInline, estimateTokens, getEffectiveBudget, setCatalogInlineTokenBudget, setDiscoveryNodeCap, setDiscoveryTokenBudget, checkScopeBudget, getDiscoveryLimits } from '../infra/tokenBudget';

/** Max nodes for inline BFS delivery — above this, recommend state machine. */
export const BFS_INLINE_NODE_CAP = 200;

/** Number of context lines shown in DDL/body search snippets. */
const SNIPPET_CONTEXT_LINES = 2;
/** Hard cap on `search_columns` results — prevents unbounded enumeration on wide schemas. */
const COLUMN_SEARCH_LIMIT = 50;

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
 * Extracts `@ParamName` identifiers from a procedure/function DDL signature.
 *
 * @remarks
 * Parses the parameter list between `CREATE PROCEDURE`/`CREATE FUNCTION` and the `AS` keyword.
 *
 * @param ddl - Raw DDL body of a procedure or function.
 * @returns Array of parameter names (with leading `@`), or empty array if none found.
 */
export function parseProcParams(ddl: string): string[] {
  // Match everything between the object header and the AS/BEGIN keyword
  const headerMatch = ddl.match(/CREATE\s+(?:PROCEDURE|PROC|FUNCTION)\s+[^\s(]+\s*([\s\S]*?)\s+AS\b/i);
  if (!headerMatch) return [];
  const paramSection = headerMatch[1];
  const params: string[] = [];
  // Each @Param followed by a type declaration
  const paramRe = /@(\w+)\s+\w/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(paramSection)) !== null) {
    params.push(`@${m[1]}`);
  }
  return params;
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
export function buildHopFocusNode(
  node: LineageNode,
  nodeMap: Map<string, LineageNode>,
  unrelatedMap: Map<string, string[]>,
  store?: ColumnStore,
  ddlKey = 'ddl',
  neighborIndex?: NeighborIndex,
  edgeTypeMap?: Map<string, string>,
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

  const result = strip(focusNode) as Record<string, unknown>;

  // Non-bodied nodes (tables) carry no DDL body — the AI must ground structural_summary
  // sections (Upstream sources / Downstream consumers) in actual graph edges, not guesses.
  // Always emit in/out even when empty so the AI sees "zero neighbors" rather than absence.
  if (!SCRIPT_TYPES.has(node.type) && neighborIndex && edgeTypeMap) {
    const entry = neighborIndex[node.id] ?? { in: [], out: [] };
    result.in  = entry.in.map(nid  => presentNeighbor(nid, node.id, nodeMap, edgeTypeMap, true));
    result.out = entry.out.map(nid => presentNeighbor(nid, node.id, nodeMap, edgeTypeMap, false));
  }

  return result;
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
  store?: import('../../engine/columnStore').ColumnStore,
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
  const normalizedQuery = normalizeSearchQueryInput(query);
  const normalizedSchemas =
    schemas && schemas.length > 0
      ? schemas
      : (normalizedQuery.schemaHint ? [normalizedQuery.schemaHint] : undefined);

  if (normalizedQuery.query.length > REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` };
  }

  if (mode !== 'regex') {
    const validation = validateQuery(normalizedQuery.query);
    if (!validation.ok) {
      return { error: validation.error, hint: validation.hint };
    }
  }

  const effectiveQuery = normalizedQuery.query.trim();
  const appliedSchemaFilter: string[] | null = normalizedSchemas && normalizedSchemas.length > 0 ? [...normalizedSchemas] : null;
  const typeSet   = types   ? new Set<ObjectType>(types)   : undefined;
  const schemaSet = appliedSchemaFilter ? new Set<string>(normalizedSchemas!) : undefined;

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
    if (appliedSchemaFilter) {
      // Probe cross-schema to surface where the object actually lives — return schema names only,
      // not the results themselves, so the AI self-corrects its filter on the next call.
      const crossHits = searchCatalog(
        model.nodes as SearchableNode[],
        effectiveQuery,
        typeSet,
        undefined,
        10,
        mode,
      );
      const foundSchemas = crossHits.length > 0
        ? [...new Set(crossHits.map(n => n.schema))]
        : [];
      const schemaHint = foundSchemas.length > 0
        ? ` "${effectiveQuery}" exists in [${foundSchemas.join(', ')}] — retry without schema filter or use search_ddl.`
        : '';
      return {
        ...base,
        ai_hint: `0 results in schemas [${appliedSchemaFilter.join(', ')}].${schemaHint}`,
      };
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
  store?: import('../../engine/columnStore').ColumnStore,
): object {
  // AI may send bracket-qualified or mixed-case names; normalize to the
  // canonical [schema].[name] lowercase form used by the model's node map.
  const normalizedId = normalizeName(id);
  const nodeMap   = buildNodeMap(model);
  const node      = nodeMap.get(normalizedId);
  if (!node) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }

  const neighbors = model.neighborIndex[normalizedId] ?? { in: [], out: [] };
  const edgeMap   = buildEdgeTypeMap(model);

  const upRaw  = neighbors.in;
  const dnRaw  = neighbors.out;
  const up     = upRaw.slice(0, NEIGHBOR_CAP).map(nid => presentNeighbor(nid, normalizedId, nodeMap, edgeMap, true));
  const dn     = dnRaw.slice(0, NEIGHBOR_CAP).map(nid => presentNeighbor(nid, normalizedId, nodeMap, edgeMap, false));
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

/**
 * Retrieves a bounded BFS scope in one call, optionally including all DDL.
 *
 * @remarks
 * Discovery graph-scope helper: returns the scope as a bundle so the AI can
 * answer multi-object lineage asks without chaining per-node detail calls.
 * When `include_ddl` is true, the discovery scope budget guard is enforced
 * before materializing the payload.
 */
export function getScopeBundle(
  model: DatabaseModel,
  graph: Graph,
  input: GetScopeBundleInput,
  store?: import('../../engine/columnStore').ColumnStore,
): object {
  const nodeMap = buildNodeMap(model);
  const edgeMap = buildEdgeTypeMap(model);
  const origin = normalizeName(input.origin);
  const originNode = nodeMap.get(origin);
  if (!originNode) {
    return { error: 'not_found' as const, origin: input.origin, hint: 'Call lineage_search_objects to resolve the canonical origin ID.' };
  }

  const direction = input.direction ?? 'bidirectional';
  const includeDdl = input.include_ddl ?? false;
  const defaultDepth = input.depth ?? 2;
  const resolveDepth = (val: number | 'all' | null | undefined, def: number) => {
    if (val === 'all') return 9999;
    return val ?? def;
  };
  const upstreamDepth = direction === 'bidirectional' ? resolveDepth(input.upstream_depth, defaultDepth) : undefined;
  const downstreamDepth = direction === 'bidirectional' ? resolveDepth(input.downstream_depth, defaultDepth) : undefined;
  const singleDepth = input.depth ?? 2;

  const scopeIds = new Set<string>([origin]);
  const walkWithCap = (mode: 'inbound' | 'outbound' | 'directed', maxDepth: number): void => {
    if (maxDepth <= 0) return;
    bfsFromNode(graph, origin, (key, _attr, depth) => {
      if (depth > maxDepth) return true;
      scopeIds.add(String(key).toLowerCase());
      return false;
    }, { mode });
  };

  if (direction === 'upstream') {
    walkWithCap('inbound', singleDepth);
  } else if (direction === 'downstream') {
    walkWithCap('outbound', singleDepth);
  } else {
    walkWithCap('inbound', upstreamDepth ?? defaultDepth);
    walkWithCap('outbound', downstreamDepth ?? defaultDepth);
  }

  let ddlChars = 0;
  if (includeDdl) {
    for (const id of scopeIds) {
      const ddl = getNodeDdl(id, nodeMap, store);
      if (ddl) ddlChars += ddl.length;
    }
    const budget = checkScopeBudget(scopeIds.size, ddlChars);
    if (!budget.ok) {
      return budget;
    }
  }

  const edges = model.edges
    .filter(e => scopeIds.has(e.source) && scopeIds.has(e.target))
    .map(e => [e.source, e.target, edgeApiType(e.type)] as [string, string, string]);

  const nodes = [...scopeIds]
    .map(id => nodeMap.get(id))
    .filter((n): n is LineageNode => !!n)
    .map(n => {
      const base = presentNode(n, model.neighborIndex);
      const payload: Record<string, unknown> = { ...base };
      if (includeDdl && SCRIPT_TYPES.has(n.type)) {
        payload.ddl = getNodeDdl(n.id, nodeMap, store) ?? null;
      } else if (includeDdl) {
        const cols = getNodeColumns(n.id, nodeMap, store);
        if (cols?.length) payload.cols = cols.map(c => presentColumn(c));
      }
      return strip(payload);
    });

  return {
    origin: originNode.id,
    direction,
    depth: direction === 'bidirectional' ? undefined : singleDepth,
    upstream_depth: direction === 'bidirectional' ? (upstreamDepth ?? null) : undefined,
    downstream_depth: direction === 'bidirectional' ? (downstreamDepth ?? null) : undefined,
    include_ddl: includeDdl,
    scope: {
      nodes: nodes.length,
      edges: edges.length,
      estimated_ddl_chars: ddlChars,
      estimated_ddl_tokens: includeDdl ? estimateTokens(ddlChars) : 0,
    },
    nodes,
    edges,
  };
}


/**
 * Returns structural metadata (columns + foreign keys) for one or more neighbor nodes.
 *
 * @remarks
 * SM ACTIVE pruning-verification affordance. When a focus procedure's DDL uses a
 * wildcard reference (e.g. `SELECT * FROM dbo.FactSales`), the AI cannot see the
 * neighbor's columns from the focus body alone; this tool lets it inspect them
 * to decide whether the neighbor carries mission-relevant data (prune vs. keep).
 *
 * **Scope:** structural metadata only — columns with type/nullability, foreign-key
 * definitions. Deliberately does **not** return DDL bodies; DDL is reserved for
 * DISCOVERY (`get_object_detail`) and SYNTHESIS (`get_object_detail`) phases. In
 * SM hop-by-hop the only DDL the AI sees is the focus node's `bb_ddl`, delivered
 * by `buildHopFocusNode`.
 *
 * **Engine-side validation (caller's responsibility):** ids must be direct
 * neighbors of the current focus node AND within the active BFS scope. See
 * `NavigationEngine.validateNeighborIds`.
 *
 * @param model - Loaded database model.
 * @param ids - Node ids to inspect (pre-validated by the engine).
 * @param store - Optional column store for high-fidelity column data.
 * @returns `{ results: [...], total }` — one row per input id, columns and FKs only.
 */
export function getNeighborColumns(
  model: DatabaseModel,
  ids: string[],
  store?: ColumnStore,
): object {
  const nodeMap = buildNodeMap(model);
  const results = ids.map(id => {
    const node = nodeMap.get(id);
    if (!node) {
      return { id, error: 'not_found' as const };
    }
    const cols = getNodeColumns(id, nodeMap, store);
    const foreignKeys = node.fks?.map(fk => ({
      name:        fk.name,
      columns:     fk.columns,
      ref_schema:  fk.refSchema,
      ref_table:   fk.refTable,
      ref_columns: fk.refColumns,
      on_delete:   fk.onDelete,
    }));
    return strip({
      id:           node.id,
      schema:       node.schema,
      name:         node.name,
      type:         node.type,
      columns:      cols?.length ? cols.map(c => presentColumn(c)) : undefined,
      foreign_keys: foreignKeys?.length ? foreignKeys : undefined,
    } as Record<string, unknown>);
  });
  return { results, total: results.length };
}

/**
 * Object types whose body is the source of lineage information — view / procedure / function.
 *
 * @remarks
 * Drives DDL-vs-columns selection in {@link buildHopFocusNode} and search-target
 * filtering in {@link searchDdl}. Tables and external references are intentionally
 * excluded — they expose columns + foreign keys, not bodies.
 */
export const SCRIPT_TYPES: Set<ObjectType> = new Set(['view', 'procedure', 'function']);

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
  store?: import('../../engine/columnStore').ColumnStore,
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
