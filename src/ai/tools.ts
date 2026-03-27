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

// ─── Result types ─────────────────────────────────────────────────────────────

export type NotFoundError = { error: 'not_found'; id: string; hint: string };
export type InvalidRegex  = { error: 'invalid_regex'; hint: string };

// ─── Tool 1: lineage_get_context ─────────────────────────────────────────────

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

  return {
    project_name:  projectName,
    source_type:   model.dbPlatform ? 'database' : 'dacpac',
    db_platform:   model.dbPlatform ?? null,
    model_stats:   { nodes: model.nodes.length, edges: model.edges.length, schemas: model.schemas.length },
    visible_nodes: visibleNodes,
    filter:        activeFilter ? presentFilter(activeFilter) : null,
    saved_views:   savedViews.map(v => ({ id: v.id, name: v.name })),
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
  caps?: AiCapsOverride,
) {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (query.length > effectiveCaps.REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: 'Query exceeds maximum length of 200 characters.' };
  }

  const typeSet                = types         ? new Set<ObjectType>(types)           : undefined;
  const schemaSet              = schemas       ? new Set<string>(schemas)             : undefined;
  const excludeTypeSet         = excludeTypes  ? new Set<ObjectType>(excludeTypes)    : null;
  // exclude_schemas: SQL-style patterns — % matches any sequence; all other chars literal (case-insensitive)
  const excludeSchemaMatchers  = compileSqlLikePatterns(excludeSchemas);

  const nameHits = searchCatalog(
    model.nodes as SearchableNode[],
    query,
    typeSet,
    schemaSet,
    effectiveCaps.SEARCH_MAX_RESULTS,
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

  if (includeBody) {
    // Body types = intersection of requested types with body-scriptable types
    const scriptableTypes: ObjectType[] = ['view', 'procedure', 'function'];
    const bodyTypeSet: Set<ObjectType> = typeSet
      ? new Set(scriptableTypes.filter(t => typeSet.has(t)))
      : new Set<ObjectType>(scriptableTypes);

    if (bodyTypeSet.size > 0) {
      const bodyHits = searchBodyScripts(
        model.nodes as SearchableNode[],
        query,
        bodyTypeSet,
        2,
        effectiveCaps.SEARCH_MAX_RESULTS,
      );
      const seenIds = new Set(nameResults.map(r => (r as unknown as { id: string }).id));
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
    truncated: nameHits.length >= effectiveCaps.SEARCH_MAX_RESULTS,
  };

  if (results.length === 0) {
    return { ...base, hint: 'No matches. Try a shorter substring, check spelling, or call lineage_get_schema_summary to see available schema names.' };
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

  const node = model.nodes.find(n => n.id === id);
  if (!node) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }

  const neighbors = model.neighborIndex[id] ?? { in: [], out: [] };
  const nodeMap   = buildNodeMap(model);
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

  if (ddl && ddl.length > effectiveCaps.MAX_DDL_CHARS) {
    return {
      ...base,
      ddl: null,
      ddl_too_large: true,
      ddl_chars: ddl.length,
      ddl_hint: `DDL is ${ddl.length} chars, limit is ${effectiveCaps.MAX_DDL_CHARS}. ` +
                `Raise dataLineageViz.ai.maxDdlChars (max 500000) or use a large-context model (auto-scales).`,
    };
  }

  return { ...base, ddl };
}

// ─── Tool 5: lineage_run_bfs_trace ────────────────────────────────────────────
// Compound tool: BFS + optional DDL/columns per node (include_ddl=true, the default).
// For scriptable nodes (procedure/view/function): includes normalized DDL.
// For table/external nodes: includes compact column list instead.
// Include filters (types/schemas) are applied first; exclude filters are post-filters.
// excluded_count is added to the response when any exclusions were applied.

const SCRIPT_TYPES: Set<ObjectType> = new Set(['view', 'procedure', 'function']);

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

  const upDepth   = new Map<string, number>();
  const downDepth = new Map<string, number>();

  // Upstream BFS (inbound = follow edges backwards toward sources)
  if (upstreamHops > 0) {
    bfsFromNode(graph, id, (node, _attr, depth) => {
      if (depth > upstreamHops) return true; // prune branch
      upDepth.set(node, depth);
    }, { mode: 'inbound' });
  }
  upDepth.set(id, 0);

  // Downstream BFS (outbound = follow edges toward dependents)
  if (downstreamHops > 0) {
    bfsFromNode(graph, id, (node, _attr, depth) => {
      if (depth > downstreamHops) return true;
      downDepth.set(node, depth);
    }, { mode: 'outbound' });
  }
  downDepth.set(id, 0);

  const allNodeIds             = new Set([...upDepth.keys(), ...downDepth.keys()]);
  const nodeMap                = buildNodeMap(model);
  const typeSet                = types         ? new Set<ObjectType>(types)            : null;
  const schemaSet              = schemas       ? new Set<string>(schemas)              : null;
  // exclude_schemas: SQL-style patterns — % matches any sequence; all other chars literal (case-insensitive)
  const excludeSchemaMatchers  = compileSqlLikePatterns(excludeSchemas);
  const excludeTypeSet         = excludeTypes  ? new Set<ObjectType>(excludeTypes)     : null;

  // Include filter (allowlist — applied first; schemas/types are exact match)
  const afterInclude = [...allNodeIds].filter(nid => {
    const n = nodeMap.get(nid);
    if (!n) return false;
    if (typeSet   && !typeSet.has(n.type))     return false;
    if (schemaSet && !schemaSet.has(n.schema)) return false;
    return true;
  });

  // Exclude filter (denylist — post-filter; schema patterns use SQL LIKE, types are exact)
  const hasExclusions = excludeSchemaMatchers !== null || excludeTypeSet !== null;
  const filteredIds = hasExclusions
    ? afterInclude.filter(nid => {
        const n = nodeMap.get(nid);
        if (!n) return true;
        if (excludeSchemaMatchers && matchesAnySqlLike(n.schema, excludeSchemaMatchers)) return false;
        if (excludeTypeSet        && excludeTypeSet.has(n.type))                  return false;
        return true;
      })
    : afterInclude;
  const excludedCount = afterInclude.length - filteredIds.length;

  // Collect edges between filtered nodes
  const filteredSet = new Set(filteredIds);
  const allEdges: [string, string, string][] = [];
  for (const e of model.edges) {
    if (filteredSet.has(e.source) && filteredSet.has(e.target)) {
      allEdges.push([e.source, e.target, edgeApiType(e.type)]);
    }
  }

  const totalNodes = filteredIds.length;
  const totalEdges = allEdges.length;
  const truncated  = totalNodes > effectiveCaps.BFS_MAX_NODES || totalEdges > effectiveCaps.BFS_MAX_EDGES;

  const cappedIds   = filteredIds.slice(0, effectiveCaps.BFS_MAX_NODES);
  const cappedSet   = new Set(cappedIds);
  const cappedEdges = allEdges
    .filter(([s, t]) => cappedSet.has(s) && cappedSet.has(t))
    .slice(0, effectiveCaps.BFS_MAX_EDGES);

  const nodes = cappedIds.map(nid => {
    const n = nodeMap.get(nid);
    const base = strip({
      id:  nid,
      s:   n?.schema       || undefined,
      n:   n?.name         ?? nid,
      t:   n?.type         ?? 'table',
      ext: n?.externalType || undefined,
      up:  upDepth.get(nid),
      dn:  downDepth.get(nid),
    } as Record<string, unknown>);

    if (!includeDdl || !n) return base;

    // Scriptable: add DDL
    if (SCRIPT_TYPES.has(n.type) && n.bodyScript) {
      const ddl = normalizeBodyScript(n.bodyScript);
      if (ddl.length > effectiveCaps.MAX_DDL_CHARS) {
        return { ...base, ddl_too_large: true, ddl_chars: ddl.length };
      }
      return { ...base, ddl };
    }

    // Table / external: add compact column list
    if (n.columns && n.columns.length > 0) {
      return { ...base, cols: n.columns.map(c => presentColumn(c)) };
    }

    return base;
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
    return { error: 'invalid_regex' as const, hint: 'Query exceeds maximum length of 200 characters.' };
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
};

export type CreateAiViewRequest = {
  success: true;
  name: string;
  node_ids: string[];
  narrative?: string;
  layout_direction: 'LR' | 'TB';
  highlight_groups: Array<{ label: string; color: AIHighlightColor; node_ids: string[] }>;
  badges: Array<{ node_id: string; text: string; color?: AiBadgeColor }>;
};

export type CreateAiViewError = { success: false; errors: string[]; hint: string };

const AI_HIGHLIGHT_COLORS = new Set<string>(['bu', 'gn', 'rd', 'ye', 'or']);
const AI_BADGE_COLORS = new Set<string>(['bu', 'gn', 'rd', 'ye', 'or', 'gy']);

export function validateCreateAiView(
  model: DatabaseModel,
  input: CreateAiViewInput,
): CreateAiViewRequest | CreateAiViewError {
  const errors: string[] = [];

  // Name validation
  if (!input.name || input.name.trim().length === 0) errors.push('name is required');
  else if (input.name.length > 60) errors.push('name exceeds 60 characters');

  // node_ids validation
  if (!input.node_ids || input.node_ids.length === 0) {
    errors.push('node_ids must contain at least 1 ID');
  } else if (input.node_ids.length > 200) {
    errors.push('node_ids exceeds maximum of 200 IDs');
  } else {
    const unknown = input.node_ids.filter(id => !model.catalog[id]);
    if (unknown.length > 0) {
      const sample = unknown.slice(0, 3).join(', ');
      errors.push(`Unknown IDs: ${sample}${unknown.length > 3 ? ` (+${unknown.length - 3} more)` : ''}. Run \`lineage_search_objects\` to obtain valid IDs.`);
    }
  }

  // narrative validation
  if (input.narrative && input.narrative.length > 500) {
    errors.push('narrative exceeds 500 characters');
  }

  // highlight_groups validation
  const nodeIdSet = new Set(input.node_ids ?? []);
  if (input.highlight_groups) {
    if (input.highlight_groups.length > 5) errors.push('highlight_groups exceeds maximum of 5');
    for (const g of input.highlight_groups) {
      if (!g.label || g.label.length > 20) errors.push(`Group label "${g.label ?? ''}" must be 1–20 characters`);
      if (!AI_HIGHLIGHT_COLORS.has(g.color)) errors.push(`Group "${g.label}" has invalid color "${g.color}"`);
      const bad = g.node_ids.filter(id => !nodeIdSet.has(id));
      if (bad.length > 0) errors.push(`Group "${g.label}" contains IDs not in node_ids list: ${bad.slice(0, 3).join(', ')}`);
    }
  }

  // badges validation
  if (input.badges) {
    if (input.badges.length > 50) errors.push('badges exceeds maximum of 50');
    for (const b of input.badges) {
      if (!nodeIdSet.has(b.node_id)) errors.push(`Badge node_id "${b.node_id}" is not in node_ids list`);
      if (!b.text || b.text.length > 15) errors.push(`Badge text "${b.text ?? ''}" must be 1–15 characters`);
      if (b.color && !AI_BADGE_COLORS.has(b.color)) errors.push(`Badge color "${b.color}" is invalid`);
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      hint: 'Fix the listed errors and retry. Use `lineage_search_objects` to verify node IDs.',
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

  const results = cappedIds.map(id => {
    const node = model.nodes.find(n => n.id === id);
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

