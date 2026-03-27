/**
 * AI tool pure functions — zero VS Code imports.
 * All 9 functions are invoked by the registered LanguageModelTools in extension.ts.
 */
import { bfsFromNode } from 'graphology-traversal';
import type Graph from 'graphology';
import {
  DEFAULT_CONFIG,
  type DatabaseModel,
  type ObjectType,
  type AnalysisType,
} from '../engine/types';
import { runAnalysis as runGraphAnalysis } from '../engine/graphAnalysis';
import { searchCatalog, searchBodyScripts, safeRegex, type SearchableNode } from '../utils/modelSearch';
import { normalizeBodyScript } from '../utils/sql';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';

// ─── Caps ────────────────────────────────────────────────────────────────────

export const AI_CAPS = {
  BFS_MAX_NODES:       200,
  BFS_MAX_EDGES:       300,
  SEARCH_MAX_RESULTS:   50,
  REGEX_MAX_LENGTH:    200,
  ANALYSIS_MAX_GROUPS: 100,
  MAX_DDL_CHARS:     10000,   // per getObjectDetail call; 500000 = effectively unlimited
} as const;

/** Mutable override type for per-request cap tuning (auto-scale + VS Code settings). */
export type AiCapsOverride = { [K in keyof typeof AI_CAPS]?: number };

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Map edge types to API-facing names. */
function edgeApiType(type: string): string {
  return type === 'body' ? 'read' : type;
}

/** Build source→target edge type lookup for the entire model (cheap one-pass). */
function buildEdgeTypeMap(model: DatabaseModel): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of model.edges) {
    m.set(`${e.source}→${e.target}`, edgeApiType(e.type));
  }
  return m;
}

/** Build id→node lookup. */
function buildNodeMap(model: DatabaseModel): Map<string, (typeof model.nodes)[0]> {
  const m = new Map<string, (typeof model.nodes)[0]>();
  for (const n of model.nodes) m.set(n.id, n);
  return m;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type NotFoundError   = { error: 'not_found';    id: string;   hint: string };
export type InvalidRegex    = { error: 'invalid_regex'; hint: string };
export type SaveViewError   = { success: false; errors: string[]; hint: string };
export type SaveViewRequest = { success: true; name: string; node_ids: string[] };

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
    active_filter: activeFilter ?? null,
    saved_views:   savedViews.map(v => ({ id: v.id, name: v.name })),
  };
}

// ─── Tool 2: lineage_get_schema_summary ──────────────────────────────────────

export function getSchemasSummary(model: DatabaseModel) {
  return {
    schemas: model.schemas.map(s => ({
      name:       s.name,
      nodes:      s.nodeCount,
      tables:     s.types['table']     ?? 0,
      views:      s.types['view']      ?? 0,
      procedures: s.types['procedure'] ?? 0,
      functions:  s.types['function']  ?? 0,
      external:   s.types['external']  ?? 0,
    })),
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
  caps?: AiCapsOverride,
) {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (query.length > effectiveCaps.REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: 'Query exceeds maximum length of 200 characters.' };
  }

  const typeSet    = types   ? new Set<ObjectType>(types)   : undefined;
  const schemaSet  = schemas ? new Set<string>(schemas)     : undefined;

  const matches = searchCatalog(
    model.nodes as SearchableNode[],
    query,
    typeSet,
    schemaSet,
    effectiveCaps.SEARCH_MAX_RESULTS,
  );

  let filtered = matches;
  if (externalSubtypes && externalSubtypes.length > 0) {
    const subSet = new Set(externalSubtypes);
    filtered = matches.filter(n =>
      n.type !== 'external' || (n.externalType && subSet.has(n.externalType as 'et' | 'file' | 'db')),
    );
  }

  const results = filtered.map(n => ({
    id:            n.id,
    schema:        n.schema,
    name:          n.name,
    type:          n.type,
    external_type: n.externalType ?? null,
  }));

  const base = {
    results,
    total:     results.length,
    truncated: matches.length >= effectiveCaps.SEARCH_MAX_RESULTS,
  };

  if (results.length === 0) {
    return { ...base, hint: 'No matches. Try a shorter substring, check spelling, or call lineage_get_schema_summary to see available schema names.' };
  }
  return base;
}

// ─── Tool 4: lineage_get_object_detail ───────────────────────────────────────

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

  const columns = node.columns?.map(c => ({
    name:              c.name,
    type:              c.type,
    nullable:          c.nullable,
    extra:             c.extra,
    is_primary_key:    c.pkOrdinal !== undefined,
    pk_ordinal:        c.pkOrdinal ?? null,
    unique_constraint: c.unique ?? null,
    check_constraint:  c.check  ?? null,
  })) ?? null;

  const foreignKeys = node.fks?.map(fk => ({
    name:        fk.name,
    columns:     fk.columns,
    ref_schema:  fk.refSchema,
    ref_table:   fk.refTable,
    ref_columns: fk.refColumns,
    on_delete:   fk.onDelete,
  })) ?? null;

  const base = {
    id:               node.id,
    schema:           node.schema,
    name:             node.name,
    type:             node.type,
    external_type:    node.externalType  ?? null,
    external_url:     node.externalUrl   ?? null,
    columns,
    foreign_keys:     foreignKeys,
    upstream_count:   neighbors.in.length,
    downstream_count: neighbors.out.length,
  };

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

// ─── Tool 5: lineage_get_neighbors ───────────────────────────────────────────

export function getNeighbors(
  model: DatabaseModel,
  id: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  types?: ObjectType[],
): object {
  if (!model.neighborIndex[id]) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }

  const neighbors = model.neighborIndex[id];
  const nodeMap   = buildNodeMap(model);
  const edgeMap   = buildEdgeTypeMap(model);
  const typeSet   = types ? new Set<ObjectType>(types) : null;

  function mapNeighbors(ids: string[], isUpstream: boolean) {
    return ids
      .filter(nid => {
        if (!typeSet) return true;
        const n = nodeMap.get(nid);
        return n ? typeSet.has(n.type) : false;
      })
      .map(nid => {
        const n = nodeMap.get(nid);
        // edge direction: upstream neighbors have edge neighbor→id; downstream have edge id→neighbor
        const edgeKey = isUpstream ? `${nid}→${id}` : `${id}→${nid}`;
        return {
          id:        nid,
          schema:    n?.schema ?? '',
          name:      n?.name   ?? nid,
          type:      n?.type   ?? 'table',
          edge_type: edgeMap.get(edgeKey) ?? 'read',
        };
      });
  }

  const upstream   = direction !== 'downstream' ? mapNeighbors(neighbors.in,  true)  : [];
  const downstream = direction !== 'upstream'   ? mapNeighbors(neighbors.out, false) : [];

  return { node_id: id, upstream, downstream };
}

// ─── Tool 6: lineage_run_bfs_trace ───────────────────────────────────────────

export function runBfsTrace(
  model: DatabaseModel,
  graph: Graph,
  id: string,
  upstreamHops:   number = 3,
  downstreamHops: number = 3,
  types?:   ObjectType[],
  schemas?: string[],
  caps?: AiCapsOverride,
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

  const allNodeIds = new Set([...upDepth.keys(), ...downDepth.keys()]);
  const nodeMap    = buildNodeMap(model);
  const typeSet    = types   ? new Set<ObjectType>(types)   : null;
  const schemaSet  = schemas ? new Set<string>(schemas)     : null;

  let filteredIds = [...allNodeIds].filter(nid => {
    const n = nodeMap.get(nid);
    if (!n) return false;
    if (typeSet   && !typeSet.has(n.type))     return false;
    if (schemaSet && !schemaSet.has(n.schema)) return false;
    return true;
  });

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

  const cappedIds  = filteredIds.slice(0, effectiveCaps.BFS_MAX_NODES);
  const cappedSet  = new Set(cappedIds);
  const cappedEdges = allEdges
    .filter(([s, t]) => cappedSet.has(s) && cappedSet.has(t))
    .slice(0, effectiveCaps.BFS_MAX_EDGES);

  const nodes = cappedIds.map(nid => {
    const n = nodeMap.get(nid);
    return {
      id:         nid,
      schema:     n?.schema ?? '',
      name:       n?.name   ?? nid,
      type:       n?.type   ?? 'table',
      depth_up:   upDepth.has(nid)   ? upDepth.get(nid)!   : null,
      depth_down: downDepth.has(nid) ? downDepth.get(nid)! : null,
    };
  });

  return {
    origin:      id,
    nodes,
    edges:       cappedEdges,
    truncated,
    total_nodes: totalNodes,
    total_edges: totalEdges,
    ...(truncated ? { truncation_note: `Showing ${cappedIds.length} of ${totalNodes} nodes and ${cappedEdges.length} of ${totalEdges} edges. Narrow scope with types or schemas filters.` } : {}),
  };
}

// ─── Tool 7: lineage_run_analysis ─────────────────────────────────────────────

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

// ─── Tool 8: lineage_search_ddl ──────────────────────────────────────────────

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

// ─── Tool 9: lineage_create_ai_view ──────────────────────────────────────────

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
      errors.push(`Unknown IDs: ${sample}${unknown.length > 3 ? ` (+${unknown.length - 3} more)` : ''}. Run \`lineage_search_objects\` or \`lineage_get_neighbors\` to obtain valid IDs.`);
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

// ─── Tool 10: lineage_save_view ───────────────────────────────────────────────

export function validateSaveView(
  model: DatabaseModel,
  nodeIds: string[],
  name: string,
): SaveViewRequest | SaveViewError {
  if (!name || name.trim().length === 0) {
    return { success: false, errors: ['name is required'], hint: 'Provide a non-empty name for the view.' };
  }
  if (name.length > 60) {
    return { success: false, errors: ['name exceeds 60 characters'], hint: 'Shorten the view name to 60 characters or fewer.' };
  }
  if (!nodeIds || nodeIds.length === 0) {
    return { success: false, errors: ['node_ids is empty'], hint: 'Provide at least one node ID from search or trace results.' };
  }

  const unknownIds = nodeIds.filter(id => !model.catalog[id]);
  if (unknownIds.length > 0) {
    const sample = unknownIds.slice(0, 3).join(', ');
    return {
      success: false,
      errors:  unknownIds.map(id => `Unknown node ID: ${id}`),
      hint:    `${unknownIds.length} unknown ID(s) — first 3: ${sample}. Use lineage_search_objects to obtain valid IDs.`,
    };
  }

  return { success: true, name: name.trim(), node_ids: nodeIds };
}
