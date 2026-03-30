/**
 * AI tool pure functions — zero VS Code imports.
 * All 8 functions are invoked by the registered LanguageModelTools in extension.ts.
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
import { searchCatalog, safeRegex, searchBodyScripts, type SearchableNode } from '../utils/modelSearch';
import { normalizeBodyScript } from '../utils/sql';
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
    // Small model: include full catalog WITH DDL + columns — AI can answer column questions
    // without any additional tool calls (no search, no BFS needed)
    ...(isSmall && {
      objects: model.nodes.map(n => {
        const base = presentNode(n, model.neighborIndex);
        // Add DDL for scriptable nodes (procedure/view/function)
        if (SCRIPT_TYPES.has(n.type) && n.bodyScript) {
          const ddl = normalizeBodyScript(n.bodyScript);
          return { ...base, ddl };
        }
        // Add columns + FK for table/external nodes
        if (n.columns && n.columns.length > 0) {
          const enriched: Record<string, unknown> = { ...base, cols: n.columns.map(c => presentColumn(c)) };
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
      }),
      edges: model.edges.map(e => [e.source, e.target, edgeApiType(e.type)]),
    }),
    // Large model: tell AI how many refs are outside the loaded model
    ...(!isSmall && model.parseStats && {
      unresolved_ref_count: model.parseStats.droppedRefs?.length ?? 0,
    }),
  };
}

// ─── Query validation ───────────────────────────────────────────────────────

/** Reject garbage queries (empty, single char, pure wildcards). */
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

// ─── Tool 2: lineage_search_objects ──────────────────────────────────────────

export function searchObjects(
  model: DatabaseModel,
  query: string,
  types?: ObjectType[],
  schemas?: string[],
  mode: 'substring' | 'regex' = 'substring',
  caps?: AiCapsOverride,
) {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (query.length > effectiveCaps.REGEX_MAX_LENGTH) {
    return { error: 'invalid_regex' as const, hint: `Query exceeds maximum length of ${effectiveCaps.REGEX_MAX_LENGTH} characters.` };
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
    effectiveCaps.SEARCH_MAX_RESULTS,
    mode,
  );

  const results = nameHits.map(n => ({
    ...presentNode(n, model.neighborIndex),
    match: 'name' as const,
  }));

  const base = {
    results,
    total:     results.length,
    truncated: nameHits.length >= effectiveCaps.SEARCH_MAX_RESULTS,
  };

  if (results.length === 0) {
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
        return {
          ...base,
          action_required: `SCHEMA MISMATCH: 0 results for "${effectiveQuery}" in ${appliedSchemaFilter.join(', ')}. ` +
            `Found in: ${foundSchemas.join(', ')}. Ask the user which schema they mean before calling any other tool.`,
          schema_mismatch: {
            requested_schemas: appliedSchemaFilter,
            found_in_schemas: foundSchemas,
            fallback_results: fallbackHits.slice(0, 5).map(n => presentNode(n, model.neighborIndex)),
          },
        };
      }
    }
    return {
      ...base,
      action_required: `NO RESULTS for "${effectiveQuery}". Ask the user to verify the name or try a different search term.`,
    };
  }
  return base;
}

// ─── Tool 3: lineage_get_object_detail ───────────────────────────────────────

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

// ─── Tool 4: lineage_run_bfs_trace ────────────────────────────────────────────
// Compound tool: BFS + DDL/columns per node (include_ddl=true default).
// For scriptable nodes (procedure/view/function): includes normalized DDL.
// For table/external nodes: includes compact column list instead.
// types[] and schemas[] are include-only filters (no exclude).
// BFS_MAX_NODES/BFS_MAX_EDGES caps prevent payload blow-up — no depth clamp needed.

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
  caps?:           AiCapsOverride,
): object {
  const effectiveCaps = caps ? { ...AI_CAPS, ...caps } : AI_CAPS;
  if (!graph.hasNode(id)) {
    return { error: 'not_found' as const, id, hint: 'Call lineage_search_objects to find the exact object ID.' };
  }

  const { upDepth, downDepth } = executeBfs(graph, id, upstreamHops, downstreamHops);
  const allNodeIds    = new Set([...upDepth.keys(), ...downDepth.keys()]);
  const nodeMap       = buildNodeMap(model);
  const typeSet       = types   ? new Set<ObjectType>(types)   : null;
  const schemaSet     = schemas ? new Set<string>(schemas)     : null;

  const filteredIds = applyBfsFilters(allNodeIds, nodeMap, typeSet, schemaSet);

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
    ...(truncated ? { truncation_note: `Showing ${cappedIds.length} of ${totalNodes} nodes and ${cappedEdges.length} of ${totalEdges} edges. Narrow scope with types[]/schemas[] or reduce hops.` } : {}),
  };
}

// ─── Tool 5: lineage_run_analysis ─────────────────────────────────────────────

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

// ─── Tool 6: lineage_search_ddl ──────────────────────────────────────────────

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
    SNIPPET_CONTEXT_LINES,
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

// ─── Tool 7: lineage_create_ai_view ──────────────────────────────────────────

export type AIHighlightRole = 'source' | 'transform' | 'target' | 'good' | 'warn' | 'fail';

export type CreateAiViewInput = {
  name: string;
  node_ids: string[];
  summary?: string;
  description?: string;
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
};

export type CreateAiViewRequest = {
  success: true;
  name: string;
  node_ids: string[];
  summary?: string;
  description?: string;
  layout_direction: 'LR' | 'TB';
  highlight_groups: Array<{ label: string; color: AIHighlightRole; node_ids: string[] }>;
  badges: Array<{ node_id: string; text: string }>;
  notes: Array<{ node_id: string; text: string }>;
};

export type CreateAiViewError = { success: false; errors: string[]; hint: string };

const AI_HIGHLIGHT_ROLES = new Set<string>(['source', 'transform', 'target', 'good', 'warn', 'fail']);

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

  // 2. Summary length is validated (not auto-fixed) — AI should learn to write concise summaries

  const nodeIdSet = new Set(fixed.node_ids ?? []);

  // 3. Drop empty badges & badges for removed nodes (no text truncation — UI handles overflow)
  if (fixed.badges) {
    const before = fixed.badges.length;
    const filtered = fixed.badges.filter(b => nodeIdSet.has(b.node_id) && b.text && b.text.trim().length > 0);
    fixed = { ...fixed, badges: filtered };
    const dropped = before - filtered.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned badge(s)`);
  }

  // 4. Drop empty notes & notes for removed nodes (no text truncation or cap — UI handles overflow)
  if (fixed.notes) {
    const before = fixed.notes.length;
    const filtered = fixed.notes.filter(n => nodeIdSet.has(n.node_id) && n.text && n.text.trim().length > 0);
    fixed = { ...fixed, notes: filtered };
    const dropped = before - filtered.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned note(s)`);
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

/** Validate markdown format — returns error strings (empty = valid). */
export function validateMarkdownFormat(md: string): string[] {
  const errors: string[] = [];

  // Reject \begin{...} environments (fragile in remark-math, breaks rendering)
  const beginMatch = md.match(/\\begin\{(\w+)\}/);
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

  // summary required + length: soft 120 (instructed), hard 300 (rejected)
  if (!input.summary || input.summary.trim().length === 0) {
    errors.push('summary is required — one-line graph purpose (~120 chars, max 300)');
  } else if (input.summary.length > 300) {
    errors.push('summary exceeds hard limit (300 chars) — aim for ~120 chars');
  }

  // description required + content quality checks
  if (!input.description || input.description.trim().length === 0) {
    errors.push('description is required — structured markdown answer with ## headings');
  } else {
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

  // highlight_groups validation (structural + color validity — autoFix does not normalize colors)
  const nodeIdSet = new Set(input.node_ids ?? []);
  if (input.highlight_groups) {
    if (input.highlight_groups.length > 5) errors.push('highlight_groups exceeds maximum of 5');
    for (const g of input.highlight_groups) {
      if (!g.label) errors.push('Group label is required');
      if (!AI_HIGHLIGHT_ROLES.has(g.color)) errors.push(`Group "${g.label}" has invalid role "${g.color}"`);
    }
  }

  if (errors.length > 0) {
    // Context-efficient hint: tell AI to fix only the broken fields, keep the rest unchanged
    const hint = errors.length === 1 && errors[0].includes('summary')
      ? 'Shorten the summary to ~120 chars (hard limit 300) and retry with the same input otherwise.'
      : 'Fix the listed errors and retry. Do NOT change fields that passed validation.';
    return { success: false, errors, hint };
  }

  return {
    success: true,
    name: input.name.trim(),
    node_ids: input.node_ids,
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

