/** AI tool pure functions — zero VS Code imports. Retrieval functions invoked through the shared tool registry. CT and BB lifecycle tools are handled by `NavigationEngine` through `toolProvider.ts`. */
import { bfsFromNode } from 'graphology-traversal';
import type Graph from 'graphology';
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type LineageNode,
  type ObjectType,
  type AnalysisType,
  type NeighborIndex,
} from '../../engine/types';
import { resolveModelNodeId } from '../support/modelReferences';
import { schemaKey } from '../../utils/sql';
import { runAnalysis as runGraphAnalysis } from '../../engine/graphAnalysis';
import { ColumnStore } from '../../engine/columnStore';
import { applyIsolationFilter } from '../../engine/shared/modelFilters';
import { searchCatalog, searchColumns, compileSearchRegex, regexRejectHint, SEARCH_LINE_MAX_CHARS, type SearchableNode } from '../../utils/modelSearch';
import { executeIsolatedRegexSearch, RegexSearchExecutionError } from '../support/isolatedRegexSearch';
import type { SerializedFilterState } from '../../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentColumnCompact, presentFkCompact,
  presentSchema, presentNeighbor, presentFilter, presentForeignKeys,
} from '../support/aiPresenter';
import { type GetScopeBundleInput } from './toolSchemas';
import { ASYMMETRIC_DEPTH_BOTH_ZERO } from '../../engine/shared/explorationDepthContract';


import {
  checkScopeBudget,
  estimateTokens,
  REGEX_MAX_LENGTH,
  type DiscoveryBudgetRejection,
  type TurnTokenBudget,
} from '../support/tokenBudget';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';
import { getNodeColumns, getNodeDdl, SCRIPT_TYPES } from '../support/graphUtils';
import { getModelNodeMap } from './handlers/toolServices';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { cursorOffset, nextCursor } from '../support/text';

/** Column-match rows one `lineage_search_objects` page carries; the rest is read with `cursor`. */
const COLUMN_SEARCH_PAGE = 50;

/** Builds an id→type lookup for {@link edgeApiType}'s `sourceNodeType` argument. */
function buildNodeTypeById(model: DatabaseModel): Map<string, string> {
  return new Map(model.nodes.map(n => [n.id, n.type]));
}

/** Builds a lookup map for edges between nodes. */
export function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const nodeTypeById = buildNodeTypeById(model);
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e.type, nodeTypeById.get(e.source) ?? ''));
  }
  return m;
}

/** {@link buildEdgeTypeMap} per loaded model instance; a newly loaded model is a new key. */
const edgeTypeMapCache = new WeakMap<DatabaseModel, Map<string, string>>();

/** Returns the memoized edge-type map for `model`, building it once per model instance. */
function getModelEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  let map = edgeTypeMapCache.get(model);
  if (!map) {
    map = buildEdgeTypeMap(model);
    edgeTypeMapCache.set(model, map);
  }
  return map;
}


/** Builds a source-aware map of "Schema.Name" to lists of unresolved (unrelated) references. */
export function buildUnrelatedMap(model: DatabaseModel): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!model.parseStats?.spDetails) return m;
  for (const d of model.parseStats.spDetails) {
    if (d.unrelated?.length) {
      m.set(schemaKey(d.name, model.identifierCaseSensitive), d.unrelated.map(r => r.replace(/ \(exec\)$/, '')));
    }
  }
  return m;
}




/** Constructs a detailed "Focus Node" object for use in exploration hop contexts. */
export function buildHopFocusNode(
  node: LineageNode,
  nodeMap: Map<string, LineageNode>,
  unrelatedMap: Map<string, string[]>,
  store?: ColumnStore,
  ddlKey = 'ddl',
  neighborIndex?: NeighborIndex,
  edgeTypeMap?: Map<string, string>,
  identifierCaseSensitive = false,
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
  const unrelKey = schemaKey(`${node.schema}.${node.name}`, identifierCaseSensitive);
  const unrel = unrelatedMap.get(unrelKey);
  if (unrel?.length) focusNode.unresolved_refs = unrel;

  const result = strip(focusNode) as Record<string, unknown>;

  if (!SCRIPT_TYPES.has(node.type) && neighborIndex && edgeTypeMap) {
    const entry = neighborIndex[node.id] ?? { in: [], out: [] };
    result.in  = entry.in.map(nid  => presentNeighbor(nid, node.id, nodeMap, edgeTypeMap, true));
    result.out = entry.out.map(nid => presentNeighbor(nid, node.id, nodeMap, edgeTypeMap, false));
  }

  return result;
}


/** Objects shown by the source-aware schema/type filter, then Hide Isolated. */
function countVisibleNodes(model: DatabaseModel, activeFilter: SerializedFilterState): number {
  const scoped = model.nodes.filter(n => {
    const schemaOk = !activeFilter.schemas?.length || activeFilter.schemas.some(s => schemaKey(s, model.identifierCaseSensitive) === schemaKey(n.schema, model.identifierCaseSensitive));
    const typeOk = !activeFilter.types?.length || activeFilter.types.includes(n.type);
    return schemaOk && typeOk;
  });
  const scopedIds = new Set(scoped.map(n => n.id));
  const scopedModel = {
    ...model,
    nodes: scoped,
    edges: model.edges.filter(e => scopedIds.has(e.source) && scopedIds.has(e.target)),
  };
  return applyIsolationFilter(scopedModel, activeFilter.hideIsolated ?? false).nodes.length;
}

/** Retrieves the high-level context of the current project for the AI. */
export function getContext(
  model: DatabaseModel,
  activeFilter: SerializedFilterState | null,
  projectName: string | null,
) {
  const visibleNodes = activeFilter
    ? countVisibleNodes(model, activeFilter)
    : model.nodes.length;

  return {
    project_name:  projectName,
    source_type:   model.source ?? 'dacpac',
    db_platform:   model.dbPlatform ?? null,
    ...(model.identifierCaseSensitive && { identifierCaseSensitive: true }),
    model_stats:   { nodes: model.nodes.length, edges: model.edges.length },
    schemas:       model.schemas.map(s => presentSchema(s)),
    visible_nodes: visibleNodes,
    filter:        activeFilter ? presentFilter(activeFilter) : null,
  };
}


/** The one wording for "list a whole schema", shared by both rejections that offer that repair. */
const LIST_SCHEMA_REPAIR = 'To list a whole schema, send arguments {"query": "", "schemas": ["<schema>"]}.';

/** Bare tokens that mean "match everything" in whichever wildcard idiom a caller reaches for — SQL `%`, shell/glob `*`, regex `.*` — independent of the `mode` sent alongside them. */
const WILDCARD_ALL_TOKENS = new Set(['*', '.*', '%']);

/** Validates a substring-mode search query for sanity. */
function validateQuery(query: string): ToolRejection | null {
  const trimmed = query.trim();
  if (trimmed.length < 1) {
    return makeRejection({ code: 'query_too_short', hint: `Send a name fragment — any part of an object or column name. ${LIST_SCHEMA_REPAIR}` });
  }
  if (/^["'`.*?+^$]+$/.test(trimmed)) {
    return makeRejection({ code: 'query_not_a_name', hint: `Substring mode matches the query literally, and this is punctuation only — no object name contains it. Send a real name fragment, or set mode:"regex" to use it as a pattern. ${LIST_SCHEMA_REPAIR}` });
  }
  return null;
}


/** Searches for objects in the model by name or column name. */
export async function searchObjects(
  model: DatabaseModel,
  query: string,
  types?: ObjectType[],
  schemas?: string[],
  mode: 'substring' | 'regex' = 'substring',
  activeFilter?: SerializedFilterState | null,
  cursor?: string,
  signal?: AbortSignal,
) {
  const isRegex = mode === 'regex';
  const appliedSchemaFilter = schemas?.length ? [...schemas] : null;
  const isWildcardAllQuery = (appliedSchemaFilter?.length ?? 0) > 0
    && WILDCARD_ALL_TOKENS.has(query);

  if (!isWildcardAllQuery && query.length > REGEX_MAX_LENGTH) {
    return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` });
  }

  const effectiveQuery = isWildcardAllQuery ? '' : query;
  if (isRegex && !isWildcardAllQuery) {
    const compiled = compileSearchRegex(effectiveQuery);
    if (!compiled.ok) {
      return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: regexRejectHint(effectiveQuery, compiled) });
    }
  }
  const listAllInSchemas = isWildcardAllQuery || (!isRegex && effectiveQuery.length === 0 && (appliedSchemaFilter?.length ?? 0) > 0);

  if (!isRegex && !listAllInSchemas) {
    const rejection = validateQuery(query);
    if (rejection) return rejection;
  }

  const typeSet   = types?.length ? new Set<ObjectType>(types) : undefined;
  const requestedSchemaKeys = appliedSchemaFilter ? new Set(appliedSchemaFilter.map(s => schemaKey(s, model.identifierCaseSensitive))) : undefined;
  const schemaSet = requestedSchemaKeys ? new Set(model.nodes.map(n => n.schema).filter(s => requestedSchemaKeys.has(schemaKey(s, model.identifierCaseSensitive)))) : undefined;
  const catalogNodes = schemaSet ? model.nodes.filter(n => schemaSet.has(n.schema)) : model.nodes;

  const isolatedCatalog = async (schemaFilter: Set<string> | undefined, limit: number): Promise<SearchableNode[] | ToolRejection> => {
    try {
      const reply = await executeIsolatedRegexSearch({
        kind: 'catalog', pattern: effectiveQuery,
        nodes: (schemaFilter ? model.nodes.filter(n => schemaFilter.has(n.schema)) : model.nodes).map(({ id, name, schema, type }) => ({ id, name, schema, type })),
        types: typeSet ? [...typeSet] : undefined,
        schemas: schemaFilter ? [...schemaFilter] : undefined, limit,
      }, signal);
      if (!reply.ok || reply.kind !== 'catalog') throw new Error('Search worker did not return a catalog result.');
      const hits = new Set(reply.ids);
      return model.nodes.filter(node => hits.has(node.id));
    } catch (error: unknown) {
      if (error instanceof RegexSearchExecutionError && error.reason === 'deadline') {
        return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: 'The isolated regex search did not finish before its execution deadline; no results were returned. Simplify the pattern or narrow the search filters.' });
      }
      throw error;
    }
  };
  const offset = cursorOffset(cursor);
  const regexHits = isRegex && !listAllInSchemas && offset === 0 ? await isolatedCatalog(schemaSet, Number.MAX_SAFE_INTEGER) : null;
  if (regexHits && !Array.isArray(regexHits)) return regexHits;
  const nameHits = offset > 0 ? [] : listAllInSchemas
    ? (catalogNodes as SearchableNode[]).filter(n => !typeSet || typeSet.has(n.type))
    : regexHits ?? searchCatalog(
        catalogNodes,
        effectiveQuery,
        typeSet,
        undefined,
        Number.MAX_SAFE_INTEGER,
        mode,
      );

  let columnNodes = model.nodes as SearchableNode[];
  if (schemaSet) columnNodes = columnNodes.filter(n => schemaSet.has(n.schema));
  if (typeSet && typeSet.size > 0) columnNodes = columnNodes.filter(n => typeSet.has(n.type));
  const allColumnHits = !isRegex && !listAllInSchemas
    ? searchColumns(columnNodes, effectiveQuery, Number.MAX_SAFE_INTEGER)
    : [];
  const columnHits = allColumnHits.slice(offset, offset + COLUMN_SEARCH_PAGE);
  const columnCursor = nextCursor(offset + COLUMN_SEARCH_PAGE, allColumnHits.length);
  const seenIds = new Set(nameHits.map(n => n.id));

  const nameMatchLabel: 'name' | 'schema' = listAllInSchemas ? 'schema' : 'name';
  const results = [
    ...nameHits.map(n => ({
      ...presentNode(n, model.neighborIndex),
      match: nameMatchLabel,
    })),
    ...columnHits
      .filter(h => !seenIds.has(h.node.id))
      .map(h => ({
        ...presentNode(h.node, model.neighborIndex),
        match: 'column' as const,
        matched_columns: h.snippet,
      })),
  ];

  const filterSchemaSet = activeFilter?.schemas?.length
    ? new Set(activeFilter.schemas.map(s => schemaKey(s, model.identifierCaseSensitive)))
    : null;
  const typeCounts = new Map<string, number>();
  const taggedResults = results.map(r => {
    const row = r as Record<string, unknown>;
    const type = String(row.t);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    return {
      ...r,
      in_user_filter: filterSchemaSet ? filterSchemaSet.has(schemaKey((row.s as string) ?? '', model.identifierCaseSensitive)) : true,
    };
  });
  const byType = Object.fromEntries(
    [...typeCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );

  const exactNameRows = isRegex || listAllInSchemas
    ? []
    : taggedResults.filter(r => r.match === 'name' && schemaKey(String((r as Record<string, unknown>).n), model.identifierCaseSensitive) === schemaKey(effectiveQuery, model.identifierCaseSensitive));
  const inScopeRows = exactNameRows.filter(r => r.in_user_filter);
  const resolvedIds = (inScopeRows.length > 0 ? inScopeRows : exactNameRows).map(r => String((r as Record<string, unknown>).id));

  const visibleNodeCount = activeFilter
    ? countVisibleNodes(model, activeFilter)
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
    by_type: byType,
    filter_context: filterContext,
    ...(resolvedIds.length > 0 ? { name_match: { status: resolvedIds.length === 1 ? 'unique' : 'ambiguous', ids: resolvedIds } } : {}),
    ...(columnCursor !== undefined ? { next_cursor: columnCursor } : {}),
  };

  if (taggedResults.length === 0) {
    if (appliedSchemaFilter) {
      const crossHits = isRegex && !listAllInSchemas
        ? await isolatedCatalog(undefined, 10)
        : searchCatalog(model.nodes, effectiveQuery, typeSet, undefined, 10);
      if (!Array.isArray(crossHits)) return crossHits;
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
      ai_hint: `No results for "${effectiveQuery}". Try search_ddl for DDL body matches${isRegex ? '' : ', try regex mode'}, or broaden with fewer filters.`,
    };
  }
  return base;
}


/** Neighbours per direction one `lineage_get_object_detail` page carries; the rest is read with `cursor`. */
const NEIGHBOR_PAGE = 25;

/** Corrective hint on every per-id `not_found` rejection that names an object id — points the model at the search tool instead of leaving it to guess a corrected id. */
const SEARCH_OBJECTS_HINT = 'Call lineage_search_objects to find the exact object ID.';

/** Retrieves full metadata for a specific database object, including DDL, columns, and neighbors. */
export function getObjectDetail(
  model: DatabaseModel,
  id: string,
  store?: import('../../engine/columnStore').ColumnStore,
  cursor?: string,
): object {
  const nodeMap = getModelNodeMap(model);
  const resolvedId = resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive) ?? '';
  const node      = nodeMap.get(resolvedId);
  if (!node) {
    return makeRejection({ code: REJECTION_CODES.notFound, hint: SEARCH_OBJECTS_HINT, detail: { id } });
  }

  const neighbors = model.neighborIndex[resolvedId] ?? { in: [], out: [] };
  const edgeMap   = getModelEdgeTypeMap(model);

  const upRaw  = neighbors.in;
  const dnRaw  = neighbors.out;
  const offset = cursorOffset(cursor);
  const up     = upRaw.slice(offset, offset + NEIGHBOR_PAGE).map(nid => presentNeighbor(nid, resolvedId, nodeMap, edgeMap, true));
  const dn     = dnRaw.slice(offset, offset + NEIGHBOR_PAGE).map(nid => presentNeighbor(nid, resolvedId, nodeMap, edgeMap, false));
  const upMore = Math.max(0, upRaw.length - offset - NEIGHBOR_PAGE);
  const dnMore = Math.max(0, dnRaw.length - offset - NEIGHBOR_PAGE);
  const neighborCursor = nextCursor(offset + NEIGHBOR_PAGE, Math.max(upRaw.length, dnRaw.length));

  if (offset > 0) {
    return strip({
      id: node.id,
      up: up.length > 0 ? up : undefined,
      dn: dn.length > 0 ? dn : undefined,
      up_more: upMore > 0 ? upMore : undefined,
      dn_more: dnMore > 0 ? dnMore : undefined,
      next_cursor: neighborCursor,
    });
  }

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
    next_cursor:   neighborCursor,
  });

  const ddl = getNodeDdl(node.id, nodeMap, store) ?? null;

  const unrelMap = buildUnrelatedMap(model);
  const unrelKey = schemaKey(`${node.schema}.${node.name}`, model.identifierCaseSensitive);
  const unresolved_refs = unrelMap.get(unrelKey) ?? undefined;

  return { ...base, ddl, unresolved_refs };
}

/** Retrieves a bounded BFS scope in one call, optionally including all DDL. */
export function getScopeBundle(
  model: DatabaseModel,
  graph: Graph,
  input: GetScopeBundleInput,
  budget: TurnTokenBudget,
  store?: import('../../engine/columnStore').ColumnStore,
): object {
  const nodeMap = getModelNodeMap(model);
  const origin = resolveModelNodeId(input.origin, nodeMap, model.identifierCaseSensitive) ?? '';
  const originNode = nodeMap.get(origin);
  if (!originNode) {
    return makeRejection({ code: REJECTION_CODES.notFound, hint: 'Call lineage_search_objects to resolve the canonical origin ID.', detail: { origin: input.origin } });
  }

  const direction = input.direction ?? 'bidirectional';
  const includeDdl = input.include_ddl;
  const symmetricDepth = input.depth ?? 3;
  const upstreamDepth = direction === 'bidirectional' ? (input.upstream_depth ?? symmetricDepth) : undefined;
  const downstreamDepth = direction === 'bidirectional' ? (input.downstream_depth ?? symmetricDepth) : undefined;
  const singleDepth = input.depth ?? 3;

  if (direction === 'bidirectional' && upstreamDepth === 0 && downstreamDepth === 0) {
    return makeRejection({
      code: ASYMMETRIC_DEPTH_BOTH_ZERO,
      hint: 'upstream_depth and downstream_depth are both 0, which would return only the origin node with no neighbors. Set at least one side above 0, or call lineage_get_object_detail for a single object.',
    });
  }

  const scopeIds = new Set<string>([origin]);
  const upstreamDistance = new Map<string, number>();
  const downstreamDistance = new Map<string, number>();
  let nodeBudgetExceeded = false;
  const walkWithCap = (
    mode: 'inbound' | 'outbound' | 'directed',
    depthIntent: number | 'all',
    distance?: Map<string, number>,
  ): void => {
    const maxDepth = depthIntent === 'all' ? Number.POSITIVE_INFINITY : depthIntent;
    if (maxDepth <= 0) return;
    bfsFromNode(graph, origin, (key, _attr, depth) => {
      if (nodeBudgetExceeded || depth > maxDepth) return true;
      const id = String(key);
      scopeIds.add(id);
      distance?.set(id, depth);
      if (checkScopeBudget(budget, scopeIds.size, 0)) nodeBudgetExceeded = true;
      return false;
    }, { mode });
  };

  if (direction === 'upstream') {
    walkWithCap('inbound', singleDepth, upstreamDistance);
  } else if (direction === 'downstream') {
    walkWithCap('outbound', singleDepth, downstreamDistance);
  } else {
    walkWithCap('inbound', upstreamDepth!, upstreamDistance);
    walkWithCap('outbound', downstreamDepth!, downstreamDistance);
  }

  const overBudgetScopeReply = (admission: DiscoveryBudgetRejection): ToolRejection => ({
    ...admission,
    detail: {
      ...admission.detail,
      scope_proposal: {
        origin: originNode.id,
        direction,
        depth: singleDepth,
        upstream_depth: upstreamDepth,
        downstream_depth: downstreamDepth,
      },
    },
  });

  if (nodeBudgetExceeded) {
    const admission = checkScopeBudget(budget, scopeIds.size, 0);
    if (admission) return overBudgetScopeReply(admission);
  }

  let ddlChars = 0;
  for (const id of scopeIds) {
    const ddl = getNodeDdl(id, nodeMap, store);
    if (ddl) ddlChars += ddl.length;
  }
  const ddlFits = checkScopeBudget(budget, 0, ddlChars) === null;
  if (includeDdl && !ddlFits) {
    const admission = checkScopeBudget(budget, scopeIds.size, ddlChars);
    if (admission) return overBudgetScopeReply(admission);
  }
  const effectiveIncludeDdl = includeDdl === false
    ? false
    : (includeDdl === true || ddlChars > 0) && ddlFits;

  const edges = model.edges
    .filter(e => scopeIds.has(e.source) && scopeIds.has(e.target))
    .map(e => [e.source, e.target, edgeApiType(e.type, nodeMap.get(e.source)?.type ?? '')] as [string, string, string]);

  const edgeTypeMap = getModelEdgeTypeMap(model);
  const nodes = [...scopeIds]
    .map(id => nodeMap.get(id))
    .filter((n): n is LineageNode => !!n)
    .map(n => {
      const base = presentNode(
        n,
        model.neighborIndex,
        n.id === origin ? { nodeMap, edgeTypeMap } : undefined,
      );
      const payload: Record<string, unknown> = {
        ...base,
        uh: upstreamDistance.get(n.id),
        dh: downstreamDistance.get(n.id),
      };
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


/** Returns structural metadata (columns + foreign keys) for one or more neighbor nodes. */
export function getNeighborColumns(
  model: DatabaseModel,
  ids: string[],
  store?: ColumnStore,
): object {
  const nodeMap = getModelNodeMap(model);
  const results = ids.map(id => {
    const resolvedId = resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive) ?? '';
    const node = nodeMap.get(resolvedId);
    if (!node) throw new Error('get_neighbor_columns received an id outside the model; validate ids with NavigationEngine.validateNeighborIds first');
    const cols = getNodeColumns(resolvedId, nodeMap, store);
    const foreignKeys = presentForeignKeys(node.fks);
    return {
      ...strip({
        id:           node.id,
        schema:       node.schema,
        name:         node.name,
        type:         node.type,
        foreign_keys: foreignKeys?.length ? foreignKeys : undefined,
      }),
      columns: (cols ?? []).map(c => presentColumn(c)),
    };
  });
  return { results, total: results.length };
}




/** Executes a structural graph analysis to identify hubs, islands, or longest paths. */
export function runAnalysis(
  graph: Graph,
  type: AnalysisType,
  budget: TurnTokenBudget,
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

  const groupChars = JSON.stringify(result.groups).length;
  if (checkScopeBudget(budget, 0, groupChars)) {
    const narrowByType: Partial<Record<AnalysisType, string>> = {
      hubs:    'Raise min_degree',
      islands: 'Lower max_size',
    };
    const narrowClause = narrowByType[type];
    const hint = narrowClause
      ? `The full group list exceeds the discovery token budget and was not inlined. ${narrowClause}, pick a narrower pattern type, or inspect individual objects with lineage_get_object_detail.`
      : 'The full group list exceeds the discovery token budget and was not inlined. Pick a narrower pattern type, or inspect individual objects with lineage_get_object_detail.';
    return {
      type:            result.type,
      summary:         result.summary,
      total_groups:    result.groups.length,
      groups_omitted:  true as const,
      hint,
    };
  }

  return {
    type:         result.type,
    summary:      result.summary,
    groups:       result.groups,
    total_groups: result.groups.length,
  };
}

/** Collapses line numbers to a compact ascending range list, e.g. `[4,5,6,9]` → `"4-6, 9"`. */
function toLineRanges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return parts.join(', ');
}

/** Serialized size of the smallest row `lineage_search_ddl` can serve — every field present, every value empty. Derived from the row shape itself, so it cannot drift from what a row costs. */
const MIN_SEARCH_DDL_ROW_CHARS = JSON.stringify({ id: '', name: '', type: '', line: 0, text: '', context: '' }).length;

/** Hint on a located long line: the row is not served as text, the DDL read shows the line whole. */
const LONG_LINE_HINT = `These lines match but are longer than ${SEARCH_LINE_MAX_CHARS} characters, so no row shows them. Read the object's DDL with lineage_get_object_detail and go to the line number; match_offset is where the match starts within the line.`;

/** Searches the DDL/source code of scriptable objects with a regular expression. */
export async function searchDdl(
  model: DatabaseModel,
  query: string,
  budget: TurnTokenBudget,
  types?: ('view' | 'procedure' | 'function')[],
  store?: import('../../engine/columnStore').ColumnStore,
  onDebug?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<object> {
  if (query.length > REGEX_MAX_LENGTH) {
    return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` });
  }

  const compiled = compileSearchRegex(query);
  if (!compiled.ok) {
    return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: regexRejectHint(query, compiled) });
  }

  const ddlTypes: ObjectType[] = types
    ? (types)
    : [...SCRIPT_TYPES];
  const typeSet = new Set<ObjectType>(ddlTypes);

  const searchableNodes: SearchableNode[] = model.nodes.map(n => ({
    ...n,
    bodyScript: store?.getDdl(n.id) ?? n.bodyScript,
  }));
  const rowAdmission = (count: number) => checkScopeBudget(budget, 0, count * MIN_SEARCH_DDL_ROW_CHARS);
  let scanned: import('../../utils/modelSearch').BodyScanResult;
  try {
    const reply = await executeIsolatedRegexSearch({
      kind: 'ddl', pattern: query, nodes: searchableNodes, types: [...typeSet], budget,
      rowChars: MIN_SEARCH_DDL_ROW_CHARS,
    }, signal);
    if (!reply.ok || reply.kind !== 'ddl') throw new Error('Search worker did not return a DDL result.');
    const nodesById = new Map(searchableNodes.map(node => [node.id, node]));
    scanned = {
      ...reply.scan,
      matches: reply.scan.matches.map(match => ({ ...match, node: nodesById.get(match.node.id)! })),
      oversized: reply.scan.oversized.map(hit => ({ ...hit, node: nodesById.get(hit.node.id)! })),
    };
  } catch (error: unknown) {
    if (error instanceof RegexSearchExecutionError && error.reason === 'deadline') {
      return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: 'The isolated regex search did not finish before its execution deadline; no results were returned. Simplify the pattern or narrow the search filters.' });
    }
    throw error;
  }

  const bodies = searchableNodes.filter(n => n.bodyScript && typeSet.has(n.type)).length;
  const cutLineCount = scanned.oversized.reduce((sum, t) => sum + t.lines.length, 0);
  if (cutLineCount > 0) {
    onDebug?.(`searchDdl: ${cutLineCount} matching lines in ${scanned.oversized.length} objects exceed ${SEARCH_LINE_MAX_CHARS} characters — located in searched.long_lines, pattern="${query}"`);
  }
  const searchedListing = {
    bodies,
    types: ddlTypes,
    ...(cutLineCount > 0
      ? {
        long_lines: {
          max_chars: SEARCH_LINE_MAX_CHARS,
          objects:   scanned.oversized.map(t => ({ id: t.node.id, lines: t.lines })),
          hint:      LONG_LINE_HINT,
        },
      }
      : {}),
  };
  const searchedCounted = {
    bodies,
    types: ddlTypes,
    long_lines: {
      max_chars:       SEARCH_LINE_MAX_CHARS,
      object_count:    scanned.oversized.length,
      line_count:      cutLineCount,
      objects_omitted: true as const,
      hint: 'The objects with long matching lines exceed the discovery token budget and were not listed. Restrict types[] to list them.',
    },
  };
  const fitsBudget = (reply: object) => checkScopeBudget(budget, 0, JSON.stringify(reply).length) === null;
  const withSearched = <T extends object>(build: (searched: typeof searchedListing | typeof searchedCounted) => T): T => {
    const listed = build(searchedListing);
    if (cutLineCount === 0 || fitsBudget(listed)) return listed;
    onDebug?.(`searchDdl: the ${scanned.oversized.length} objects with long matching lines exceed the discovery token budget — stated as counts, pattern="${query}"`);
    return build(searchedCounted);
  };

  const overBudget = (
    admission: DiscoveryBudgetRejection,
    total: number,
    objects: number,
  ) => withSearched(searched => ({
    reason:          admission.reason,
    counts:          admission.detail.counts,
    limits:          admission.detail.limits,
    total,
    objects,
    searched,
    results_omitted: true as const,
    hint: 'The matches exceed the discovery token budget and were not inlined. Narrow the pattern, restrict types[], or explore the objects with lineage_start_exploration.',
  }));

  const countAdmission = rowAdmission(scanned.total);
  if (countAdmission) {
    onDebug?.(`searchDdl: ${scanned.total} matches in ${scanned.objects} objects exceed the discovery token budget before every row is built — matches omitted, pattern="${query}"`);
    return overBudget(countAdmission, scanned.total, scanned.objects);
  }
  const matches = scanned.matches;

  const results = matches.map(m => ({
    id:      m.node.id,
    name:    m.node.name,
    type:    m.node.type,
    line:    m.line,
    text:    m.text,
    context: m.snippet,
    ...(m.commented ? { commented: true as const } : {}),
    ...(m.enclosingPredicate ? { enclosing_predicate: m.enclosingPredicate } : {}),
  }));

  if (results.length === 0) return withSearched(searched => ({ results, total: 0, objects: 0, searched }));

  const hitsByObject = new Map<string, { id: string; name: string; type: string; hits: number; commentedLines: number[] }>();
  for (const m of matches) {
    let group = hitsByObject.get(m.node.id);
    if (!group) {
      group = { id: m.node.id, name: m.node.name, type: m.node.type, hits: 0, commentedLines: [] };
      hitsByObject.set(m.node.id, group);
    }
    group.hits++;
    if (m.commented) group.commentedLines.push(m.line);
  }
  const byObject = [...hitsByObject.values()].map(g => ({
    id: g.id, name: g.name, type: g.type, hits: g.hits,
    ...(g.commentedLines.length
      ? { commented_hits: g.commentedLines.length, commented_lines: toLineRanges(g.commentedLines) }
      : {}),
  }));
  const objects = byObject.length;

  const payload = withSearched(searched => ({
    results,
    total: results.length,
    objects,
    by_object: byObject,
    searched,
  }));
  const resultChars = JSON.stringify(payload).length;
  const admission = checkScopeBudget(budget, 0, resultChars);
  if (admission) {
    onDebug?.(`searchDdl: ${results.length} matches in ${objects} objects exceed the discovery token budget (${estimateTokens(resultChars)} > ${admission.detail.limits.token_budget} tokens) — matches omitted, pattern="${query}"`);
    return overBudget(admission, results.length, objects);
  }
  return payload;
}
