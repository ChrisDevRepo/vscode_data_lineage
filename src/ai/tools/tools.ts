/**
 * AI tool pure functions — zero VS Code imports.
 * Retrieval functions invoked through the shared tool registry.
 * CT and BB lifecycle tools are handled by `NavigationEngine` through `toolProvider.ts`.
 *
 * This file owns RETRIEVAL ONLY. Payload formatting lives in aiPresenter.ts; input normalization in
 * inputNormalization.ts.
 */
import { bfsFromNode } from 'graphology-traversal';
import type Graph from 'graphology';
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type LineageNode,
  type ObjectType,
  type AnalysisType,
} from '../../engine/types';
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { schemaKey } from '../../utils/sql';
import { sanitizeForLog } from '../../utils/log';
import { runAnalysis as runGraphAnalysis } from '../../engine/graphAnalysis';
import { ColumnStore } from '../../engine/columnStore';
import { countVisibleNodes, userFilterAdmits, visibleModel } from '../../engine/shared/modelFilters';
import { computeShortestPath, resolveBfsGraph, traceNodeWithLevels } from '../../engine/shared/lineageTrace';
import { TRACE_ALL_LEVELS } from '../../engine/shared/bridgeContract';
import { searchCatalog, searchColumns, compileSearchRegex, regexRejectHint, SEARCH_LINE_MAX_CHARS, type SearchableNode } from '../../utils/modelSearch';
import { executeIsolatedRegexSearch, RegexSearchExecutionError } from '../support/isolatedRegexSearch';
import { normalizeSearchQueryInput } from '../support/inputNormalization';
import type { SerializedFilterState } from '../../engine/projectStore';
import {
  strip, edgeApiType,
  presentNode, presentColumn, presentColumnCompact, presentFkCompact,
  presentSchema, presentNeighbor, presentFilter, presentForeignKeys,
} from '../support/aiPresenter';
import { type GetPathInput, type GetScopeBundleInput, type GetTraceInput } from './toolSchemas';


import {
  checkScopeBudget,
  estimateTokens,
  REGEX_MAX_LENGTH,
  type DiscoveryBudgetRejection,
  type TurnTokenBudget,
} from '../support/tokenBudget';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';
import { buildBareGraph, getNodeColumns, getNodeDdl, SCRIPT_TYPES } from '../support/graphUtils';
import { getModelNodeMap } from './handlers/toolServices';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { cursorOffset, nextCursor } from '../support/text';

/** Column-match rows one `lineage_search_objects` page carries; the rest is read with `cursor`. */
const COLUMN_SEARCH_PAGE = 50;

/** Builds an id→type lookup for {@link edgeApiType}'s `sourceNodeType` argument. */
function buildNodeTypeById(model: DatabaseModel): Map<string, string> {
  return new Map(model.nodes.map(n => [n.id, n.type]));
}

/**
 * Builds a lookup map for edges between nodes.
 *
 * @param model - The full database model.
 * @returns A map where the key is "sourceId→targetId" and the value is the API-compatible edge
 *   type.
 */
function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const nodeTypeById = buildNodeTypeById(model);
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e, nodeTypeById.get(e.source) ?? ''));
  }
  return m;
}

/** {@link buildEdgeTypeMap} per loaded model instance; a newly loaded model is a new key. */
const edgeTypeMapCache = new WeakMap<DatabaseModel, Map<string, string>>();

function getModelEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  let map = edgeTypeMapCache.get(model);
  if (!map) {
    map = buildEdgeTypeMap(model);
    edgeTypeMapCache.set(model, map);
  }
  return map;
}


/**
 * Source-aware map of "Schema.Name" to unresolved references: identifiers found in the DDL during
 * parsing that do not exist in the model, so the AI can see potential external dependencies or
 * missing objects.
 */
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




/**
 * Constructs the "Focus Node" object for exploration hop contexts: the node's metadata (DDL,
 * columns, foreign keys, unresolved references) in a shape the agent analyzes during a hop.
 *
 * @param store - Optional high-fidelity column store.
 * @param ddlKey - Key for the DDL property (defaults to 'ddl').
 * @param identifierCaseSensitive - Checked source policy shared with the unresolved-reference map.
 */
export function buildHopFocusNode(
  node: LineageNode,
  nodeMap: Map<string, LineageNode>,
  unrelatedMap: Map<string, string[]>,
  store?: ColumnStore,
  ddlKey = 'ddl',
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

  return strip(focusNode) as Record<string, unknown>;
}

/**
 * High-level project context for the AI: orientation only (schema list, node/edge stats, active UI
 * filter). The object catalog is `lineage_search_objects`' or `lineage_get_scope_bundle`'s job;
 * inlining it here duplicated those tools rather than orienting toward them, so no per-node list is
 * returned.
 */
export function getContext(
  model: DatabaseModel,
  activeFilter: SerializedFilterState | null,
  projectName: string | null,
) {
  const visibleNodes = countVisibleNodes(model, activeFilter);

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


/**
 * The one wording for "list a whole schema", shared by both rejections that offer that repair. The
 * repair is the arguments object alone, with no value left to infer and no wrong value named, since
 * naming a forbidden reading makes it the most salient token in the hint.
 */
const LIST_SCHEMA_REPAIR = 'To list a whole schema, send arguments {"query": "", "schemas": ["<schema>"]}.';

/**
 * Bare tokens meaning "match everything" in any wildcard idiom (SQL `%`, glob `*`, regex `.*`),
 * independent of `mode`. Recognized only with an explicit `schemas[]` scope, where "list everything
 * in this schema" is the one available meaning (the precondition `listAllInSchemas` uses for an
 * empty query). Without a schema scope "everything" is unbounded and the token fails like any
 * invalid pattern (`invalid_regex` in regex mode, `query_not_a_name` in substring mode).
 */
const WILDCARD_ALL_TOKENS = new Set(['*', '.*', '%']);

/**
 * Validates a substring-mode search query. The query is matched literally, so one of only regex
 * punctuation matches nothing (the second rejection); "matches everything" is true only of a
 * regex-mode pattern. Length is not limited: one character is a servable substring and volume is
 * owned by the evidence-share measurement that answers an oversized result with `result_too_large`.
 * Punctuation-only queries land on `query_not_a_name`, which names the mode that serves them.
 *
 * @returns `null` for a usable query; otherwise the rejection naming the fix.
 */
function validateQuery(query: string): ToolRejection | null {
  const trimmed = query.trim();
  if (trimmed.length < 1) {
    return makeRejection({ code: REJECTION_CODES.queryTooShort, hint: `Send a name fragment — any part of an object or column name. ${LIST_SCHEMA_REPAIR}` });
  }
  if (/^["'`.*?+^$]+$/.test(trimmed)) {
    return makeRejection({ code: REJECTION_CODES.queryNotAName, hint: `Substring mode matches the query literally, and this is punctuation only — no object name contains it. Send a real name fragment, or set mode:"regex" to use it as a pattern. ${LIST_SCHEMA_REPAIR}` });
  }
  return null;
}


/**
 * Searches objects by name or column name, fuzzy or regex. A schema-restricted search with no
 * results is retried globally.
 *
 * `by_type` is the one home of the type breakdown: the rows `total` counts, tallied on the pass
 * that tags them, so a per-heading number served here cannot drift from the list it heads.
 * `name_match` resolves a typed object name: rows whose name equals the query, narrowed to the
 * user's filtered scope when any sits in it, as `unique` or `ambiguous` with ids; absent for regex,
 * list-all and substring-only hits. `filter_context` is served only when the user filter hides
 * an object.
 *
 * @param offeredTools - The tools the current stage serves (`getAllowedLmToolNames`); a hint names
 *   only these.
 * @param activeFilter - Current UI filter state to tag results.
 * @param onDebug - Optional debug sink; logs a `[Normalize]` line when `normalizeSearchQueryInput`
 *   rewrites the query (e.g. `[dbo].[FactSales]` into schema `dbo` and name `FactSales`).
 * @returns Matches with metadata, the `by_type` breakdown and AI hints.
 */
export async function searchObjects(
  model: DatabaseModel,
  offeredTools: ReadonlySet<string>,
  query: string,
  types?: ObjectType[],
  schemas?: string[],
  mode: 'substring' | 'regex' = 'substring',
  activeFilter?: SerializedFilterState | null,
  onDebug?: (msg: string) => void,
  cursor?: string,
  signal?: AbortSignal,
) {
  const isRegex = mode === 'regex';
  const normalizedQuery = isRegex
    ? { query, schemaHint: undefined }
    : normalizeSearchQueryInput(query, { nodeMap: getModelNodeMap(model), schemas: [...new Set(model.nodes.map(n => n.schema))], identifierCaseSensitive: model.identifierCaseSensitive });
  if (normalizedQuery.schemaHint || normalizedQuery.query !== query.trim()) {
    onDebug?.(`[Normalize] tool=search_objects field=query from=${JSON.stringify(query)} to=${JSON.stringify(normalizedQuery.query)}${normalizedQuery.schemaHint ? ` schema_hint=${JSON.stringify(normalizedQuery.schemaHint)}` : ''}`);
  }
  const normalizedSchemas =
    schemas && schemas.length > 0
      ? schemas
      : (normalizedQuery.schemaHint ? [normalizedQuery.schemaHint] : undefined);
  const appliedSchemaFilter: string[] | null = normalizedSchemas && normalizedSchemas.length > 0 ? [...normalizedSchemas] : null;
  const isWildcardAllQuery = (appliedSchemaFilter?.length ?? 0) > 0
    && WILDCARD_ALL_TOKENS.has((isRegex ? query : normalizedQuery.query).trim());

  if (!isWildcardAllQuery && normalizedQuery.query.length > REGEX_MAX_LENGTH) {
    return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` });
  }

  const effectiveQuery = isWildcardAllQuery ? '' : (isRegex ? normalizedQuery.query : normalizedQuery.query.trim());
  if (isRegex && !isWildcardAllQuery) {
    const compiled = compileSearchRegex(effectiveQuery);
    if (!compiled.ok) {
      return makeRejection({ code: REJECTION_CODES.invalidRegex, hint: regexRejectHint(effectiveQuery, compiled) });
    }
  }
  const listAllInSchemas = effectiveQuery.length === 0 && (appliedSchemaFilter?.length ?? 0) > 0;

  if (!isRegex && !listAllInSchemas) {
    const rejection = validateQuery(normalizedQuery.query);
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

  const admits = activeFilter ? userFilterAdmits(model, activeFilter) : null;
  const hitIds = new Set([...nameHits, ...columnHits.map(h => h.node)].map(n => n.id));
  const hitNodes = new Map(admits ? model.nodes.filter(n => hitIds.has(n.id)).map(n => [n.id, n]) : []);
  const typeCounts = new Map<string, number>();
  const taggedResults = results.map(r => {
    const row = r as Record<string, unknown>;
    const type = String(row.t);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const node = hitNodes.get(String(row.id));
    return {
      ...r,
      in_user_filter: admits && node ? admits(node) : true,
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

  const visibleNodeCount = countVisibleNodes(model, activeFilter);
  const filterContext = visibleNodeCount < model.nodes.length ? {
    active_schemas: activeFilter?.schemas?.length ? activeFilter.schemas : null,
    active_types: activeFilter?.types?.length ? activeFilter.types : null,
    focus_schemas: activeFilter?.focusSchemas?.length ? activeFilter.focusSchemas : null,
    hide_isolated: activeFilter?.hideIsolated ?? false,
    visible_node_count: visibleNodeCount,
    total_node_count: model.nodes.length,
    all_schemas: [...new Set(model.nodes.map(n => n.schema))],
  } : null;

  const base = {
    results: taggedResults,
    total: taggedResults.length,
    by_type: byType,
    ...(filterContext ? { filter_context: filterContext } : {}),
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
        ? ` "${effectiveQuery}" exists in [${foundSchemas.join(', ')}] — retry without schema filter${offeredTools.has('lineage_search_ddl') ? ' or use search_ddl' : ''}.`
        : '';
      return {
        ...base,
        ai_hint: `0 results in schemas [${appliedSchemaFilter.join(', ')}].${schemaHint}`,
      };
    }
    const options = [
      ...(offeredTools.has('lineage_search_ddl') ? ['try search_ddl for DDL body matches'] : []),
      ...(isRegex ? [] : ['try regex mode']),
      'broaden with fewer filters',
    ];
    const advice = options.length > 1 ? `${options.slice(0, -1).join(', ')}, or ${options[options.length - 1]}` : options[0];
    return {
      ...base,
      ai_hint: `No results for "${effectiveQuery}". ${advice[0].toUpperCase()}${advice.slice(1)}.`,
    };
  }
  return base;
}


/** Neighbours per direction one `lineage_get_object_detail` page carries; the rest via `cursor`. */
const NEIGHBOR_PAGE = 25;

/**
 * Corrective hint on every per-id `not_found` rejection that names an object id — points the model
 * at the search tool instead of leaving it to guess a corrected id.
 */
const SEARCH_OBJECTS_HINT = 'Call lineage_search_objects to find the exact object ID.';

/**
 * Full metadata for one object (DDL, columns, neighbors): the primary drill-down tool. Upstream and
 * downstream neighbors are paged with `cursor`; DDL and column lists always arrive in full on the
 * first page.
 *
 * @param cursor - Neighbour page cursor from a previous call.
 * @param onDebug - Optional debug sink; logs a `[Normalize]` line when `id` resolves to a different
 *   canonical spelling.
 * @returns The object representation or a "not_found" error.
 */
export function getObjectDetail(
  model: DatabaseModel,
  id: string,
  store?: import('../../engine/columnStore').ColumnStore,
  cursor?: string,
  onDebug?: (msg: string) => void,
): object {
  const nodeMap = getModelNodeMap(model);
  const normalizedId = resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive) ?? '';
  if (normalizedId && normalizedId !== id) {
    onDebug?.(`[Normalize] tool=get_object_detail field=id from=${sanitizeForLog(id)} to=${sanitizeForLog(normalizedId)}`);
  }
  const node      = nodeMap.get(normalizedId);
  if (!node) {
    return makeRejection({ code: REJECTION_CODES.notFound, hint: SEARCH_OBJECTS_HINT, detail: { id } });
  }

  const neighbors = model.neighborIndex[normalizedId] ?? { in: [], out: [] };
  const edgeMap   = getModelEdgeTypeMap(model);

  const upRaw  = neighbors.in;
  const dnRaw  = neighbors.out;
  const offset = cursorOffset(cursor);
  const up     = upRaw.slice(offset, offset + NEIGHBOR_PAGE).map(nid => presentNeighbor(nid, normalizedId, nodeMap, edgeMap, true));
  const dn     = dnRaw.slice(offset, offset + NEIGHBOR_PAGE).map(nid => presentNeighbor(nid, normalizedId, nodeMap, edgeMap, false));
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

/**
 * A bounded BFS scope in one call, optionally with all DDL, so the AI can answer multi-object
 * lineage asks without chaining per-node detail calls. With `include_ddl` the discovery scope
 * budget guard is enforced before the payload is materialized. An omitted `include_ddl` attaches
 * the bodies only when they fit; otherwise the reply carries `ddl_withheld: 'over_budget'`, the
 * only signal that bodies exist but were held back, so the deeper analysis can be offered.
 *
 * @param budget - The calling turn's budget the discovery guard is measured against.
 * @param onDebug - Optional debug sink; logs a `[Normalize]` line when `origin` resolves to a
 *   different canonical spelling.
 */
export function getScopeBundle(
  model: DatabaseModel,
  graph: Graph,
  input: GetScopeBundleInput,
  budget: TurnTokenBudget,
  store?: import('../../engine/columnStore').ColumnStore,
  onDebug?: (msg: string) => void,
): object {
  const nodeMap = getModelNodeMap(model);
  const origin = resolveModelNodeId(input.origin, nodeMap, model.identifierCaseSensitive) ?? '';
  if (origin && origin !== input.origin) {
    onDebug?.(`[Normalize] tool=get_scope_bundle field=origin from=${sanitizeForLog(input.origin)} to=${sanitizeForLog(origin)}`);
  }
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
      code: REJECTION_CODES.asymmetricDepthBothZero,
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
    .map(e => [e.source, e.target, edgeApiType(e, nodeMap.get(e.source)?.type ?? '')] as [string, string, string]);

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
    ...(includeDdl === undefined && ddlChars > 0 && !ddlFits ? { ddl_withheld: 'over_budget' as const } : {}),
    scope: {
      nodes: nodes.length,
      edges: edges.length,
      estimated_ddl_chars: ddlChars,
      estimated_ddl_tokens: estimateTokens(ddlChars),
    },
    nodes,
    edges,
  };
}


/** `[source, target, type]` of each graph edge, typed as the other tools type them. */
function edgeRows(model: DatabaseModel, graph: Graph, edgeIds: Iterable<string>): Array<[string, string, string]> {
  const types = getModelEdgeTypeMap(model);
  return [...edgeIds].map(edge => {
    const [source, target] = [graph.source(edge), graph.target(edge)];
    return [source, target, types.get(`${source}→${target}`)!];
  });
}

/** The model a trace or path walks: every edge, or without the write, delete and exec edges. */
function walkedModel(model: DatabaseModel, includeDml: boolean): DatabaseModel {
  if (includeDml) return model;
  const types = getModelEdgeTypeMap(model);
  return { ...model, edges: model.edges.filter(e => types.get(`${e.source}→${e.target}`) === 'read') };
}

/** One object row of the graph tools, marked in or out of the user filter. */
function graphNodeRows(model: DatabaseModel, activeFilter: SerializedFilterState | null, ids: Iterable<string>, levels?: (id: string) => object) {
  const nodeMap = getModelNodeMap(model);
  const admits = activeFilter ? userFilterAdmits(model, activeFilter) : null;
  return [...ids].map(id => {
    const node = nodeMap.get(id)!;
    return { ...presentNode(node, model.neighborIndex), ...levels?.(id), in_user_filter: admits ? admits(node) : true };
  });
}

/** Canonical ids of `raw`, or the `not_found` rejection naming the ids the model does not hold. */
function resolveGraphIds(model: DatabaseModel, raw: readonly string[]): string[] | ToolRejection {
  const nodeMap = getModelNodeMap(model);
  const resolved = raw.map(id => resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive));
  const unknown = raw.filter((_, index) => !resolved[index]);
  if (unknown.length > 0) return makeRejection({ code: REJECTION_CODES.notFound, hint: SEARCH_OBJECTS_HINT, detail: { ids: unknown } });
  return resolved as string[];
}

/**
 * The graph view's trace by level (`traceNodeWithLevels`) on its inputs: the user-filtered graph,
 * or the full model when the origin is filtered out (`resolveBfsGraph`). Each node carries the
 * level it was reached at upstream (`up`) and downstream (`down`); the origin is 0 on each side
 * walked.
 */
export function getTrace(model: DatabaseModel, activeFilter: SerializedFilterState | null, input: GetTraceInput): object {
  const ids = resolveGraphIds(model, [input.origin]);
  if (!Array.isArray(ids)) return ids;
  const [origin] = ids;
  const levels = (value: number | 'all') => (value === 'all' ? TRACE_ALL_LEVELS : value);
  const filtered = buildBareGraph(walkedModel(visibleModel(model, activeFilter), input.include_dml));
  const { bfsGraph } = resolveBfsGraph(origin, false, filtered, buildBareGraph(walkedModel(model, input.include_dml)));
  const reached = { upstream: new Map<string, number>(), downstream: new Map<string, number>() };
  const { nodeIds, edgeIds } = traceNodeWithLevels(bfsGraph!, origin, levels(input.upstream_levels), levels(input.downstream_levels), (id, side, level) => reached[side].set(id, level));
  return {
    origin,
    nodes: graphNodeRows(model, activeFilter, nodeIds, id => ({ up: reached.upstream.get(id), down: reached.downstream.get(id) })),
    edges: edgeRows(model, bfsGraph!, edgeIds),
  };
}

/**
 * The graph view's Find Path (`computeShortestPath`) on the full model, as the view runs it: nodes
 * in path order, `found: false` with no nodes when neither direction connects them.
 */
export function getPath(model: DatabaseModel, activeFilter: SerializedFilterState | null, input: GetPathInput): object {
  const ids = resolveGraphIds(model, [input.start, input.end]);
  if (!Array.isArray(ids)) return ids;
  const [start, end] = ids;
  const graph = buildBareGraph(walkedModel(model, input.include_dml));
  const path = computeShortestPath(graph, start, end);
  return {
    start,
    end,
    found: path !== null,
    nodes: graphNodeRows(model, activeFilter, path?.nodeIds ?? []),
    edges: edgeRows(model, graph, path?.edgeIds ?? []),
  };
}

/** The objects a graph preview shows and every model edge between them. */
export function getGraphPreviewScope(model: DatabaseModel, activeFilter: SerializedFilterState | null, raw: readonly string[]) {
  const ids = resolveGraphIds(model, raw);
  if (!Array.isArray(ids)) return ids;
  const inScope = new Set(ids);
  const types = getModelEdgeTypeMap(model);
  return {
    nodeIds: [...inScope],
    nodes: graphNodeRows(model, activeFilter, inScope),
    edges: model.edges
      .filter(e => inScope.has(e.source) && inScope.has(e.target))
      .map(e => [e.source, e.target, types.get(`${e.source}→${e.target}`)!]),
  };
}

/**
 * Structural metadata (columns with type/nullability, foreign keys) for neighbor nodes: the SM
 * ACTIVE pruning-verification affordance, for when a focus procedure uses a wildcard reference
 * (`SELECT * FROM dbo.FactSales`) and the neighbor's columns cannot be seen from its body, so the
 * AI can decide prune vs. keep. Returns no DDL bodies: DDL is reserved for discovery and synthesis
 * (`get_object_detail`); in SM hops the only DDL seen is the focus's `bb_ddl` from
 * `buildHopFocusNode`.
 *
 * The caller validates that ids are direct neighbors of the focus within the active BFS scope
 * (`NavigationEngine.validateNeighborIds`).
 *
 * @param ids - Canonical node ids that passed `NavigationEngine.validateNeighborIds`.
 * @returns `{ results: [...], total }`, one row per id. `columns` is always present, `[]` for an
 *   object with none (a procedure), so an empty answer reads as an answer.
 * @throws When an id is not a model node (a caller that skipped engine validation).
 */
export function getNeighborColumns(
  model: DatabaseModel,
  ids: string[],
  store?: ColumnStore,
): object {
  const nodeMap = getModelNodeMap(model);
  const results = ids.map(id => {
    const node = nodeMap.get(id);
    if (!node) throw new Error('get_neighbor_columns received an id outside the model; validate ids with NavigationEngine.validateNeighborIds first');
    const cols = getNodeColumns(id, nodeMap, store);
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




/**
 * Structural graph analysis (hubs, islands, longest paths, cycles) with deterministic engine logic,
 * so the AI can reason about topology and change-risk hotspots without retrieving every node.
 *
 * @param type - Analysis to perform ('hubs', 'islands', 'longest_path', 'cycles').
 * @param budget - The calling turn's budget the discovery guard is measured against.
 * @param minDegree - Minimum degree for a hub.
 * @param maxSize - Maximum component size for an island.
 * @param longestPathMinNodes - Minimum node count for a path to count as "long".
 */
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

/**
 * Collapses line numbers to a compact ascending range list, e.g. `[4,5,6,9]` → `"4-6, 9"`.
 *
 * @param lines - The line numbers, in any order, duplicates allowed.
 * @returns The ranges as one string; only genuinely consecutive numbers are joined.
 */
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

/**
 * Serialized size of the smallest hit `lineage_search_ddl` can serve — every field present, every
 * value empty. Derived from the hit shape itself, so it cannot drift from what a hit costs; the
 * object fields are served once per object in `by_object`, not per hit.
 */
const MIN_SEARCH_DDL_HIT_CHARS = JSON.stringify({ line: 0, context: '' }).length;

/** Hint on a located long line: the row is not served as text; the DDL read shows it whole. */
const LONG_LINE_HINT = `These lines match but are longer than ${SEARCH_LINE_MAX_CHARS} characters, so no row shows them. Read the object's DDL with lineage_get_object_detail and go to the line number; match_offset is where the match starts within the line.`;

/**
 * Searches the DDL of scriptable objects with a regular expression. The contract is grep's: a
 * pattern in, every match out under its object with 1-based line number and context. Nothing
 * is sliced: an empty result is stated as a fact, an unusable pattern is an error naming the regex
 * problem, and a result too large for the discovery budget hands off to the approval path instead
 * of returning a partial list.
 *
 * A hit inside a SQL comment carries `commented: true`; one inside an `IF`/`WHILE` block carries
 * `enclosing_predicate` with the condition text. Marked, never filtered: a comment can hold the
 * answer, and the few context lines a hit ships with cannot show the block or condition more than a
 * line or two away.
 *
 * `by_object` is the one per-object home: each object with a hit, its `hits` total and, where
 * anything is dead, `commented_hits` and the commented lines as ranges, then its `matches`. Counts
 * are served, not tallied from rows, since an answer composed by theme merges rows from several
 * places. `objects` is this list's length. Each hit is served once, as its line and the context
 * holding that line (the matched line with one line either side), with its own flag; the object and
 * the matched line are not repeated per hit.
 *
 * Matching is per whole line. A match on a line longer than `SEARCH_LINE_MAX_CHARS` is not served
 * as a row but located in `searched.long_lines` (object id, line number, length, match offset, a
 * hint naming the DDL read that shows it whole) in every result shape, empty and over-budget
 * included; omitted when none is that long. Where the list would push the reply past the discovery
 * budget it is stated as counts (`object_count`, `line_count`, `objects_omitted`) with a hint.
 *
 * @param offeredTools - The tools the current stage serves (`getAllowedLmToolNames`); a hint names
 *   only these.
 * @param budget - The calling turn's budget the discovery guard is measured against.
 * @param onDebug - Optional sink for a debug line when `query` is rewritten or the result is over
 *   budget.
 * @returns Every matching line grouped under its object in `by_object`, or the
 *   empty/invalid/over-budget fact.
 */
export async function searchDdl(
  model: DatabaseModel,
  offeredTools: ReadonlySet<string>,
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

  const compiled = compileSearchRegex(query, onDebug);
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
  const hitAdmission = (count: number) => checkScopeBudget(budget, 0, count * MIN_SEARCH_DDL_HIT_CHARS);
  let scanned: import('../../utils/modelSearch').BodyScanResult;
  try {
    const reply = await executeIsolatedRegexSearch({
      kind: 'ddl', pattern: query, nodes: searchableNodes, types: [...typeSet], budget,
      rowChars: MIN_SEARCH_DDL_HIT_CHARS,
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
    hint: `The matches exceed the discovery token budget and were not inlined. ${offeredTools.has('lineage_start_exploration')
      ? 'Narrow the pattern, restrict types[], or explore the objects with lineage_start_exploration.'
      : 'Narrow the pattern or restrict types[].'}`,
  }));

  const countAdmission = hitAdmission(scanned.total);
  if (countAdmission) {
    onDebug?.(`searchDdl: ${scanned.total} matches in ${scanned.objects} objects exceed the discovery token budget before every row is built — matches omitted, pattern="${query}"`);
    return overBudget(countAdmission, scanned.total, scanned.objects);
  }
  const matches = scanned.matches;

  if (matches.length === 0) return withSearched(searched => ({ total: 0, objects: 0, searched }));

  type Hit = { line: number; context: string; commented?: true; enclosing_predicate?: string };
  const hitsByObject = new Map<string, { id: string; name: string; type: string; commentedLines: number[]; matches: Hit[] }>();
  for (const m of matches) {
    let group = hitsByObject.get(m.node.id);
    if (!group) {
      group = { id: m.node.id, name: m.node.name, type: m.node.type, commentedLines: [], matches: [] };
      hitsByObject.set(m.node.id, group);
    }
    group.matches.push({
      line:    m.line,
      context: m.snippet,
      ...(m.commented ? { commented: true as const } : {}),
      ...(m.enclosingPredicate ? { enclosing_predicate: m.enclosingPredicate } : {}),
    });
    if (m.commented) group.commentedLines.push(m.line);
  }
  const byObject = [...hitsByObject.values()].map(g => ({
    id: g.id, name: g.name, type: g.type, hits: g.matches.length,
    ...(g.commentedLines.length
      ? { commented_hits: g.commentedLines.length, commented_lines: toLineRanges(g.commentedLines) }
      : {}),
    matches: g.matches,
  }));
  const objects = byObject.length;

  const payload = withSearched(searched => ({
    total: matches.length,
    objects,
    by_object: byObject,
    searched,
  }));
  const resultChars = JSON.stringify(payload).length;
  const admission = checkScopeBudget(budget, 0, resultChars);
  if (admission) {
    onDebug?.(`searchDdl: ${matches.length} matches in ${objects} objects exceed the discovery token budget (${estimateTokens(resultChars)} > ${admission.detail.limits.token_budget} tokens) — matches omitted, pattern="${query}"`);
    return overBudget(admission, matches.length, objects);
  }
  return payload;
}
