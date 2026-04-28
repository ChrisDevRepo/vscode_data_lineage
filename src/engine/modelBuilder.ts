/**
 * @module ModelBuilder
 * Provides a unified pipeline for constructing a `DatabaseModel` from extracted metadata.
 *
 * This module is used by both dacpac and DMV extractors to:
 * - Normalize schema and object names (handling case-insensitivity and bracketed identifiers).
 * - Resolve object-level dependencies into graph edges.
 * - Infer data flow direction (read vs. write) for stored procedures and views.
 * - Handle cross-schema and cross-database dependency resolution.
 * - Create virtual nodes for external references (files, external databases).
 * - Compute schema-level statistics and build search/neighbor indexes.
 */

import {
  DatabaseModel,
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
import { ColumnStore } from './columnStore';
import { SYSTEM_SCHEMAS, XML_METHODS, CLR_TYPE_METHODS } from './shared/sqlMetadata';

/**
 * Builds a complete DatabaseModel from extracted objects and dependencies.
 *
 * @param objects - Objects within the selected schemas.
 * @param deps - Extracted object dependencies.
 * @param allObjects - Full catalog for resolving cross-schema neighbors.
 * @param currentDatabase - Active database name for 3-part name resolution.
 * @param externalRefsEnabled - Whether to create virtual nodes for external systems.
 * @param maxNodes - Budget for total nodes to prevent browser crashes.
 * @returns A fully assembled DatabaseModel.
 */
export function buildModel(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
  currentDatabase?: string,
  externalRefsEnabled = true,
  maxNodes = DEFAULT_CONFIG.maxNodes,
  onDebugLog?: (msg: string) => void,
): DatabaseModel {
  const { nodes, edges, stats, neighborPairs } = buildNodesAndEdges(objects, deps, allObjects, currentDatabase, externalRefsEnabled, maxNodes, onDebugLog);

  // Unify schema display names to the first-seen casing to ensure consistency in the UI
  // across case-insensitive but distinct schema references (e.g., 'DBO' vs 'dbo').
  const schemaCanonical = new Map<string, string>();
  for (const node of nodes) {
    const k = schemaKey(node.schema);
    if (!schemaCanonical.has(k)) schemaCanonical.set(k, node.schema);
  }
  for (const node of nodes) {
    node.schema = schemaCanonical.get(schemaKey(node.schema))!;
  }

  const schemas = computeSchemas(nodes);
  const catalog = buildCatalog(allObjects ?? objects, schemaCanonical);

  const uniqueNodes: LineageNode[] = [];
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (!seenIds.has(node.id)) {
      seenIds.add(node.id);
      uniqueNodes.push(node);
    }
  }

  for (const node of uniqueNodes) {
    if (node.type === 'external' || node.externalType === 'file' || node.externalType === 'db') {
      catalog[node.id] = { schema: '', name: node.name, type: 'external', externalType: node.externalType };
    }
  }

  const neighborIndex = buildNeighborIndex(edges, neighborPairs);

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No objects found in data source.');
  } else if (uniqueNodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found.');
  }

  return {
    nodes: uniqueNodes, edges, schemas, catalog, neighborIndex,
    parseStats: stats,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Transfers heavy metadata (columns, DDL) from nodes into the provided ColumnStore.
 *
 * @param model - The database model to index.
 * @param store - Target ColumnStore instance.
 */
export function populateColumnStore(model: DatabaseModel, store: ColumnStore): void {
  for (const node of model.nodes) {
    if (node.columns && node.columns.length > 0) {
      store.setColumns(node.id, node.columns);
      node.hasColumns = true;
    }
    if (node.bodyScript) {
      store.setDdl(node.id, node.bodyScript);
      node.hasDdl = true;
    }
  }
}

/**
 * Constructs a display catalog for cross-schema resolution and neighbor discovery.
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

/**
 * Builds an O(1) neighbor index for efficient graph traversal and UI interaction.
 */
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

/**
 * Parses a full SQL name into schema and object components, respecting bracketed identifiers.
 */
export function parseName(fullName: string): { schema: string; objectName: string } {
  const parts = splitSqlName(fullName).map(p => stripBrackets(p));
  if (parts.length >= 2) {
    return { schema: parts[0], objectName: parts[1] };
  }
  return { schema: 'dbo', objectName: parts[0] };
}

/**
 * Normalizes a SQL name to a lowercase `[schema].[object]` format for consistent comparison.
 */
export function normalizeName(name: string): string {
  const parts = splitSqlName(name).map(p => stripBrackets(p));
  if (parts.length < 2) {
    return `[${parts[0] ?? ''}]`.toLowerCase();
  }
  if (parts.length === 2) {
    return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
  }
  if (parts.length >= 4) {
    return `[__external__].[${parts[parts.length - 1]}]`.toLowerCase();
  }
  // 3-part name: [db].[schema].[obj]
  return `[${parts[0]}].[${parts[1]}].[${parts[2]}]`.toLowerCase();
}

/**
 * Checks if a name contains a schema qualifier (e.g., 'dbo.Table' vs 'Table').
 * 
 * @param name - The SQL identifier to check.
 * @returns `true` if the name is schema-qualified.
 */
function isSchemaQualified(name: string): boolean {
  return stripBrackets(name).includes('.');
}

/**
 * Checks if a reference points to a known system schema (e.g., sys, INFORMATION_SCHEMA).
 * 
 * @param name - The SQL identifier to check.
 * @returns `true` if it belongs to a system schema.
 */
function isSystemRef(name: string): boolean {
  const schema = stripBrackets(name).split('.')[0].toLowerCase();
  return SYSTEM_SCHEMAS.has(schema);
}

/**
 * Heuristically determines if a script writes to a specific object.
 * 
 * @remarks
 * Uses a regex to look for INSERT/UPDATE/DELETE/MERGE/TRUNCATE keywords 
 * preceding the object name. Used to infer flow direction for SPs.
 * 
 * @param body - The SQL script body.
 * @param schema - Object schema.
 * @param name - Object name.
 * @returns 'write' if a write operation is detected, otherwise 'read'.
 */
function inferBodyDirection(body: string, schema: string, name: string): 'write' | 'read' {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\b(?:UPDATE|INSERT(?:\\s+INTO)?|DELETE(?:\\s+FROM)?|MERGE(?:\\s+INTO)?|TRUNCATE\\s+TABLE)\\s+` +
    `(?:TOP\\s*\\([^)]*\\)\\s*)?(?:\\[?${esc(schema)}\\]?\\.)?\\[?${esc(name)}\\]?`,
    'i',
  );
  return pattern.test(body) ? 'write' : 'read';
}

/**
 * Internal utility to add a directional edge to the lineage graph.
 * 
 * @param edges - The collection of edges to add to.
 * @param edgeKeys - A set used to deduplicate edges by their source→target key.
 * @param source - Source node ID.
 * @param target - Target node ID.
 * @param type - The edge type (body-read, write, or exec).
 */
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

/**
 * Computes architectural schema metrics from the resolved node list.
 * 
 * @param nodes - All discovered lineage nodes.
 * @returns An array of schema info objects, sorted by node count.
 */
export function computeSchemas(nodes: LineageNode[]): SchemaInfo[] {
  const map = new Map<string, SchemaInfo>();
  for (const node of nodes) {
    if (node.externalType === 'file' || node.externalType === 'db') continue;
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

/**
 * Builds the primary list of LineageNodes from extracted object metadata.
 * 
 * @param objects - Metadata for objects discovered in the active scope.
 * @returns The assembled nodes and their unique IDs.
 */
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

/**
 * Builds the full cross-schema catalog for Phase 2 dependency resolution.
 * 
 * @param allObjects - The full database catalog (optional).
 * @returns Metadata for all objects available for neighbor resolution.
 */
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

/**
 * Classification structure for dependencies found during extraction.
 */
interface GroupedDeps {
  /** Resolved local dependencies. */
  depsPerSource: Map<string, string[]>;
  /** Dependencies that exist in the catalog but are outside the active schema filter. */
  crossSchemaDepsForNode: Map<string, string[]>;
  /** Dependencies that were schema-qualified but not found in any catalog. */
  unresolvableDepsForNode: Map<string, string[]>;
  /** Pairs where the neighbor depends on an in-scope node. */
  inboundNeighborPairs: Array<{ source: string; target: string }>;
  /** Dependencies that appear to target another database (3-part names). */
  crossDbMetaDeps: Map<string, string[]>;
}

/**
 * Categorizes dependencies based on their visibility and resolution status in the current catalog.
 * 
 * @param deps - Raw extracted dependencies.
 * @param nodeIds - Nodes in the active filtered scope.
 * @param allNodeIds - All nodes in the database catalog.
 * @returns A grouped collection of dependencies ready for graph processing.
 */
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

/**
 * Shared context for processing dependency edges per-node.
 */
interface EdgeContext {
  /** IDs of all nodes in the current filtered scope. */
  nodeIds: Set<string>;
  /** IDs of all nodes in the database catalog. */
  allNodeIds: Set<string>;
  /** Metadata lookup for nodes in the full catalog. */
  allObjectMeta: Map<string, { schema: string; name: string; type: ObjectType }>;
  /** Lookup map for nodes in the current filtered scope. */
  nodeMap: Map<string, LineageNode>;
  /** The collection of graph edges being built. */
  edges: LineageEdge[];
  /** Set used to deduplicate edges. */
  edgeKeys: Set<string>;
  /** Performance and diagnostic statistics. */
  stats: ParseStats;
  /** Pairs to be added to the O(1) neighbor index. */
  neighborPairs: Array<{ source: string; target: string }>;
  /** The categorized extraction results. */
  grouped: GroupedDeps;
  /** Tracked cross-DB references discovered during regex analysis. */
  crossDbRegexRefs: Map<string, { sources: string[]; targets: string[] }>;
}

/**
 * Resolves regex-parsed references into graph edges or neighbor index pairs.
 * 
 * @param refs - Raw SQL names found in script body.
 * @param sourceId - ID of the node being parsed.
 * @param spLabel - Human-readable name for logging.
 * @param direction - Edge directionality (inward vs outward).
 * @param edgeType - The semantic type of connection (body vs exec).
 * @param ctx - Shared edge creation context.
 * @param outRefs - Collection for successful resolutions.
 * @param skipped - Collection for system/unqualified skips.
 * @param unrelated - Collection for unresolvable drops.
 * @returns The number of successfully resolved edges.
 */
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

/**
 * Orchestrates edge creation for non-procedural nodes (tables, views, functions).
 * 
 * @param node - The node to process.
 * @param xmlDeps - Dependencies declared in the XML model (DACPAC only).
 * @param ctx - Shared edge context.
 */
function processNonSpEdges(node: LineageNode, xmlDeps: string[], ctx: EdgeContext): void {
  const sourceId = node.id;

  for (const depId of xmlDeps) {
    addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, 'body');
  }
  for (const csDepId of ctx.grouped.crossSchemaDepsForNode.get(sourceId) ?? []) {
    ctx.neighborPairs.push({ source: csDepId, target: sourceId });
  }

  if (node.bodyScript && (node.type === 'view' || node.type === 'function')) {
    const parsed = parseSqlBody(node.bodyScript);
    const spLabel = `${node.schema}.${node.name}`;
    const spInRefs: string[] = [];
    const spUnrelated: string[] = [];
    const spSkipped: string[] = [];

    // Track cross-DB sources as "In" references for views/functions
    for (const r of parsed.crossDbSources) {
      spInRefs.push(r);
    }

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
        spInRefs.push(n ? `${n.schema}.${n.name}` : dep);
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

    if (spInRefs.length > 0 || spUnrelated.length > 0 || spSkipped.length > 0) {
      ctx.stats.spDetails.push({
        name: spLabel, inCount: spInRefs.length, outCount: 0,
        ...(spInRefs.length > 0 && { inRefs: spInRefs }),
        unrelated: spUnrelated,
        ...(spSkipped.length > 0 && { skippedRefs: spSkipped }),
      });
    }
  }
}

/**
 * Orchestrates edge creation for stored procedures using regex-based script analysis.
 * 
 * @param node - The node to process.
 * @param xmlDeps - XML-declared dependencies.
 * @param ctx - Shared edge context.
 */
function processSpEdges(node: LineageNode, xmlDeps: string[], ctx: EdgeContext): void {
  const sourceId = node.id;
  const parsed = parseSqlBody(node.bodyScript!);
  const spLabel = `${node.schema}.${node.name}`;
  const spInRefs: string[] = [];
  const spOutRefs: string[] = [];
  const spUnrelated: string[] = [];
  const spSkipped: string[] = [];

  if (parsed.crossDbSources.length > 0 || parsed.crossDbTargets.length > 0) {
    ctx.crossDbRegexRefs.set(sourceId, { sources: parsed.crossDbSources, targets: parsed.crossDbTargets });
  }

  const outboundIds = new Set<string>();
  for (const dep of parsed.targets) {
    if (isSchemaQualified(dep) && !isSystemRef(dep)) outboundIds.add(normalizeName(dep));
  }
  for (const dep of parsed.execCalls) {
    if (isSchemaQualified(dep) && !isSystemRef(dep)) outboundIds.add(normalizeName(dep));
  }

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

  for (const rawName of ctx.grouped.unresolvableDepsForNode.get(sourceId) ?? []) {
    spUnrelated.push(rawName);
    ctx.stats.droppedRefs.push(`${spLabel} → ${rawName}`);
  }

  const spIn = processRegexRefs(parsed.sources, sourceId, spLabel, 'in', 'body', ctx, spInRefs, spSkipped, spUnrelated) + parsed.crossDbSources.length;
  const spOut =
    processRegexRefs(parsed.targets, sourceId, spLabel, 'out', 'body', ctx, spOutRefs, spSkipped, spUnrelated) +
    processRegexRefs(parsed.execCalls, sourceId, spLabel, 'out', 'exec', ctx, spOutRefs, spSkipped, spUnrelated) +
    parsed.crossDbTargets.length;

  for (const r of parsed.crossDbSources) spInRefs.push(r);
  for (const r of parsed.crossDbTargets) spOutRefs.push(r);

  ctx.stats.spDetails.push({
    name: spLabel, inCount: spIn, outCount: spOut,
    ...(spInRefs.length > 0 && { inRefs: spInRefs }),
    ...(spOutRefs.length > 0 && { outRefs: spOutRefs }),
    unrelated: spUnrelated,
    ...(spSkipped.length > 0 && { skippedRefs: spSkipped }),
  });
}

/**
 * Primary internal builder for the node and edge lists.
 * 
 * @param objects - Objects discoverd in scope.
 * @param deps - Extracted object-level dependencies.
 * @param allObjects - Full database catalog.
 * @param currentDatabase - Active database name.
 * @param externalRefsEnabled - Whether to create virtual nodes for external systems.
 * @param maxNodes - Budget for total nodes.
 * @returns Assembled nodes, edges, statistics, and neighbor index pairs.
 */
function buildNodesAndEdges(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
  currentDatabase?: string,
  externalRefsEnabled = true,
  maxNodes = DEFAULT_CONFIG.maxNodes,
  onDebugLog?: (msg: string) => void,
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

  if (onDebugLog) onDebugLog(`Starting processing of ${nodes.length} nodes...`);
  let scriptedCount = 0;

  for (const node of nodes) {
    const xmlDeps = grouped.depsPerSource.get(node.id) ?? [];
    if (node.bodyScript && node.type === 'procedure') {
      scriptedCount++;
      processSpEdges(node, xmlDeps, ctx);
    } else {
      if (node.bodyScript && (node.type === 'view' || node.type === 'function')) {
        scriptedCount++;
      }
      processNonSpEdges(node, xmlDeps, ctx);
    }
  }

  if (onDebugLog) onDebugLog(`Finished processing. Scripted objects found: ${scriptedCount}`);

  if (externalRefsEnabled) {
    createVirtualNodes(nodes, nodeIds, edges, edgeKeys, crossDbRegexRefs, grouped.crossDbMetaDeps, currentDatabase, maxNodes);
  }

  // Structural invariant: views and functions are read-only consumers and cannot DML any object.
  // Drop any view/function → external edge that may have leaked through (defense in depth against
  // future regressions in parse rules, metadata loops, or cross-DB resolution).
  const typeById = new Map(nodes.map(n => [n.id, n.type]));
  const sanitized: LineageEdge[] = [];
  for (const e of edges) {
    const src = typeById.get(e.source);
    const tgt = typeById.get(e.target);
    if ((src === 'view' || src === 'function') && tgt === 'external') continue;
    sanitized.push(e);
  }

  return { nodes, edges: sanitized, stats, neighborPairs };
}

/** 
 * Deterministic hash of a URL string → 8-char hex for stable virtual node IDs. 
 * 
 * @param url - The URL to hash.
 * @returns An 8-character hex string.
 */
function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

/** 
 * Extract last path segment from a URL, max length 40. 
 * 
 * @param url - The URL to parse.
 * @param maxLen - Maximum character length.
 * @returns The last segment of the path.
 */
function lastUrlSegment(url: string, maxLen = 40): string {
  const cleaned = url.replace(/[?#].*$/, '');
  const segments = cleaned.split('/');
  const last = segments.pop() || segments.pop() || url;
  return last.length > maxLen ? last.slice(-maxLen) : last;
}

/**
 * Creates virtual nodes for external systems like cloud files or remote databases.
 * 
 * @param nodes - Node collection to add to.
 * @param nodeIds - ID set to add to.
 * @param edges - Edge collection.
 * @param edgeKeys - Edge deduplication set.
 * @param crossDbRegexRefs - Discovered 3-part references from regex.
 * @param crossDbMetaDeps - Discovered 3-part references from model metadata.
 * @param currentDatabase - Active database name.
 * @param maxNodes - Total node budget.
 */
function createVirtualNodes(
  nodes: LineageNode[],
  nodeIds: Set<string>,
  edges: LineageEdge[],
  edgeKeys: Set<string>,
  crossDbRegexRefs: Map<string, { sources: string[]; targets: string[] }>,
  crossDbMetaDeps: Map<string, string[]>,
  currentDatabase?: string,
  maxNodes = DEFAULT_CONFIG.maxNodes,
): void {
  let budget = Math.max(0, maxNodes - nodes.length);

  const fileNodeMap = new Map<string, string>();
  const nodeSnapshot = [...nodes];
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
      addEdge(edges, edgeKeys, virtualId, node.id, 'body');
    }
  }

  const isLocalRef = (db: string, localId: string): boolean => {
    const normDb = stripBrackets(db).toLowerCase();
    const normLocal = normalizeName(localId);
    if (currentDatabase && normDb === stripBrackets(currentDatabase).toLowerCase()) return true;
    if (!currentDatabase && nodeIds.has(normLocal)) return true;
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

  for (const [nodeId, { sources, targets }] of crossDbRegexRefs) {
    for (const ref of sources) {
      const parts = ref.split('.');
      if (parts.length !== 3) continue;
      const [db, schema, object] = parts;
      const localId = `[${schema}].[${object}]`;
      const crossDbId = normalizeName(`${db}.${schema}.${object}`);
      if (isLocalRef(db, localId)) continue;
      if (!ensureCrossDbNode(db, schema, object, crossDbId)) continue;
      addEdge(edges, edgeKeys, crossDbId, nodeId, 'body');
    }
    const node = nodeMap.get(nodeId);
    const canWrite = node?.type === 'procedure';
    if (canWrite) {
      for (const ref of targets) {
        const parts = ref.split('.');
        if (parts.length !== 3) continue;
        const [db, schema, object] = parts;
        const localId = `[${schema}].[${object}]`;
        const crossDbId = normalizeName(`${db}.${schema}.${object}`);
        if (isLocalRef(db, localId)) continue;
        if (!ensureCrossDbNode(db, schema, object, crossDbId)) continue;
        addEdge(edges, edgeKeys, nodeId, crossDbId, 'body');
      }
    }
  }

  // XML metadata carries no direction info. Mirror the local-XML convention:
  //   non-SP source → read direction (target → source)
  //   SP source     → infer from body (matches processSpEdges at line 587-595)
  // Without this, every cross-DB metaDep would emit a write edge — colliding with the
  // direction-aware regex pass above and producing spurious bidirectional ⇄ glyphs.
  const metaDepsNodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const [sourceId, rawTargets] of crossDbMetaDeps) {
    const sourceNode = metaDepsNodeMap.get(sourceId);
    for (const rawTarget of rawTargets) {
      const parts = splitSqlName(rawTarget).map(p => stripBrackets(p));
      if (parts.length < 3) continue;
      const pertinentParts = parts.length >= 4 ? parts.slice(-3) : parts;
      const [db, schema, object] = pertinentParts;
      if (CLR_TYPE_METHODS.has(object.toLowerCase())) continue;
      const localId = `[${schema}].[${object}]`;
      const crossDbId = normalizeName(`${db}.${schema}.${object}`);
      const isWrite = sourceNode?.type === 'procedure' && !!sourceNode.bodyScript
        && inferBodyDirection(sourceNode.bodyScript, schema, object) === 'write';
      if (isLocalRef(db, localId)) {
        const normLocal = normalizeName(localId);
        if (nodeIds.has(normLocal)) {
          if (isWrite) addEdge(edges, edgeKeys, sourceId, normLocal, 'body');
          else         addEdge(edges, edgeKeys, normLocal, sourceId, 'body');
        }
        continue;
      }
      if (!ensureCrossDbNode(db, schema, object, crossDbId)) continue;
      if (isWrite) addEdge(edges, edgeKeys, sourceId, crossDbId, 'body');
      else         addEdge(edges, edgeKeys, crossDbId, sourceId, 'body');
    }
  }
}
