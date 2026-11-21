/**
 * @module ModelBuilder
 * The pipeline both dacpac and DMV extractors use to build a `DatabaseModel`: normalizes schema and
 * object names (case-insensitivity, bracketed identifiers), resolves dependencies into edges,
 * infers read vs. write direction for procedures and views, resolves cross-schema and
 * cross-database references, creates virtual nodes for external references, and computes schema
 * statistics and neighbor indexes.
 */

import { createHash } from 'node:crypto';
import {
  DatabaseModel,
  LineageNode,
  LineageEdge,
  ObjectType,
  ParseStats,
  ExtractedObject,
  ExtractedDependency,
  CatalogEntry,
  NeighborIndex,
} from './types';
import { parseSqlBody, extractExternalRefs } from './sqlBodyParser';
import { quoteIdentifier, stripBrackets, splitSqlName, schemaKey } from '../utils/sql';
import { trunc, sanitizeForLog } from '../utils/log';
import { ColumnStore } from './columnStore';
import { SYSTEM_SCHEMAS, XML_METHODS, CLR_TYPE_METHODS } from './shared/sqlMetadata';
import { normalizeName } from './shared/sqlIdentifier';
import { computeSchemas } from './shared/modelSchemas';

export { normalizeName };

/** Number of scripted bodies to per-rule trace before falling back to aggregate stats only. */
const PARSE_TRACE_BUDGET = 5;

/**
 * Builds a per-rule trace callback for the next sampled body and decrements
 * `ctx.parseTrace.budget`; `undefined` when the sampling budget is spent. Emits a header `Trace
 * [schema.name] sql=<preview>` once per traced body, then a line per rule that contributed a new
 * ref, routed to the `[Parse]` category so DBAs can verify YAML rule firing without instrumenting
 * code.
 */
function makeParseTraceCallback(
  node: LineageNode,
  ctx: EdgeContext,
): ((ruleName: string, category: string, added: number) => void) | undefined {
  if (!ctx.parseTrace || ctx.parseTrace.budget <= 0) return undefined;
  ctx.parseTrace.budget--;
  const label = `${node.schema}.${node.name}`;
  const sqlPreview = trunc(sanitizeForLog((node.bodyScript ?? '').trim()), 200);
  ctx.parseTrace.emit(`Trace [${label}] sql=${sqlPreview}`);
  return (ruleName, category, added) => {
    ctx.parseTrace!.emit(`Trace [${label}]   rule=${ruleName} cat=${category} +${added} refs`);
  };
}

/**
 * Builds a complete DatabaseModel from extracted objects and dependencies.
 *
 * @param allObjects - Catalog of all known objects in scope.
 * @param currentDatabase - Current database name for local-object resolution.
 * @param externalRefsEnabled - Whether external reference nodes should be emitted.
 * @param identifierCaseSensitive - Checked catalog comparison policy; missing metadata stays CI.
 */
export function buildModel(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
  currentDatabase?: string,
  externalRefsEnabled = true,
  onDebugLog?: (msg: string) => void,
  identifierCaseSensitive = false,
): DatabaseModel {
  const { nodes, edges, stats, neighborPairs } = buildNodesAndEdges(objects, deps, allObjects, currentDatabase, externalRefsEnabled, onDebugLog, identifierCaseSensitive);

  const schemaCanonical = new Map<string, string>();
  for (const node of nodes) {
    const k = schemaKey(node.schema, identifierCaseSensitive);
    if (!schemaCanonical.has(k)) schemaCanonical.set(k, node.schema);
  }
  for (const node of nodes) {
    node.schema = schemaCanonical.get(schemaKey(node.schema, identifierCaseSensitive))!;
  }

  const schemas = computeSchemas(nodes, identifierCaseSensitive);
  const catalog = buildCatalog(allObjects ?? objects, schemaCanonical, identifierCaseSensitive);

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
    ...(identifierCaseSensitive && { identifierCaseSensitive }),
    parseStats: stats,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Transfers heavy metadata (columns, DDL) from nodes into the ColumnStore. */
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

/** Constructs a display catalog for cross-schema resolution and neighbor discovery. */
function buildCatalog(
  allObjects: ExtractedObject[],
  schemaCanonical: Map<string, string>,
  identifierCaseSensitive: boolean,
): Record<string, CatalogEntry> {
  const catalog: Record<string, CatalogEntry> = {};
  for (const obj of allObjects) {
    const { schema, objectName } = parseName(obj.fullName);
    const displaySchema = schemaCanonical.get(schemaKey(schema, identifierCaseSensitive)) ?? schema;
    catalog[normalizeName(obj.fullName, identifierCaseSensitive)] = {
      schema: displaySchema, name: objectName, type: obj.type,
      ...(obj.externalType && { externalType: obj.externalType }),
    };
  }
  return catalog;
}

/** Builds an O(1) neighbor index for graph traversal and UI interaction. */
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

/** Parses a full SQL name into schema and object, honoring brackets; unqualified means `dbo`. */
export function parseName(fullName: string): { schema: string; objectName: string } {
  const parts = splitSqlName(fullName).map(p => stripBrackets(p));
  if (parts.length >= 2) {
    return { schema: parts[0], objectName: parts[1] };
  }
  return { schema: 'dbo', objectName: parts[0] };
}

/** Whether a name has a schema qualifier ('dbo.Table' vs 'Table'). */
function isSchemaQualified(name: string): boolean {
  return stripBrackets(name).includes('.');
}

/** Whether a reference points to a known system schema (e.g. sys, INFORMATION_SCHEMA). */
function isSystemRef(name: string, ctx?: EdgeContext): boolean {
  if (ctx?.identifierCaseSensitive && (ctx.nodeIds.has(name) || ctx.allNodeIds.has(name))) return false;
  const schema = stripBrackets(splitSqlName(name)[0] ?? '').toLowerCase();
  return SYSTEM_SCHEMAS.has(schema);
}

/**
 * Heuristically classifies how a script mutates a specific object, looking for
 * INSERT/UPDATE/DELETE/MERGE/TRUNCATE keywords preceding the object name; used to infer flow
 * direction for SPs.
 *
 * @returns `'delete'` when every matched mutation is a DELETE or TRUNCATE (rows removed, no column
 *   data supplied) and no INSERT, UPDATE or MERGE names the object by a three-part name; `'write'`
 *   when any matched mutation is an INSERT, UPDATE or MERGE; otherwise `'read'`.
 */
function classifyBodyMutation(body: string, schema: string, name: string, identifierCaseSensitive = false): 'write' | 'delete' | 'read' {
  const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identifier = (value: string) =>
    `(?:${esc(quoteIdentifier(value))}|${esc(value)}(?![\\p{L}\\p{N}_@$#]))`;
  const pattern = new RegExp(
    `\\b(UPDATE|INSERT|DELETE|MERGE|TRUNCATE\\s+TABLE)\\s+` +
    `(?:TOP\\s*\\([^)]*\\)\\s*(?:PERCENT\\s+)?)?(?:(?:INTO|FROM)\\s+)?(?:(${identifier(schema)})\\s*\\.\\s*)?(${identifier(name)})(?!\\s*\\.)`,
    'giu',
  );
  let deleted = false;
  for (const match of body.matchAll(pattern)) {
    if ((match[2] === undefined || schemaKey(stripBrackets(match[2]), identifierCaseSensitive) === schemaKey(schema, identifierCaseSensitive))
      && schemaKey(stripBrackets(match[3]), identifierCaseSensitive) === schemaKey(name, identifierCaseSensitive)) {
      if (!/^(?:DELETE|TRUNCATE)/iu.test(match[1])) return 'write';
      deleted = true;
    }
  }
  if (!deleted) return 'read';
  const threePart = new RegExp(
    `\\b(?:UPDATE|INSERT(?:\\s+INTO)?|MERGE(?:\\s+INTO)?)\\s+(?:\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_@$#]*)\\s*\\.\\s*${identifier(schema)}\\s*\\.\\s*${identifier(name)}`,
    'iu',
  );
  return threePart.test(body) ? 'write' : 'delete';
}

/**
 * Heuristically determines if a script writes to a specific object: `'write'` when the SQL mutates
 * it (DELETE and TRUNCATE included), else `'read'`.
 */
function inferBodyDirection(body: string, schema: string, name: string, identifierCaseSensitive = false): 'write' | 'read' {
  return classifyBodyMutation(body, schema, name, identifierCaseSensitive) === 'read' ? 'read' : 'write';
}

/**
 * Adds a directional edge to the lineage graph, deduplicated by the source→target key in
 * `edgeKeys`.
 *
 * @param deleteOnly - Marks a write edge whose every mutation is a DELETE or TRUNCATE.
 */
function addEdge(
  edges: LineageEdge[],
  edgeKeys: Set<string>,
  source: string,
  target: string,
  type: 'body' | 'exec',
  deleteOnly = false,
) {
  const key = `${source}→${target}`;
  if (!edgeKeys.has(key)) {
    edgeKeys.add(key);
    edges.push(deleteOnly ? { source, target, type, deleteOnly: true } : { source, target, type });
  }
}

function buildNodeList(objects: ExtractedObject[], identifierCaseSensitive: boolean): { nodes: LineageNode[]; nodeIds: Set<string> } {
  const nodes: LineageNode[] = [];
  const nodeIds = new Set<string>();

  for (const obj of objects) {
    const { schema, objectName } = parseName(obj.fullName);
    const id = normalizeName(obj.fullName, identifierCaseSensitive);

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

/** Builds the full cross-schema catalog for Phase 2 dependency resolution. */
function buildFullCatalog(allObjects: ExtractedObject[] | undefined, identifierCaseSensitive: boolean): {
  allNodeIds: Set<string>;
  allObjectMeta: Map<string, { schema: string; name: string; type: ObjectType }>;
} {
  const allNodeIds = new Set<string>();
  const allObjectMeta = new Map<string, { schema: string; name: string; type: ObjectType }>();
  if (allObjects) {
    for (const obj of allObjects) {
      const id = normalizeName(obj.fullName, identifierCaseSensitive);
      allNodeIds.add(id);
      const { schema, objectName } = parseName(obj.fullName);
      allObjectMeta.set(id, { schema, name: objectName, type: obj.type });
    }
  }
  return { allNodeIds, allObjectMeta };
}

/** Dependencies grouped by visibility and resolution status. */
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

/** Categorizes dependencies by visibility and resolution status in the current catalog. */
function groupDependencies(
  deps: ExtractedDependency[],
  nodeIds: Set<string>,
  allNodeIds: Set<string>,
  identifierCaseSensitive: boolean,
): GroupedDeps {
  const depsPerSource = new Map<string, string[]>();
  const crossSchemaDepsForNode = new Map<string, string[]>();
  const unresolvableDepsForNode = new Map<string, string[]>();
  const inboundNeighborPairs: Array<{ source: string; target: string }> = [];
  const crossDbMetaDeps = new Map<string, string[]>();

  for (const dep of deps) {
    const targetParts = splitSqlName(dep.targetName);
    if (targetParts.length >= 3) {
      const sourceId = normalizeName(dep.sourceName, identifierCaseSensitive);
      if (nodeIds.has(sourceId)) {
        if (!crossDbMetaDeps.has(sourceId)) crossDbMetaDeps.set(sourceId, []);
        crossDbMetaDeps.get(sourceId)!.push(dep.targetName);
      }
      continue;
    }

    const sourceId = normalizeName(dep.sourceName, identifierCaseSensitive);
    const targetId = normalizeName(dep.targetName, identifierCaseSensitive);

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

/** Shared context for processing dependency edges per node. */
interface EdgeContext {
  identifierCaseSensitive: boolean;
  /** IDs of all nodes in the current filtered scope. */
  nodeIds: Set<string>;
  /** IDs of all nodes in the database catalog. */
  allNodeIds: Set<string>;
  /** Metadata lookup for nodes in the full catalog. */
  allObjectMeta: Map<string, { schema: string; name: string; type: ObjectType }>;
  /** Lookup map for nodes in the current filtered scope. */
  nodeMap: Map<string, LineageNode>;
  edges: LineageEdge[];
  /** Set used to deduplicate edges. */
  edgeKeys: Set<string>;
  stats: ParseStats;
  /** Pairs to be added to the O(1) neighbor index. */
  neighborPairs: Array<{ source: string; target: string }>;
  grouped: GroupedDeps;
  /** Tracked cross-DB references discovered during regex analysis. */
  crossDbRegexRefs: Map<string, { sources: string[]; targets: string[] }>;
  /** Optional sample-mode parse-rule trace; bounded by `budget` to avoid log flood. */
  parseTrace?: ParseTraceCtx;
}

/**
 * Sample-mode parse-rule trace state: each firing rule of the first `budget` scripted bodies
 * through `parseSqlBody` is logged via `emit`. Set `budget` to a representative sample size (e.g.
 * 5).
 */
interface ParseTraceCtx {
  /** Remaining bodies to trace before tracing stops. */
  budget: number;
  /** Receiver of the formatted log line; callers route it to `Logger.create(ch, 'Parse').debug`. */
  emit: (msg: string) => void;
}

/**
 * Resolves regex-parsed references into graph edges or neighbor index pairs.
 *
 * @param spLabel - Human-readable name for logging.
 * @param outRefs - Collection for successful resolutions.
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
  unrelated: string[],
): number {
  let count = 0;
  for (const dep of refs) {
    if (!isSchemaQualified(dep)) continue;
    if (isSystemRef(dep, ctx)) continue;
    const depId = dep;
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

/** Edges for non-procedural nodes (tables, views, functions); `xmlDeps` from the DACPAC XML. */
function processNonSpEdges(node: LineageNode, xmlDeps: string[], ctx: EdgeContext): void {
  const sourceId = node.id;

  for (const depId of xmlDeps) {
    addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, 'body');
  }
  for (const csDepId of ctx.grouped.crossSchemaDepsForNode.get(sourceId) ?? []) {
    ctx.neighborPairs.push({ source: csDepId, target: sourceId });
  }

  if (node.bodyScript && (node.type === 'view' || node.type === 'function')) {
    const onRuleFire = makeParseTraceCallback(node, ctx);
    const parsed = parseSqlBody(node.bodyScript, onRuleFire, ctx.identifierCaseSensitive);
    const spLabel = `${node.schema}.${node.name}`;
    const spInRefs: string[] = [];
    const spUnrelated: string[] = [];

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
      if (!isSchemaQualified(dep)) continue;
      if (isSystemRef(dep, ctx)) continue;
      const depId = dep;
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
        if (XML_METHODS.has(objPart)) continue;
        spUnrelated.push(dep);
        ctx.stats.droppedRefs.push(`${spLabel} → ${dep}`);
      }
    }

    for (const rawName of ctx.grouped.unresolvableDepsForNode.get(sourceId) ?? []) {
      spUnrelated.push(rawName);
      ctx.stats.droppedRefs.push(`${spLabel} → ${rawName}`);
    }

    if (spInRefs.length > 0 || spUnrelated.length > 0) {
      ctx.stats.spDetails.push({
        name: spLabel, inCount: spInRefs.length, outCount: 0,
        ...(spInRefs.length > 0 && { inRefs: spInRefs }),
        unrelated: spUnrelated,
      });
    }
  }
}

/** Edges for stored procedures from regex script analysis plus XML-declared dependencies. */
function processSpEdges(node: LineageNode, xmlDeps: string[], ctx: EdgeContext): void {
  const sourceId = node.id;
  const onRuleFire = makeParseTraceCallback(node, ctx);
  const parsed = parseSqlBody(node.bodyScript!, onRuleFire, ctx.identifierCaseSensitive);
  const spLabel = `${node.schema}.${node.name}`;
  const spInRefs: string[] = [];
  const spOutRefs: string[] = [];
  const spUnrelated: string[] = [];

  if (parsed.crossDbSources.length > 0 || parsed.crossDbTargets.length > 0) {
    ctx.crossDbRegexRefs.set(sourceId, { sources: parsed.crossDbSources, targets: parsed.crossDbTargets });
  }

  const outboundIds = new Set<string>();
  for (const dep of parsed.targets) {
    if (isSchemaQualified(dep) && !isSystemRef(dep, ctx)) outboundIds.add(dep);
  }
  for (const dep of parsed.execCalls) {
    if (isSchemaQualified(dep) && !isSystemRef(dep, ctx)) outboundIds.add(dep);
  }

  for (const depId of xmlDeps) {
    if (!outboundIds.has(depId)) {
      const depNode = ctx.nodeMap.get(depId);
      if (depNode?.type === 'procedure') {
        addEdge(ctx.edges, ctx.edgeKeys, sourceId, depId, 'exec');
      } else if (
        (depNode?.type === 'table' || depNode?.type === 'external') &&
        node.bodyScript
      ) {
        const mutation = classifyBodyMutation(node.bodyScript, depNode.schema, depNode.name, ctx.identifierCaseSensitive);
        if (mutation === 'read') addEdge(ctx.edges, ctx.edgeKeys, depId, sourceId, 'body');
        else addEdge(ctx.edges, ctx.edgeKeys, sourceId, depId, 'body', mutation === 'delete');
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
        inferBodyDirection(node.bodyScript, meta.schema, meta.name, ctx.identifierCaseSensitive) === 'write'
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

  const spIn = processRegexRefs(parsed.sources, sourceId, spLabel, 'in', 'body', ctx, spInRefs, spUnrelated) + parsed.crossDbSources.length;
  const spOut =
    processRegexRefs(parsed.targets, sourceId, spLabel, 'out', 'body', ctx, spOutRefs, spUnrelated) +
    processRegexRefs(parsed.execCalls, sourceId, spLabel, 'out', 'exec', ctx, spOutRefs, spUnrelated) +
    parsed.crossDbTargets.length;

  for (const r of parsed.crossDbSources) spInRefs.push(r);
  for (const r of parsed.crossDbTargets) spOutRefs.push(r);

  ctx.stats.spDetails.push({
    name: spLabel, inCount: spIn, outCount: spOut,
    ...(spInRefs.length > 0 && { inRefs: spInRefs }),
    ...(spOutRefs.length > 0 && { outRefs: spOutRefs }),
    unrelated: spUnrelated,
  });
}

/**
 * Primary internal builder for the node and edge lists.
 *
 * @param onDebugLog - Optional sink for sampled parser diagnostics.
 * @returns Nodes, edges, statistics and neighbor index pairs.
 */
function buildNodesAndEdges(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
  currentDatabase?: string,
  externalRefsEnabled = true,
  onDebugLog?: (msg: string) => void,
  identifierCaseSensitive: boolean = false,
): { nodes: LineageNode[]; edges: LineageEdge[]; stats: ParseStats; neighborPairs: Array<{ source: string; target: string }> } {
  const { nodes, nodeIds } = buildNodeList(objects, identifierCaseSensitive);
  const { allNodeIds, allObjectMeta } = buildFullCatalog(allObjects, identifierCaseSensitive);
  const grouped = groupDependencies(deps, nodeIds, allNodeIds, identifierCaseSensitive);

  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();
  const stats: ParseStats = { parsedRefs: 0, resolvedEdges: 0, droppedRefs: [], spDetails: [] };
  const neighborPairs: Array<{ source: string; target: string }> = [...grouped.inboundNeighborPairs];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const crossDbRegexRefs = new Map<string, { sources: string[]; targets: string[] }>();

  const parseTrace: ParseTraceCtx | undefined = onDebugLog
    ? { budget: PARSE_TRACE_BUDGET, emit: onDebugLog }
    : undefined;
  const traceStartBudget = parseTrace?.budget ?? 0;

  const ctx: EdgeContext = { identifierCaseSensitive, nodeIds, allNodeIds, allObjectMeta, nodeMap, edges, edgeKeys, stats, neighborPairs, grouped, crossDbRegexRefs, parseTrace };

  if (onDebugLog) onDebugLog(`Starting processing of ${nodes.length} nodes...`);
  let scriptedCount = 0;

  for (const node of nodes) {
    const xmlDeps = grouped.depsPerSource.get(node.id) ?? [];
    if (!node.bodyScript && node.type === 'procedure') {
      node.definitionUnreadable = true;
      (stats.unreadableDefinitions ??= []).push(node.fullName);
      continue;
    }
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
  if (parseTrace && traceStartBudget > 0 && parseTrace.budget === 0) {
    onDebugLog!(`Parse trace sample limit reached (${traceStartBudget} bodies) — see [Parse] aggregate stats for full counts`);
  }

  createVirtualNodes(nodes, nodeIds, edges, edgeKeys, crossDbRegexRefs, grouped.crossDbMetaDeps, currentDatabase, identifierCaseSensitive, externalRefsEnabled);

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
 * Stable virtual node ID of a URL: SHA-256 over its UTF-16 code units, so distinct URLs never share
 * an ID and an unpaired surrogate stays distinct (UTF-8 would turn it into U+FFFD).
 */
function hashUrl(url: string): string {
  return createHash('sha256').update(url, 'utf16le').digest('hex');
}

/** Extracts the last path segment of a URL, capped at `maxLen` characters. */
function lastUrlSegment(url: string, maxLen = 40): string {
  const cleaned = url.replace(/[?#].*$/, '');
  const segments = cleaned.split('/');
  const last = segments.pop() || segments.pop() || url;
  return last.length > maxLen ? last.slice(-maxLen) : last;
}

/**
 * Creates virtual nodes for external systems such as cloud files or remote databases. Every
 * distinct external reference becomes a node and edge; there is no admission budget. A caller that
 * must honor `dataLineageViz.maxNodes` checks the assembled model afterward with
 * {@link checkObjectLimit} in `modelFilters.ts`.
 *
 * @param crossDbRegexRefs - 3-part references found by regex.
 * @param crossDbMetaDeps - 3-part references found in model metadata.
 * @param externalRefsEnabled - When false, only references to the current database become local
 *   edges.
 */
function createVirtualNodes(
  nodes: LineageNode[],
  nodeIds: Set<string>,
  edges: LineageEdge[],
  edgeKeys: Set<string>,
  crossDbRegexRefs: Map<string, { sources: string[]; targets: string[] }>,
  crossDbMetaDeps: Map<string, string[]>,
  currentDatabase?: string,
  identifierCaseSensitive = false,
  externalRefsEnabled = true,
): void {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const fileNodeMap = new Map<string, string>();
  const nodeSnapshot = [...nodes];
  for (const node of nodeSnapshot) {
    if (!externalRefsEnabled || !node.bodyScript) continue;
    const refs = extractExternalRefs(node.bodyScript);
    for (const ref of refs) {
      let virtualId = fileNodeMap.get(ref.url);
      if (!virtualId) {
        const hash = hashUrl(ref.url);
        virtualId = `[__ext__].[${hash}]`;
        fileNodeMap.set(ref.url, virtualId);
        if (!nodeIds.has(virtualId)) {
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
    const normLocal = normalizeName(localId, identifierCaseSensitive);
    if (currentDatabase && normDb === stripBrackets(currentDatabase).toLowerCase()) return true;
    if (!currentDatabase && nodeIds.has(normLocal)) return true;
    return false;
  };

  const addLocalEdge = (sourceId: string, localId: string, isWrite: boolean): void => {
    const resolved = normalizeName(localId, identifierCaseSensitive);
    if (!nodeIds.has(resolved) || resolved === sourceId) return;
    if (isWrite) addEdge(edges, edgeKeys, sourceId, resolved, 'body');
    else addEdge(edges, edgeKeys, resolved, sourceId, 'body');
  };

  const ensureCrossDbNode = (db: string, schema: string, object: string, crossDbId: string): void => {
    if (nodeIds.has(crossDbId)) return;
    nodeIds.add(crossDbId);
    nodes.push({
      id: crossDbId, schema: '', name: `${schema}.${object}`,
      fullName: crossDbId, type: 'external', externalType: 'db',
      externalDatabase: db,
    });
  };

  for (const [nodeId, { sources, targets }] of crossDbRegexRefs) {
    for (const ref of sources) {
      const parts = splitSqlName(ref).map(stripBrackets);
      if (parts.length !== 3) continue;
      const [db, schema, object] = parts;
      const localId = `${quoteIdentifier(schema)}.${quoteIdentifier(object)}`;
      const crossDbId = normalizeName([db, schema, object].map(quoteIdentifier).join('.'), identifierCaseSensitive);
      if (isLocalRef(db, localId)) {
        addLocalEdge(nodeId, localId, false);
        continue;
      }
      if (!externalRefsEnabled) continue;
      ensureCrossDbNode(db, schema, object, crossDbId);
      addEdge(edges, edgeKeys, crossDbId, nodeId, 'body');
    }
    const node = nodeMap.get(nodeId);
    const canWrite = node?.type === 'procedure';
    if (canWrite) {
      for (const ref of targets) {
        const parts = splitSqlName(ref).map(stripBrackets);
        if (parts.length !== 3) continue;
        const [db, schema, object] = parts;
        const localId = `${quoteIdentifier(schema)}.${quoteIdentifier(object)}`;
        const crossDbId = normalizeName([db, schema, object].map(quoteIdentifier).join('.'), identifierCaseSensitive);
        if (isLocalRef(db, localId)) {
          addLocalEdge(nodeId, localId, true);
          continue;
        }
        if (!externalRefsEnabled) continue;
        ensureCrossDbNode(db, schema, object, crossDbId);
        addEdge(edges, edgeKeys, nodeId, crossDbId, 'body');
      }
    }
  }

  const metaDepsNodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const [sourceId, rawTargets] of crossDbMetaDeps) {
    const sourceNode = metaDepsNodeMap.get(sourceId);
    for (const rawTarget of rawTargets) {
      const parts = splitSqlName(rawTarget).map(p => stripBrackets(p));
      if (parts.length < 3) continue;
      const pertinentParts = parts.length >= 4 ? parts.slice(-3) : parts;
      const [db, schema, object] = pertinentParts;
      if (CLR_TYPE_METHODS.has(object.toLowerCase())) continue;
      const localId = `${quoteIdentifier(schema)}.${quoteIdentifier(object)}`;
      const crossDbId = normalizeName([db, schema, object].map(quoteIdentifier).join('.'), identifierCaseSensitive);
      const isWrite = sourceNode?.type === 'procedure' && !!sourceNode.bodyScript
        && inferBodyDirection(sourceNode.bodyScript, schema, object, identifierCaseSensitive) === 'write';
      if (isLocalRef(db, localId)) {
        addLocalEdge(sourceId, localId, isWrite);
        continue;
      }
      if (!externalRefsEnabled) continue;
      ensureCrossDbNode(db, schema, object, crossDbId);
      if (isWrite) addEdge(edges, edgeKeys, sourceId, crossDbId, 'body');
      else         addEdge(edges, edgeKeys, crossDbId, sourceId, 'body');
    }
  }
}
