/**
 * Shared model builder — single pipeline for both dacpac and DMV extractors.
 *
 * Both extractors produce ExtractedObject[] + ExtractedDependency[], then
 * this module builds the final DacpacModel (nodes, edges, schemas, stats).
 */

import {
  DacpacModel,
  LineageNode,
  LineageEdge,
  SchemaInfo,
  ObjectType,
  ParseStats,
  ExtractedObject,
  ExtractedDependency,
  CatalogEntry,
  NeighborIndex,
  DEFAULT_CONFIG,
  createEmptySchemaInfo,
} from './types';
import { parseSqlBody, extractExternalRefs } from './sqlBodyParser';
import { stripBrackets, splitSqlName, schemaKey } from '../utils/sql';

// ─── Public API ─────────────────────────────────────────────────────────────

export function buildModel(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
  currentDatabase?: string,
  externalRefsEnabled = true,
): DacpacModel {
  const { nodes, edges, stats, neighborPairs } = buildNodesAndEdges(objects, deps, allObjects, currentDatabase, externalRefsEnabled);

  // CI normalization: unify node.schema to a single canonical display name (first-seen from
  // metadata) across all nodes that belong to the same logical schema.
  // In CI mode this merges e.g. 'DBO' and 'dbo' → one consistent display name.
  // In CS mode schemaKey(x) === x, so this pass is a no-op.
  const schemaCanonical = new Map<string, string>(); // schemaKey → first-seen display name
  for (const node of nodes) {
    const k = schemaKey(node.schema);
    if (!schemaCanonical.has(k)) schemaCanonical.set(k, node.schema);
  }
  for (const node of nodes) {
    node.schema = schemaCanonical.get(schemaKey(node.schema))!; // safe: every key was inserted in the loop above
  }

  const schemas = computeSchemas(nodes);
  const catalog = buildCatalog(allObjects ?? objects, schemaCanonical);

  // Inject virtual nodes (file, cross-DB) into catalog — they're not in objects/allObjects
  for (const node of nodes) {
    if (node.externalType === 'file' || node.externalType === 'db') {
      catalog[node.id] = { schema: '', name: node.name, type: 'external', externalType: node.externalType };
    }
  }

  const neighborIndex = buildNeighborIndex(edges, neighborPairs);

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No objects found in data source.');
  } else if (nodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found.');
  }

  return {
    nodes, edges, schemas, catalog, neighborIndex,
    parseStats: stats,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ─── Catalog Builder ────────────────────────────────────────────────────────

/**
 * Build a display catalog keyed by normalized node ID.
 * Covers all objects (including cross-schema ones not in the selected schema set).
 * Uses schemaCanonical map to ensure catalog entries use the same display name as nodes.
 */
function buildCatalog(
  allObjects: ExtractedObject[],
  schemaCanonical: Map<string, string>,
): Record<string, CatalogEntry> {
  const catalog: Record<string, CatalogEntry> = {};
  for (const obj of allObjects) {
    const { schema, objectName } = parseName(obj.fullName);
    const displaySchema = schemaCanonical.get(schemaKey(schema)) ?? schema;
    catalog[normalizeName(obj.fullName)] = {
      schema: displaySchema, name: objectName, type: obj.type,
      ...(obj.externalType && { externalType: obj.externalType }),
    };
  }
  return catalog;
}

// ─── NeighborIndex Builder ───────────────────────────────────────────────────

/** Build an O(1) neighbor lookup from edges plus optional cross-schema neighbor pairs. */
function buildNeighborIndex(
  edges: LineageEdge[],
  extraPairs?: Array<{ source: string; target: string }>,
): NeighborIndex {
  const inSets  = new Map<string, Set<string>>();
  const outSets = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!inSets.has(id))  inSets.set(id, new Set());
    if (!outSets.has(id)) outSets.set(id, new Set());
  };
  const addPair = (source: string, target: string) => {
    ensure(source);
    ensure(target);
    inSets.get(target)!.add(source);
    outSets.get(source)!.add(target);
  };
  for (const edge of edges) addPair(edge.source, edge.target);
  for (const pair of extraPairs ?? []) addPair(pair.source, pair.target);

  const index: NeighborIndex = {};
  for (const [id, inSet] of inSets) {
    index[id] = { in: Array.from(inSet), out: Array.from(outSets.get(id)!) };
  }
  return index;
}

// ─── Name Parsing ───────────────────────────────────────────────────────────

/** Parse "[schema].[object]" — returns catalog-original casing for schema and name.
 *  Uses bracket-aware splitting so dots inside [bracket identifiers] are not treated as
 *  separators (e.g., [spLoadReconciliation_Case4.5] stays as one part). */
export function parseName(fullName: string): { schema: string; objectName: string } {
  const parts = splitSqlName(fullName).map(p => stripBrackets(p));
  if (parts.length >= 2) {
    return { schema: parts[0], objectName: parts[1] };
  }
  return { schema: 'dbo', objectName: parts[0] };
}

/** Normalize to lowercase "[schema].[object]" for consistent matching.
 *  Uses bracket-aware splitting so dots inside [bracket identifiers] are part of the name.
 *  - 2-part  [schema].[object]              → [schema].[object]
 *  - 3-part  [db].[schema].[object]         → [schema].[object]  (take last 2)
 *  - 4-part+ [srv].[db].[schema].[object]   → never in catalog  */
export function normalizeName(name: string): string {
  const parts = splitSqlName(name).map(p => stripBrackets(p));
  if (parts.length < 2) {
    // No schema qualifier — return bare name that will never match a node ID.
    // We do NOT assume dbo because the default schema is a per-connection SQL Server setting.
    return `[${parts[0] ?? ''}]`.toLowerCase();
  }
  if (parts.length >= 4) {
    // Linked-server / cross-database 4-part name — always reject (never in local catalog).
    return `[__external__].[${parts[parts.length - 1]}]`;
  }
  // For 2-part and 3-part: take the last two parts (schema and object).
  // 3-part db.schema.object: dropping the database prefix is correct — the catalog only
  // contains local objects identified by schema.object.
  return `[${parts[parts.length - 2]}].[${parts[parts.length - 1]}]`.toLowerCase();
}

/** True when the raw captured name contains a schema qualifier (a dot). */
function isSchemaQualified(name: string): boolean {
  return stripBrackets(name).includes('.');
}

/** Well-known system schemas whose objects must never appear as lineage nodes.
 *  msdb/tempdb/model/master are SQL Server system databases whose schemas (dbo, etc.)
 *  are commonly referenced in SPs but are never part of user lineage. */
const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema', 'msdb', 'tempdb', 'model', 'master']);

/** SQL Server XML data type methods that look like schema.object to the parser.
 *  e.g. [ref].[value], [resume].[nodes] — never real catalog references. */
const XML_METHODS = new Set(['nodes', 'value', 'exist', 'query', 'modify']);

/** True when the schema prefix of a schema-qualified name is a system schema. */
function isSystemRef(name: string): boolean {
  const schema = stripBrackets(name).split('.')[0].toLowerCase();
  return SYSTEM_SCHEMAS.has(schema);
}

function inferBodyDirection(body: string, schema: string, name: string): 'write' | 'read' {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\b(?:UPDATE|INSERT(?:\\s+INTO)?|DELETE(?:\\s+FROM)?|MERGE(?:\\s+INTO)?|TRUNCATE\\s+TABLE)\\s+` +
    `(?:TOP\\s*\\([^)]*\\)\\s*)?(?:\\[?${esc(schema)}\\]?\\.)?\\[?${esc(name)}\\]?`,
    'i',
  );
  return pattern.test(body) ? 'write' : 'read';
}

/** Add an edge if it doesn't already exist */
function addEdge(
  edges: LineageEdge[],
  edgeKeys: Set<string>,
  source: string,
  target: string,
  type: 'body' | 'exec'
) {
  const key = `${source}→${target}`;
  if (!edgeKeys.has(key)) {
    edgeKeys.add(key);
    edges.push({ source, target, type });
  }
}

// ─── Schema Computation ────────────────────────────────────────────────────

export function computeSchemas(nodes: LineageNode[]): SchemaInfo[] {
  const map = new Map<string, SchemaInfo>();
  for (const node of nodes) {
    if (node.externalType === 'file' || node.externalType === 'db') continue; // virtual nodes have no schema
    const key = schemaKey(node.schema);
    let info = map.get(key);
    if (!info) {
      info = createEmptySchemaInfo(node.schema);
      map.set(key, info);
    }
    info.nodeCount++;
    info.types[node.type]++;
  }
  return Array.from(map.values()).sort((a, b) => b.nodeCount - a.nodeCount);
}

// ─── Core Pipeline ──────────────────────────────────────────────────────────

/** Convert ExtractedObjects to LineageNodes, deduplicating by normalized ID. */
function buildNodeList(objects: ExtractedObject[]): { nodes: LineageNode[]; nodeIds: Set<string> } {
  const nodes: LineageNode[] = [];
  const nodeIds = new Set<string>();

  for (const obj of objects) {
    const { schema, objectName } = parseName(obj.fullName);
    const id = normalizeName(obj.fullName);

    if (nodeIds.has(id)) continue;
    nodeIds.add(id);

    nodes.push({
      id, schema, name: objectName, fullName: obj.fullName, type: obj.type,
      ...(obj.bodyScript && { bodyScript: obj.bodyScript }),
      ...(obj.columns && obj.columns.length > 0 && { columns: obj.columns }),
      ...(obj.fks !== undefined && { fks: obj.fks }),
      ...(obj.externalType && { externalType: obj.externalType }),
    });
  }

  return { nodes, nodeIds };
}

/** Build full-catalog lookup maps from allObjects (Phase 1 catalog for cross-schema resolution). */
function buildFullCatalog(allObjects?: ExtractedObject[]): {
  allNodeIds: Set<string>;
  allObjectMeta: Map<string, { schema: string; name: string; type: ObjectType }>;
} {
  const allNodeIds = new Set<string>();
  const allObjectMeta = new Map<string, { schema: string; name: string; type: ObjectType }>();
  if (allObjects) {
    for (const obj of allObjects) {
      const id = normalizeName(obj.fullName);
      allNodeIds.add(id);
      const { schema, objectName } = parseName(obj.fullName);
      allObjectMeta.set(id, { schema, name: objectName, type: obj.type });
    }
  }
  return { allNodeIds, allObjectMeta };
}

interface GroupedDeps {
  /** Deps where both source and target are in the selected node set. */
  depsPerSource: Map<string, string[]>;
  /** Deps where source ∈ selected, target ∈ full catalog but not selected. */
  crossSchemaDepsForNode: Map<string, string[]>;
  /** Deps where target is schema-qualified but not in any catalog. */
  unresolvableDepsForNode: Map<string, string[]>;
  /** Cross-schema neighbor pairs discovered from deps with unselected sources. */
  inboundNeighborPairs: Array<{ source: string; target: string }>;
  /** Deps where target is a 3-part cross-DB name (DMV metadata). sourceId → raw 3-part names. */
  crossDbMetaDeps: Map<string, string[]>;
}

/** Classify dependencies into three buckets: in-scope, cross-schema, unresolvable. */
function groupDependencies(
  deps: ExtractedDependency[],
  nodeIds: Set<string>,
  allNodeIds: Set<string>,
): GroupedDeps {
  const depsPerSource = new Map<string, string[]>();
  const crossSchemaDepsForNode = new Map<string, string[]>();
  const unresolvableDepsForNode = new Map<string, string[]>();
  const inboundNeighborPairs: Array<{ source: string; target: string }> = [];
  const crossDbMetaDeps = new Map<string, string[]>();

  for (const dep of deps) {
    // Detect 3-part cross-DB targets before normalization (normalizeName strips DB prefix)
    const targetParts = splitSqlName(dep.targetName);
    if (targetParts.length >= 3) {
      const sourceId = normalizeName(dep.sourceName);
      if (nodeIds.has(sourceId) || (allNodeIds.size > 0 && allNodeIds.has(sourceId))) {
        if (!crossDbMetaDeps.has(sourceId)) crossDbMetaDeps.set(sourceId, []);
        crossDbMetaDeps.get(sourceId)!.push(dep.targetName);
      }
      continue;
    }

    const sourceId = normalizeName(dep.sourceName);
    const targetId = normalizeName(dep.targetName);

    if (sourceId === targetId) continue;

    if (!nodeIds.has(sourceId)) {
      if (allNodeIds.size > 0 && allNodeIds.has(sourceId) && nodeIds.has(targetId)) {
        inboundNeighborPairs.push({ source: targetId, target: sourceId });
      }
      continue;
    }

    if (nodeIds.has(targetId)) {
      if (!depsPerSource.has(sourceId)) depsPerSource.set(sourceId, []);
      depsPerSource.get(sourceId)!.push(targetId);
    } else if (allNodeIds.size > 0 && allNodeIds.has(targetId)) {
      if (!crossSchemaDepsForNode.has(sourceId)) crossSchemaDepsForNode.set(sourceId, []);
      crossSchemaDepsForNode.get(sourceId)!.push(targetId);
    } else {
      if (isSchemaQualified(dep.targetName) && !isSystemRef(dep.targetName)) {
        if (!unresolvableDepsForNode.has(sourceId)) unresolvableDepsForNode.set(sourceId, []);
        unresolvableDepsForNode.get(sourceId)!.push(dep.targetName);
      }
    }
  }

  return { depsPerSource, crossSchemaDepsForNode, unresolvableDepsForNode, inboundNeighborPairs, crossDbMetaDeps };
}

/** Shared context passed to per-node edge processors. */
interface EdgeContext {
  nodeIds: Set<string>;
  allNodeIds: Set<string>;
  allObjectMeta: Map<string, { schema: string; name: string; type: ObjectType }>;
  nodeMap: Map<string, LineageNode>;
  edges: LineageEdge[];
  edgeKeys: Set<string>;
  stats: ParseStats;
  neighborPairs: Array<{ source: string; target: string }>;
  grouped: GroupedDeps;
  /** Cross-DB refs from regex parser, collected during SP/view processing. nodeId → {sources, targets} */
  crossDbRegexRefs: Map<string, { sources: string[]; targets: string[] }>;
}

/** Process regex-parsed refs (sources, targets, or exec calls) for a single SP/view/function. */
function processRegexRefs(
  refs: string[],
  sourceId: string,
  spLabel: string,
  direction: 'in' | 'out',
  edgeType: 'body' | 'exec',
  ctx: EdgeContext,
  outRefs: string[],
  skipped: string[],
  unrelated: string[],
): number {
  let count = 0;
  for (const dep of refs) {
    if (!isSchemaQualified(dep)) { skipped.push(dep); continue; }
    if (isSystemRef(dep)) { skipped.push(dep); continue; }
    const depId = normalizeName(dep);
    ctx.stats.parsedRefs++;
    if (depId !== sourceId) {
      if (ctx.nodeIds.has(depId)) {
        if (direction === 'in') {
          addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, edgeType);
        } else {
          addEdge(ctx.edges, ctx.edgeKeys, sourceId, depId, edgeType);
        }
        ctx.stats.resolvedEdges++;
        count++;
        const n = ctx.nodeMap.get(depId);
        const label = n ? `${n.schema}.${n.name}` : dep;
        outRefs.push(edgeType === 'exec' ? label + ' (exec)' : label);
      } else if (ctx.allNodeIds.size > 0 && ctx.allNodeIds.has(depId)) {
        if (direction === 'in') {
          ctx.neighborPairs.push({ source: depId, target: sourceId });
        } else {
          ctx.neighborPairs.push({ source: sourceId, target: depId });
        }
      } else {
        const suffix = edgeType === 'exec' ? dep + ' (exec)' : dep;
        unrelated.push(suffix);
        ctx.stats.droppedRefs.push(`${spLabel} → ${suffix}`);
      }
    }
  }
  return count;
}

/** Process edges for a non-SP node (table, view, function). */
function processNonSpEdges(node: LineageNode, xmlDeps: string[], ctx: EdgeContext): void {
  const sourceId = node.id;

  // Non-SP: add dependency edges as inbound (dep → this node)
  for (const depId of xmlDeps) {
    addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, 'body');
  }
  // Cross-schema deps for non-SP: referenced object is upstream (inbound).
  for (const csDepId of ctx.grouped.crossSchemaDepsForNode.get(sourceId) ?? []) {
    ctx.neighborPairs.push({ source: csDepId, target: sourceId });
  }

  // Views and functions: parser supplement — MS metadata is primary source.
  if (node.bodyScript && (node.type === 'view' || node.type === 'function')) {
    const parsed = parseSqlBody(node.bodyScript);
    // Collect cross-DB refs from regex parser for virtual node creation
    if (parsed.crossDbSources.length > 0 || parsed.crossDbTargets.length > 0) {
      const existing = ctx.crossDbRegexRefs.get(sourceId);
      if (existing) {
        existing.sources.push(...parsed.crossDbSources);
        existing.targets.push(...parsed.crossDbTargets);
      } else {
        ctx.crossDbRegexRefs.set(sourceId, { sources: parsed.crossDbSources, targets: parsed.crossDbTargets });
      }
    }
    const xmlDepIds = new Set(xmlDeps);
    const spLabel = `${node.schema}.${node.name}`;
    const spParserAdded: string[] = [];
    const spUnrelated: string[] = [];
    const spSkipped: string[] = [];

    for (const dep of parsed.sources) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      if (depId === sourceId || xmlDepIds.has(depId)) continue;
      ctx.stats.parsedRefs++;
      if (ctx.nodeIds.has(depId)) {
        addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, 'body');
        ctx.stats.resolvedEdges++;
        const n = ctx.nodeMap.get(depId);
        spParserAdded.push(n ? `${n.schema}.${n.name}` : dep);
      } else if (ctx.allNodeIds.size > 0 && ctx.allNodeIds.has(depId)) {
        ctx.neighborPairs.push({ source: depId, target: sourceId });
      } else {
        const parts = splitSqlName(dep);
        const objPart = stripBrackets(parts[parts.length - 1]).toLowerCase();
        if (XML_METHODS.has(objPart)) { spSkipped.push(dep); continue; }
        spUnrelated.push(dep);
        ctx.stats.droppedRefs.push(`${spLabel} → ${dep}`);
      }
    }

    for (const rawName of ctx.grouped.unresolvableDepsForNode.get(sourceId) ?? []) {
      spUnrelated.push(rawName);
      ctx.stats.droppedRefs.push(`${spLabel} → ${rawName}`);
    }

    if (spParserAdded.length > 0 || spUnrelated.length > 0 || spSkipped.length > 0) {
      ctx.stats.spDetails.push({
        name: spLabel, inCount: spParserAdded.length, outCount: 0,
        ...(spParserAdded.length > 0 && { inRefs: spParserAdded }),
        unrelated: spUnrelated,
        ...(spSkipped.length > 0 && { skippedRefs: spSkipped }),
      });
    }
  }
}

/** Process edges for a stored procedure node (regex-based body parsing). */
function processSpEdges(node: LineageNode, xmlDeps: string[], ctx: EdgeContext): void {
  const sourceId = node.id;
  const parsed = parseSqlBody(node.bodyScript!);
  const spLabel = `${node.schema}.${node.name}`;
  const spInRefs: string[] = [];
  const spOutRefs: string[] = [];
  const spUnrelated: string[] = [];
  const spSkipped: string[] = [];

  // Collect cross-DB refs from regex parser for virtual node creation
  if (parsed.crossDbSources.length > 0 || parsed.crossDbTargets.length > 0) {
    ctx.crossDbRegexRefs.set(sourceId, { sources: parsed.crossDbSources, targets: parsed.crossDbTargets });
  }

  // Collect target/exec IDs to exclude from dep fallback
  const outboundIds = new Set<string>();
  for (const dep of parsed.targets) {
    if (isSchemaQualified(dep) && !isSystemRef(dep)) outboundIds.add(normalizeName(dep));
  }
  for (const dep of parsed.execCalls) {
    if (isSchemaQualified(dep) && !isSystemRef(dep)) outboundIds.add(normalizeName(dep));
  }

  // Add dependency edges not already handled by regex
  for (const depId of xmlDeps) {
    if (!outboundIds.has(depId)) {
      const depNode = ctx.nodeMap.get(depId);
      if (depNode?.type === 'procedure') {
        addEdge(ctx.edges, ctx.edgeKeys, sourceId, depId, 'exec');
      } else if (
        (depNode?.type === 'table' || depNode?.type === 'external') &&
        node.bodyScript &&
        inferBodyDirection(node.bodyScript, depNode.schema, depNode.name) === 'write'
      ) {
        addEdge(ctx.edges, ctx.edgeKeys, sourceId, depId, 'body');
      } else {
        addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, 'body');
      }
    }
  }
  // Cross-schema deps: infer direction from catalog metadata.
  for (const csDepId of ctx.grouped.crossSchemaDepsForNode.get(sourceId) ?? []) {
    if (!outboundIds.has(csDepId)) {
      const meta = ctx.allObjectMeta.get(csDepId);
      if (meta?.type === 'procedure') {
        ctx.neighborPairs.push({ source: sourceId, target: csDepId });
      } else if (
        (meta?.type === 'table' || meta?.type === 'external') &&
        node.bodyScript &&
        inferBodyDirection(node.bodyScript, meta.schema, meta.name) === 'write'
      ) {
        ctx.neighborPairs.push({ source: sourceId, target: csDepId });
      } else {
        ctx.neighborPairs.push({ source: csDepId, target: sourceId });
      }
    }
  }

  // Metadata deps with no catalog match
  for (const rawName of ctx.grouped.unresolvableDepsForNode.get(sourceId) ?? []) {
    spUnrelated.push(rawName);
    ctx.stats.droppedRefs.push(`${spLabel} → ${rawName}`);
  }

  // Regex sources (inbound), targets (outbound), exec calls (outbound)
  const spIn = processRegexRefs(parsed.sources, sourceId, spLabel, 'in', 'body', ctx, spInRefs, spSkipped, spUnrelated);
  const spOut =
    processRegexRefs(parsed.targets, sourceId, spLabel, 'out', 'body', ctx, spOutRefs, spSkipped, spUnrelated) +
    processRegexRefs(parsed.execCalls, sourceId, spLabel, 'out', 'exec', ctx, spOutRefs, spSkipped, spUnrelated);

  ctx.stats.spDetails.push({
    name: spLabel, inCount: spIn, outCount: spOut,
    ...(spInRefs.length > 0 && { inRefs: spInRefs }),
    ...(spOutRefs.length > 0 && { outRefs: spOutRefs }),
    unrelated: spUnrelated,
    ...(spSkipped.length > 0 && { skippedRefs: spSkipped }),
  });
}

function buildNodesAndEdges(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
  currentDatabase?: string,
  externalRefsEnabled = true,
): { nodes: LineageNode[]; edges: LineageEdge[]; stats: ParseStats; neighborPairs: Array<{ source: string; target: string }> } {
  const { nodes, nodeIds } = buildNodeList(objects);
  const { allNodeIds, allObjectMeta } = buildFullCatalog(allObjects);
  const grouped = groupDependencies(deps, nodeIds, allNodeIds);

  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();
  const stats: ParseStats = { parsedRefs: 0, resolvedEdges: 0, droppedRefs: [], spDetails: [] };
  const neighborPairs: Array<{ source: string; target: string }> = [...grouped.inboundNeighborPairs];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const crossDbRegexRefs = new Map<string, { sources: string[]; targets: string[] }>();

  const ctx: EdgeContext = { nodeIds, allNodeIds, allObjectMeta, nodeMap, edges, edgeKeys, stats, neighborPairs, grouped, crossDbRegexRefs };

  for (const node of nodes) {
    const xmlDeps = grouped.depsPerSource.get(node.id) ?? [];
    if (node.bodyScript && node.type === 'procedure') {
      processSpEdges(node, xmlDeps, ctx);
    } else {
      processNonSpEdges(node, xmlDeps, ctx);
    }
  }

  // Create virtual nodes for external refs (file URLs + cross-DB 3-part names)
  if (externalRefsEnabled) {
    createVirtualNodes(nodes, nodeIds, edges, edgeKeys, crossDbRegexRefs, grouped.crossDbMetaDeps, currentDatabase);
  }

  return { nodes, edges, stats, neighborPairs };
}

// ─── Virtual Node Helpers ───────────────────────────────────────────────────

/** Deterministic hash of a URL string → 8-char hex for stable virtual node IDs. */
function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

/** Extract last path segment from a URL (before query/fragment), max length. */
function lastUrlSegment(url: string, maxLen = 40): string {
  const cleaned = url.replace(/[?#].*$/, '');
  const segments = cleaned.split('/');
  const last = segments.pop() || segments.pop() || url;
  return last.length > maxLen ? last.slice(-maxLen) : last;
}

/**
 * Create virtual external nodes for file refs (OPENROWSET, COPY FROM, BULK FROM)
 * and cross-database 3-part name references.
 *
 * Context-aware 3-part resolution:
 * - DMV path: if db === currentDatabase → treat as local (same-DB self-reference)
 * - Dacpac path: if 2-part [schema].[object] exists in nodeIds → treat as local
 */
function createVirtualNodes(
  nodes: LineageNode[],
  nodeIds: Set<string>,
  edges: LineageEdge[],
  edgeKeys: Set<string>,
  crossDbRegexRefs: Map<string, { sources: string[]; targets: string[] }>,
  crossDbMetaDeps: Map<string, string[]>,
  currentDatabase?: string,
): void {
  // Budget: virtual nodes must not push total past maxNodes
  let budget = Math.max(0, DEFAULT_CONFIG.maxNodes - nodes.length);

  // A. File virtual nodes — OPENROWSET, COPY FROM, BULK FROM
  const fileNodeMap = new Map<string, string>(); // url → virtualNodeId
  const nodeSnapshot = [...nodes]; // iterate copy since we push new nodes
  for (const node of nodeSnapshot) {
    if (!node.bodyScript) continue;
    const refs = extractExternalRefs(node.bodyScript);
    for (const ref of refs) {
      let virtualId = fileNodeMap.get(ref.url);
      if (!virtualId) {
        const hash = hashUrl(ref.url);
        virtualId = `[__ext__].[${hash}]`;
        fileNodeMap.set(ref.url, virtualId);
        if (!nodeIds.has(virtualId)) {
          if (budget <= 0) continue;
          budget--;
          nodeIds.add(virtualId);
          nodes.push({
            id: virtualId, schema: '', name: lastUrlSegment(ref.url),
            fullName: virtualId, type: 'external', externalType: 'file',
            externalUrl: ref.url,
          });
        }
      }
      addEdge(edges, edgeKeys, virtualId, node.id, 'body'); // file → node (data source)
    }
  }

  // B. Cross-DB virtual nodes — context-aware resolution
  const isLocalRef = (db: string, localId: string): boolean => {
    if (currentDatabase && db.toLowerCase() === currentDatabase.toLowerCase()) return true;
    if (!currentDatabase && nodeIds.has(localId)) return true;
    return false;
  };

  const ensureCrossDbNode = (db: string, schema: string, object: string, crossDbId: string): boolean => {
    if (nodeIds.has(crossDbId)) return true;
    if (budget <= 0) return false;
    budget--;
    nodeIds.add(crossDbId);
    nodes.push({
      id: crossDbId, schema: '', name: `${schema}.${object}`,
      fullName: crossDbId, type: 'external', externalType: 'db',
      externalDatabase: db,
    });
    return true;
  };

  // B1. From regex parser (dot-separated "db.schema.object" strings)
  for (const [nodeId, { sources, targets }] of crossDbRegexRefs) {
    for (const ref of sources) {
      const parts = ref.split('.');
      if (parts.length !== 3) continue;
      const [db, schema, object] = parts;
      const localId = `[${schema}].[${object}]`;
      const crossDbId = `[${db}].[${schema}].[${object}]`;
      if (isLocalRef(db, localId)) continue;
      if (!ensureCrossDbNode(db, schema, object, crossDbId)) continue;
      addEdge(edges, edgeKeys, crossDbId, nodeId, 'body'); // cross-DB source → local node
    }
    for (const ref of targets) {
      const parts = ref.split('.');
      if (parts.length !== 3) continue;
      const [db, schema, object] = parts;
      const localId = `[${schema}].[${object}]`;
      const crossDbId = `[${db}].[${schema}].[${object}]`;
      if (isLocalRef(db, localId)) continue;
      if (!ensureCrossDbNode(db, schema, object, crossDbId)) continue;
      addEdge(edges, edgeKeys, nodeId, crossDbId, 'body'); // local node → cross-DB target
    }
  }

  // B2. From DMV metadata (bracketed 3-part "[db].[schema].[object]" strings)
  for (const [sourceId, rawTargets] of crossDbMetaDeps) {
    for (const rawTarget of rawTargets) {
      const parts = splitSqlName(rawTarget).map(p => stripBrackets(p));
      if (parts.length < 3) continue;
      const relevant = parts.length >= 4 ? parts.slice(-3) : parts;
      const [db, schema, object] = relevant;
      const localId = `[${schema}].[${object}]`.toLowerCase();
      const crossDbId = `[${db}].[${schema}].[${object}]`.toLowerCase();
      if (isLocalRef(db, localId)) {
        // Same-DB ref → add as local edge if node exists
        if (nodeIds.has(localId)) {
          addEdge(edges, edgeKeys, sourceId, localId, 'body');
        }
        continue;
      }
      if (!ensureCrossDbNode(db, schema, object, crossDbId)) continue;
      addEdge(edges, edgeKeys, sourceId, crossDbId, 'body');
    }
  }
}
