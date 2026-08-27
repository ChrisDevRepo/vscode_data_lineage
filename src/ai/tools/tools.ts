/**
 * AI tool pure functions — zero VS Code imports.
 * Retrieval functions invoked through the shared tool registry.
 * CT and BB lifecycle tools are handled by `NavigationEngine` through `toolProvider.ts`.
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
import { normalizeBodyScript, minifyDdlForHop } from '../../utils/sql';
import { normalizeSearchQueryInput } from '../support/inputNormalization';
import type { SerializedFilterState } from '../../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentColumnCompact, presentFkCompact,
  presentSchema, presentNeighbor, presentFilter, presentForeignKeys,
} from '../support/aiPresenter';
import { type GetScopeBundleInput } from './toolSchemas';
import { ASYMMETRIC_DEPTH_BOTH_ZERO } from '../../engine/shared/explorationDepthContract';


import { estimateTokens, REGEX_MAX_LENGTH, checkScopeBudget } from '../support/tokenBudget';
// Re-exported for the discovery-budget-guard unit test, which drives the caps through this module.
export { setDiscoveryNodeCap, setDiscoveryTokenBudget } from '../support/tokenBudget';

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
 * @param neighborIndex - Optional pre-computed neighbor index to attach in/out edge metadata.
 * @param edgeTypeMap - Optional map of edge types.
 * @param preserveTechContext - If true, physical layer details are retained in the minified DDL.
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
  preserveTechContext = false,
): Record<string, unknown> {
  const focusNode: Record<string, unknown> = {
    id: node.id, s: node.schema, n: node.name, t: node.type,
  };
  const rawDdl = (typeof store?.getDdl === 'function' ? store.getDdl(node.id) : undefined) ?? nodeMap.get(node.id)?.bodyScript;
  const cols = getNodeColumns(node.id, nodeMap, store);
  if (SCRIPT_TYPES.has(node.type) && rawDdl) {
    focusNode[ddlKey] = minifyDdlForHop(rawDdl, preserveTechContext);
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
 * @param store - Optional column store.
 * @returns An object containing project metadata and potentially the full catalog.
 */
export function getContext(
  model: DatabaseModel,
  activeFilter: SerializedFilterState | null,
  projectName: string | null,
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
        enriched.fks = presentForeignKeys(n.fks);
      }
      return strip(enriched);
    }
    return base;
  });
  const edges = model.edges.map(e => [e.source, e.target, edgeApiType(e.type)]);
  const catalogChars = JSON.stringify(catalog).length + JSON.stringify(edges).length;

  const summary = {
    project_name:  projectName,
    // Read, never inferred: a dacpac carries a DSP-derived platform label just like a live
    // import, so platform presence says nothing about provenance. Falls back to the snapshot
    // answer, which understates rather than overstates what the model is connected to.
    source_type:   model.source ?? 'dacpac',
    db_platform:   model.dbPlatform ?? null,
    model_stats:   { nodes: model.nodes.length, edges: model.edges.length },
    schemas:       model.schemas.map(s => presentSchema(s)),
    visible_nodes: visibleNodes,
    filter:        activeFilter ? presentFilter(activeFilter) : null,
    _token_estimate: { catalog_chars: catalogChars, estimated_tokens: estimateTokens(catalogChars) },
  };

  // Same discovery budget guard as get_scope_bundle, token axis only (the catalog listing has no
  // per-node scope semantics). Over budget → summary WITHOUT the inlined catalog — the orientation
  // stats stay usable and the AI retrieves objects on demand; over-budget *scope* requests are
  // still the single mechanism that routes to hop-by-hop exploration.
  if (!checkScopeBudget(0, catalogChars).ok) {
    return {
      ...summary,
      model_size: 'large' as const,
      hint: 'The full catalog exceeds the discovery token budget and was not inlined. Use lineage_search_objects, lineage_get_object_detail, or lineage_get_scope_bundle for on-demand retrieval.',
    };
  }

  return {
    ...summary,
    model_size: 'small' as const,
    objects: catalog,
    edges,
  };
}


/**
 * Validates a search query for sanity.
 *
 * @param query - The user-provided search string.
 * @returns Success status or an error with a hint.
 */
function validateQuery(query: string): { ok: true } | { ok: false; error: string; hint: string } {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { ok: false, error: 'query_too_short', hint: 'Use at least 2 characters — a real name fragment like "SalesOrder" or a schema name like "ai". To list everything in a schema, send an empty query WITH schemas:["<schema>"].' };
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

  const effectiveQuery = normalizedQuery.query.trim();
  const appliedSchemaFilter: string[] | null = normalizedSchemas && normalizedSchemas.length > 0 ? [...normalizedSchemas] : null;
  // Empty query WITH an explicit schema scope is a legitimate "list everything in schema X"
  // ask — there is no name fragment to search, so enumerate the schema directly instead of
  // rejecting (query_too_short) or handing an empty string to searchCatalog (which matches
  // nothing). Case-insensitive so the model's `ai` matches a node schema stored as `ai`/`AI`.
  const listAllInSchemas = mode !== 'regex' && effectiveQuery.length === 0 && (appliedSchemaFilter?.length ?? 0) > 0;

  if (mode !== 'regex' && !listAllInSchemas) {
    const validation = validateQuery(normalizedQuery.query);
    if (!validation.ok) {
      return { error: validation.error, hint: validation.hint };
    }
  }

  const typeSet   = types?.length ? new Set<ObjectType>(types) : undefined;
  const schemaSet = appliedSchemaFilter ? new Set<string>(normalizedSchemas!) : undefined;
  const schemaSetLower = appliedSchemaFilter ? new Set(appliedSchemaFilter.map(s => s.toLowerCase())) : undefined;

  const nameHits = listAllInSchemas
    ? (model.nodes as SearchableNode[]).filter(n =>
        (!schemaSetLower || schemaSetLower.has(n.schema.toLowerCase())) &&
        (!typeSet || typeSet.has(n.type)))
    : searchCatalog(
        model.nodes as SearchableNode[],
        effectiveQuery,
        typeSet,
        schemaSet,
        Number.MAX_SAFE_INTEGER,
        mode,
      );

  // Column name search (tables/external only, always-on, respects schema/type filters).
  // Skipped for a list-all enumeration — nameHits already covers every node in the schema.
  let columnNodes = model.nodes as SearchableNode[];
  if (schemaSet && schemaSet.size > 0) columnNodes = columnNodes.filter(n => schemaSet.has(n.schema));
  if (typeSet && typeSet.size > 0) columnNodes = columnNodes.filter(n => typeSet.has(n.type));
  const columnHits = mode === 'substring' && !listAllInSchemas
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
  const foreignKeys = presentForeignKeys(node.fks) ?? null;

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
 *
 * @param model - The database model.
 * @param graph - The graphology instance.
 * @param input - The scope bundle input payload.
 * @param store - Optional column store for high-fidelity metadata.
 * @returns The requested scope bundle.
 */
export function getScopeBundle(
  model: DatabaseModel,
  graph: Graph,
  input: GetScopeBundleInput,
  store?: import('../../engine/columnStore').ColumnStore,
): object {
  const nodeMap = buildNodeMap(model);
  const origin = normalizeName(input.origin);
  const originNode = nodeMap.get(origin);
  if (!originNode) {
    return { error: 'not_found' as const, origin: input.origin, hint: 'Call lineage_search_objects to resolve the canonical origin ID.' };
  }

  const direction = input.direction ?? 'bidirectional';
  // Preserve the distinction between an omitted `include_ddl` and an explicit `false`.
  const includeDdl = input.include_ddl;
  const symmetricDepth = input.depth ?? 3;
  const upstreamDepth = direction === 'bidirectional' ? (input.upstream_depth ?? symmetricDepth) : undefined;
  const downstreamDepth = direction === 'bidirectional' ? (input.downstream_depth ?? symmetricDepth) : undefined;
  const singleDepth = input.depth ?? 3;

  // Every model-facing call now states both sides explicitly (GetScopeBundleModelSchema requires
  // upstream_depth/downstream_depth); reject the degenerate origin-only combination with a
  // field-specific reason instead of silently returning a scope with no neighbors.
  if (direction === 'bidirectional' && upstreamDepth === 0 && downstreamDepth === 0) {
    return {
      error: ASYMMETRIC_DEPTH_BOTH_ZERO,
      hint: 'upstream_depth and downstream_depth are both 0, which would return only the origin node with no neighbors. Set at least one side above 0, or call lineage_get_object_detail for a single object.',
    };
  }

  const scopeIds = new Set<string>([origin]);
  let nodeBudgetExceeded = false;
  const walkWithCap = (mode: 'inbound' | 'outbound' | 'directed', depthIntent: number | 'all'): void => {
    const maxDepth = depthIntent === 'all' ? Number.POSITIVE_INFINITY : depthIntent;
    if (maxDepth <= 0) return;
    bfsFromNode(graph, origin, (key, _attr, depth) => {
      if (nodeBudgetExceeded || depth > maxDepth) return true;
      scopeIds.add(String(key).toLowerCase());
      if (!checkScopeBudget(scopeIds.size, 0).ok) nodeBudgetExceeded = true;
      return false;
    }, { mode });
  };

  if (direction === 'upstream') {
    walkWithCap('inbound', singleDepth!);
  } else if (direction === 'downstream') {
    walkWithCap('outbound', singleDepth!);
  } else {
    walkWithCap('inbound', upstreamDepth!);
    walkWithCap('outbound', downstreamDepth!);
  }

  if (nodeBudgetExceeded) {
    return {
      ...checkScopeBudget(scopeIds.size, 0),
      scope_proposal: {
        origin: originNode.id,
        direction,
        depth: singleDepth,
        upstream_depth: upstreamDepth,
        downstream_depth: downstreamDepth,
      },
    };
  }

  // Always measure DDL so the engine can auto-attach it when it fits the budget. Edge direction and
  // role (INSERT/exec/read/filter-only) are grounded in the DDL body, not the generic stored edge
  // verbs, so grounding must not depend on the model remembering to set include_ddl.
  let ddlChars = 0;
  for (const id of scopeIds) {
    const ddl = getNodeDdl(id, nodeMap, store);
    if (ddl) ddlChars += ddl.length;
  }
  // Auto-attach DDL when it fits the token budget. If the caller explicitly asked for DDL that does
  // not fit, route to SM (their intent needs the bodies). If they did NOT ask and it does not fit,
  // fall through with metadata only — preserves the inline chat path, no forced SM.
  const ddlFits = checkScopeBudget(0, ddlChars).ok;
  if (includeDdl && !ddlFits) return checkScopeBudget(scopeIds.size, ddlChars);
  // Only an omitted value may enable automatic DDL grounding.
  const effectiveIncludeDdl = includeDdl === false
    ? false
    : (includeDdl === true || ddlChars > 0) && ddlFits;

  const edges = model.edges
    .filter(e => scopeIds.has(e.source) && scopeIds.has(e.target))
    .map(e => [e.source, e.target, edgeApiType(e.type)] as [string, string, string]);

  const nodes = [...scopeIds]
    .map(id => nodeMap.get(id))
    .filter((n): n is LineageNode => !!n)
    .map(n => {
      const base = presentNode(n, model.neighborIndex);
      const payload: Record<string, unknown> = { ...base };
      if (effectiveIncludeDdl && SCRIPT_TYPES.has(n.type)) {
        payload.ddl = getNodeDdl(n.id, nodeMap, store) ?? null;
      } else if (effectiveIncludeDdl) {
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
    include_ddl: effectiveIncludeDdl,
    scope: {
      nodes: nodes.length,
      edges: edges.length,
      estimated_ddl_chars: ddlChars,
      estimated_ddl_tokens: effectiveIncludeDdl ? estimateTokens(ddlChars) : 0,
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
    const foreignKeys = presentForeignKeys(node.fks);
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
 * Executes a structural graph analysis to identify hubs, islands, or longest paths.
 *
 * @remarks
 * This tool allows the AI to perform higher-level reasoning about the entire graph topology
 * without retrieving every node's metadata. It uses deterministic engine logic to find
 * architectural hotspots and change-risk areas.
 *
 * @param graph - The graphology instance.
 * @param type - The type of analysis to perform ('hubs', 'islands', 'longest_path', 'cycles').
 * @param minDegree - Minimum degree for a node to be considered a hub.
 * @param maxSize - Maximum size for a connected component to be considered an island.
 * @param longestPathMinNodes - Minimum number of nodes for a path to be considered "long".
 * @returns A summary of the analysis results including grouped node IDs.
 */
export function runAnalysis(
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
