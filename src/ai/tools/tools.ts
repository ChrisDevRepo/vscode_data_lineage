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
  type ObjectType,
  type AnalysisType,
  type NeighborIndex,
} from '../../engine/types';
import { normalizeName } from '../../engine/modelBuilder';
import { runAnalysis as runGraphAnalysis } from '../../engine/graphAnalysis';
import { ColumnStore } from '../../engine/columnStore';
import { searchCatalog, searchColumns, compileSearchRegex, regexRejectHint, searchBodyScripts, type SearchableNode } from '../../utils/modelSearch';
import { minifyDdlForHop } from '../../utils/sql';
import { normalizeSearchQueryInput } from '../support/inputNormalization';
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
  type TurnTokenBudget,
} from '../support/tokenBudget';
import { buildNodeMap, getNodeColumns, getNodeDdl, SCRIPT_TYPES } from '../support/graphUtils';
import { REJECTION_CODES } from '../support/rejectionCodes';

/** Hard cap on `search_columns` results — prevents unbounded enumeration on wide schemas. */
const COLUMN_SEARCH_LIMIT = 50;

/** Builds an id→type lookup for {@link edgeApiType}'s `sourceNodeType` argument. */
function buildNodeTypeById(model: DatabaseModel): Map<string, string> {
  return new Map(model.nodes.map(n => [n.id, n.type]));
}

/**
 * Builds a lookup map for edges between nodes.
 *
 * @param model - The full database model.
 * @returns A map where the key is "sourceId→targetId" and the value is the API-compatible edge type.
 */
export function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const nodeTypeById = buildNodeTypeById(model);
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e.type, nodeTypeById.get(e.source) ?? ''));
  }
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
 * Orientation only: schema list, node/edge stats, and the active UI filter. The object catalog
 * itself is `lineage_search_objects`'s job (name/column search) or `lineage_get_scope_bundle`'s
 * (graph-scope retrieval) — inlining it here duplicated that tool rather than orienting the AI
 * toward it, so this never returns the per-node list.
 *
 * @param model - The database model.
 * @param activeFilter - The current UI filter state.
 * @param projectName - The name of the active project.
 * @returns Project metadata, schema list, stats, and the active filter.
 */
export function getContext(
  model: DatabaseModel,
  activeFilter: SerializedFilterState | null,
  projectName: string | null,
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

  return {
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
  };
}


/**
 * The one wording for "list a whole schema", shared by both rejections that offer that repair.
 *
 * @remarks
 * "Send an empty query" was read as the two-character literal `""` (IB3-T2). Naming that reading in
 * order to forbid it made it the most salient token in the hint, and the next call sent exactly it:
 * the repair is therefore the arguments object and nothing else, with no value left to infer from
 * prose and no wrong value named for a reader to copy.
 */
const LIST_SCHEMA_REPAIR = 'To list a whole schema, send arguments {"query": "", "schemas": ["<schema>"]}.';

/**
 * Validates a substring-mode search query for sanity.
 *
 * @remarks
 * Only reached in substring mode, where the query is matched literally — so a query made of
 * nothing but regex punctuation matches nothing at all, which is what the second rejection says.
 * The wording used to claim the opposite ("matches everything"), which is only true of a pattern
 * in regex mode and sent the model chasing a narrower query instead of the right mode.
 *
 * Length is the other axis, and one character is a servable substring: `searchCatalog` matches it
 * like any longer one and this tool hands it no result cap, so volume is owned by the evidence-share
 * measurement that answers an oversized result with `result_too_large`, never by a minimum here. A
 * former minimum of two refused `i` and `.` with a length complaint — a repair neither caller
 * could make — and spent a run’s three semantic failures on it (IB3-T2). Punctuation-only
 * queries still land on `query_not_a_name` below, which names the mode that serves them.
 *
 * @param query - The user-provided search string.
 * @returns Success status or an error with a hint.
 */
function validateQuery(query: string): { ok: true } | { ok: false; error: string; hint: string } {
  const trimmed = query.trim();
  if (trimmed.length < 1) {
    return { ok: false, error: 'query_too_short', hint: `Send a name fragment — any part of an object or column name. ${LIST_SCHEMA_REPAIR}` };
  }
  // Quote characters sit in the class for the same reason the regex metacharacters do: matched
  // literally, no object name contains them. It is also what a caller sends after reading "an empty
  // query" as a value to type out, so the reading is named here instead of answering it with a list
  // of nothing.
  if (/^["'`.*?+^$]+$/.test(trimmed)) {
    return { ok: false, error: 'query_not_a_name', hint: `Substring mode matches the query literally, and this is punctuation only — no object name contains it. Send a real name fragment, or set mode:"regex" to use it as a pattern. ${LIST_SCHEMA_REPAIR}` };
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
 * `by_type` is the one home for the type breakdown: the same rows `total` counts, tallied on the
 * pass that tags them. A per-row `t` is read row by row, while an answer grouped by kind states one
 * number per heading — served, that number cannot drift from the list it heads.
 *
 * @param model - The database model.
 * @param query - The search query.
 * @param types - Optional filter for object types.
 * @param schemas - Optional filter for schemas.
 * @param mode - Search mode ('substring' or 'regex').
 * @param activeFilter - Current UI filter state to tag results.
 * @returns A list of matches with metadata, the `by_type` breakdown of that list, and AI hints.
 */
export function searchObjects(
  model: DatabaseModel,
  query: string,
  types?: ObjectType[],
  schemas?: string[],
  mode: 'substring' | 'regex' = 'substring',
  activeFilter?: SerializedFilterState | null,
) {
  const isRegex = mode === 'regex';
  // A regex is passed through untouched. The id normalizer splits on "." to lift a schema prefix
  // out of `[dbo].[FactSales]`, which in a pattern is the any-character metacharacter: it turned
  // `sales\..*order` into query `.*order` with schemaHint `sales\`, silently searching the wrong
  // thing. Trimming is skipped for the same reason — trailing space is part of a pattern.
  const normalizedQuery = isRegex ? { query, schemaHint: undefined } : normalizeSearchQueryInput(query);
  const normalizedSchemas =
    schemas && schemas.length > 0
      ? schemas
      : (normalizedQuery.schemaHint ? [normalizedQuery.schemaHint] : undefined);

  if (normalizedQuery.query.length > REGEX_MAX_LENGTH) {
    return { error: REJECTION_CODES.invalidRegex, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` };
  }

  const effectiveQuery = isRegex ? normalizedQuery.query : normalizedQuery.query.trim();
  // An unusable pattern is named, never answered with an empty list: `searchCatalog` swallows a
  // compile failure and returns [], which reads to the model as "no such object exists".
  if (isRegex) {
    const compiled = compileSearchRegex(effectiveQuery);
    if (!compiled.ok) {
      return { error: REJECTION_CODES.invalidRegex, hint: regexRejectHint(effectiveQuery, compiled) };
    }
  }
  const appliedSchemaFilter: string[] | null = normalizedSchemas && normalizedSchemas.length > 0 ? [...normalizedSchemas] : null;
  // Empty query WITH an explicit schema scope is a legitimate "list everything in schema X"
  // ask — there is no name fragment to search, so enumerate the schema directly instead of
  // rejecting (query_too_short) or handing an empty string to searchCatalog (which matches
  // nothing). Case-insensitive so the model's `ai` matches a node schema stored as `ai`/`AI`.
  const listAllInSchemas = !isRegex && effectiveQuery.length === 0 && (appliedSchemaFilter?.length ?? 0) > 0;

  if (!isRegex && !listAllInSchemas) {
    const validation = validateQuery(normalizedQuery.query);
    if (!validation.ok) {
      return { error: validation.error, hint: validation.hint };
    }
  }

  const typeSet   = types?.length ? new Set<ObjectType>(types) : undefined;
  const schemaSet = appliedSchemaFilter ? new Set<string>(normalizedSchemas) : undefined;
  const schemaSetLower = appliedSchemaFilter ? new Set(appliedSchemaFilter.map(s => s.toLowerCase())) : undefined;

  const nameHits = listAllInSchemas
    ? (model.nodes as SearchableNode[]).filter(n =>
        (!schemaSetLower || schemaSetLower.has(n.schema.toLowerCase())) &&
        (!typeSet || typeSet.has(n.type)))
    : searchCatalog(
        model.nodes,
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
  const columnHits = !isRegex && !listAllInSchemas
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

  // Tag each result with in_user_filter so AI knows what the user currently sees, and tally the
  // type breakdown on that same pass: `by_type` is the list `total` summarises, counted once, so
  // the two cannot disagree and no count is left to be tallied from the rows (IB3-T2: 32 rows
  // served as 19 table / 8 procedure / 5 view were delivered as "17 tables … 7 views", with only
  // the served `total` correct). One home, one pass, no second walk over the results.
  const filterSchemaSet = activeFilter?.schemas?.length
    ? new Set(activeFilter.schemas.map(s => s.toLowerCase()))
    : null;
  const typeCounts = new Map<string, number>();
  const taggedResults = results.map(r => {
    const row = r as Record<string, unknown>;
    const type = String(row.t);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    return {
      ...r,
      in_user_filter: filterSchemaSet ? filterSchemaSet.has(((row.s as string) ?? '').toLowerCase()) : true,
    };
  });
  // Bounded by the object-kind union (OBJECT_TYPES, five members), not by the result count, so the
  // breakdown costs the same on a 32-row answer as on a whole-catalog one. Largest first, so the
  // heading order an answer writes matches the order it reads.
  const byType = Object.fromEntries(
    [...typeCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );

  const visibleNodeCount = activeFilter
    ? model.nodes.filter(n => {
        const schemaOk = !activeFilter.schemas?.length || activeFilter.schemas.some(s => s.toLowerCase() === n.schema.toLowerCase());
        const typeOk = !activeFilter.types?.length || activeFilter.types.includes(n.type);
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
    by_type: byType,
    filter_context: filterContext,
  };

  if (taggedResults.length === 0) {
    if (appliedSchemaFilter) {
      // Probe cross-schema to surface where the object actually lives — return schema names only,
      // not the results themselves, so the AI self-corrects its filter on the next call.
      const crossHits = searchCatalog(
        model.nodes,
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
      ai_hint: `No results for "${effectiveQuery}". Try search_ddl for DDL body matches${isRegex ? '' : ', try regex mode'}, or broaden with fewer filters.`,
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
    return { error: REJECTION_CODES.notFound, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
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
  });

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
 * @param budget - The calling turn's budget, which the discovery guard is measured against.
 * @param store - Optional column store for high-fidelity metadata.
 * @returns The requested scope bundle.
 */
export function getScopeBundle(
  model: DatabaseModel,
  graph: Graph,
  input: GetScopeBundleInput,
  budget: TurnTokenBudget,
  store?: import('../../engine/columnStore').ColumnStore,
): object {
  const nodeMap = buildNodeMap(model);
  const origin = normalizeName(input.origin);
  const originNode = nodeMap.get(origin);
  if (!originNode) {
    return { error: REJECTION_CODES.notFound, origin: input.origin, hint: 'Call lineage_search_objects to resolve the canonical origin ID.' };
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
      if (!checkScopeBudget(budget, scopeIds.size, 0).ok) nodeBudgetExceeded = true;
      return false;
    }, { mode });
  };

  if (direction === 'upstream') {
    walkWithCap('inbound', singleDepth);
  } else if (direction === 'downstream') {
    walkWithCap('outbound', singleDepth);
  } else {
    walkWithCap('inbound', upstreamDepth!);
    walkWithCap('outbound', downstreamDepth!);
  }

  if (nodeBudgetExceeded) {
    return {
      ...checkScopeBudget(budget, scopeIds.size, 0),
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
  const ddlFits = checkScopeBudget(budget, 0, ddlChars).ok;
  if (includeDdl && !ddlFits) return checkScopeBudget(budget, scopeIds.size, ddlChars);
  // Only an omitted value may enable automatic DDL grounding.
  const effectiveIncludeDdl = includeDdl === false
    ? false
    : (includeDdl === true || ddlChars > 0) && ddlFits;

  const edges = model.edges
    .filter(e => scopeIds.has(e.source) && scopeIds.has(e.target))
    .map(e => [e.source, e.target, edgeApiType(e.type, nodeMap.get(e.source)?.type ?? '')] as [string, string, string]);

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
      return { id, error: REJECTION_CODES.notFound };
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
    });
  });
  return { results, total: results.length };
}




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
 * @param budget - The calling turn's budget, which the discovery guard is measured against.
 * @param minDegree - Minimum degree for a node to be considered a hub.
 * @param maxSize - Maximum size for a connected component to be considered an island.
 * @param longestPathMinNodes - Minimum number of nodes for a path to be considered "long".
 * @returns A summary of the analysis results including grouped node IDs.
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

  // Same discovery budget guard as the catalog listing, token axis only — an analysis report has no
  // per-node scope semantics. Hub, orphan and external-ref reports are bounded by the graph rather
  // than by a threshold, so a wide warehouse can produce a group list far past the turn budget.
  // Over budget → the counts WITHOUT the group list, never a sliced one: the pattern total stays
  // usable and the AI narrows the query with the knob that type actually has, or a different type.
  const groupChars = JSON.stringify(result.groups).length;
  if (!checkScopeBudget(budget, 0, groupChars).ok) {
    // Only `hubs` takes min_degree and only `islands` takes max_size — naming either knob for a
    // type it does not apply to (orphans, longest-path, cycles, external-refs) is wrong advice.
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
 * Searches the DDL/source code of scriptable objects with a regular expression.
 *
 * @remarks
 * The contract is grep's, the shape models are trained on: a pattern in, every match out with its
 * object, 1-based line number, matched line and surrounding context. Nothing is sliced — an empty
 * result is stated as a fact, an unusable pattern is an error naming the regex problem, and a
 * result too large for the discovery budget hands off to the approval path rather than returning a
 * partial list.
 *
 * A hit whose match sits inside a SQL comment carries `commented: true`; an executable hit carries
 * nothing extra. Marked, never filtered — a comment can hold the answer, and the few context lines
 * a hit ships with cannot show the block it sits in.
 *
 * `enclosing_predicate` is the same shape one level up, for control flow instead of comments: the
 * innermost `IF` / `WHILE` condition governing the hit's line, absent when the line runs
 * unconditionally. A gated statement and an ungated one arrive identical inside a three-line
 * window, so the reader attaches whichever condition the payload happens to contain (IB3-T3: an
 * ungated row-count verification was delivered as gated by the one `@ForceReimport` token in the
 * payload, which gates a dedup two hundred lines earlier). Right or absent, never a guess: a
 * single-statement `IF`, a body whose blocks do not balance, and a dead line all report nothing.
 *
 * `by_object` is the one per-object home: every object that produced a hit, with its `hits` total
 * and — where anything is dead — `commented_hits` and the commented lines as ranges. A per-row
 * value is read row by row, while an answer composed by theme merges rows from several places into
 * one statement, so the counts an answer states per object are served rather than tallied from the
 * rows (M0-T3: a hand tally of 33 rows across two procedures was delivered as 17/16 against 22/11,
 * with only the served `total` correct). `objects` is this list's length, so the count and the
 * breakdown cannot disagree. Additive: every hit stays in `results` with its own flag.
 *
 * @param model - The database model.
 * @param query - The regex pattern.
 * @param budget - The calling turn's budget, which the discovery guard is measured against.
 * @param types - Optional filter for scriptable object types.
 * @param store - Optional column store for high-fidelity DDL.
 * @param onDebug - Optional sink for a debug line when `query` is rewritten, or the result is over budget.
 * @returns Every matching line with its object metadata, plus the per-object `by_object` counts, or
 * the empty/invalid/over-budget fact.
 */
export function searchDdl(
  model: DatabaseModel,
  query: string,
  budget: TurnTokenBudget,
  types?: ('view' | 'procedure' | 'function')[],
  store?: import('../../engine/columnStore').ColumnStore,
  onDebug?: (msg: string) => void,
): object {
  if (query.length > REGEX_MAX_LENGTH) {
    return { error: REJECTION_CODES.invalidRegex, hint: `Query exceeds maximum length of ${REGEX_MAX_LENGTH} characters.` };
  }

  // Reject invalid / catastrophically slow regex
  const compiled = compileSearchRegex(query, onDebug);
  if (!compiled.ok) {
    return { error: REJECTION_CODES.invalidRegex, hint: regexRejectHint(query, compiled) };
  }

  const ddlTypes: ObjectType[] = types
    ? (types)
    : [...SCRIPT_TYPES];
  const typeSet = new Set<ObjectType>(ddlTypes);

  // Build searchable nodes with DDL from ColumnStore (or inline fallback for tests)
  const searchableNodes: SearchableNode[] = model.nodes.map(n => ({
    ...n,
    bodyScript: store?.getDdl(n.id) ?? n.bodyScript,
  }));
  // No limit argument: a grep result is never sliced. Size is answered by the budget check below.
  const matches = searchBodyScripts(searchableNodes, compiled.regex, typeSet, undefined, undefined, onDebug);

  // `commented` and `enclosing_predicate` are spread in only when they hold, so a live and
  // unconditional hit serializes exactly as before; a dead or gated one says so instead of reading
  // as unconditional behaviour.
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

  // What was actually read, so a zero-match answer is a fact about the search rather than advice
  // about the pattern: a wrong `types` filter and a genuinely absent string read differently here.
  const searched = {
    bodies: searchableNodes.filter(n => n.bodyScript && typeSet.has(n.type)).length,
    types:  ddlTypes,
  };
  if (results.length === 0) return { results, total: 0, objects: 0, searched };

  // One group per object, in first-hit order: how many hits it contributed, and which of them are
  // dead. Built from the same rows and the same `commented` bit, so it can only restate what is
  // already there; only genuinely consecutive lines are joined, so a range never claims a line that
  // produced no hit.
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

  // Same discovery budget guard as the catalog listing and the pattern report, token axis only.
  // Over budget → the counts WITHOUT the match list, never a sliced one: the model narrows the
  // pattern or the types, and an oversized ask is the hand-off to the approval-gated path.
  const payload = {
    results,
    total: results.length,
    objects,
    by_object: byObject,
    searched,
  };
  const resultChars = JSON.stringify(payload).length;
  const admission = checkScopeBudget(budget, 0, resultChars);
  if (!admission.ok) {
    onDebug?.(`searchDdl: ${results.length} matches in ${objects} objects exceed the discovery token budget (${estimateTokens(resultChars)} > ${admission.limits.token_budget} tokens) — matches omitted, pattern="${query}"`);
    return {
      reason:          admission.reason,
      counts:          admission.counts,
      limits:          admission.limits,
      total:           results.length,
      objects,
      searched,
      results_omitted: true as const,
      hint: 'The matches exceed the discovery token budget and were not inlined. Narrow the pattern, restrict types[], or explore the objects with lineage_start_exploration.',
    };
  }
  return payload;
}
