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
  ColumnDef,
  ForeignKeyInfo,
  CatalogEntry,
  NeighborIndex,
  createEmptySchemaInfo,
} from './types';
import { parseSqlBody } from './sqlBodyParser';
import { stripBrackets, splitSqlName, schemaKey } from '../utils/sql';

// ─── Public API ─────────────────────────────────────────────────────────────

export function buildModel(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
): DacpacModel {
  const { nodes, edges, stats, neighborPairs } = buildNodesAndEdges(objects, deps, allObjects);

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
    catalog[normalizeName(obj.fullName)] = { schema: displaySchema, name: objectName, type: obj.type };
  }
  return catalog;
}

// ─── NeighborIndex Builder ───────────────────────────────────────────────────

/** Build an O(1) neighbor lookup from edges plus optional cross-schema neighbor pairs. */
function buildNeighborIndex(
  edges: LineageEdge[],
  extraPairs?: Array<{ source: string; target: string }>,
): NeighborIndex {
  const index: NeighborIndex = {};
  const addPair = (source: string, target: string) => {
    if (!index[target]) index[target] = { in: [], out: [] };
    if (!index[source]) index[source] = { in: [], out: [] };
    if (!index[target].in.includes(source)) index[target].in.push(source);
    if (!index[source].out.includes(target)) index[source].out.push(target);
  };
  for (const edge of edges) addPair(edge.source, edge.target);
  for (const pair of extraPairs ?? []) addPair(pair.source, pair.target);
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

// ─── Table Design HTML Renderer ──────────────────────────────────────────────

export function buildTableDesignHtml(
  cols: ColumnDef[],
  schema: string,
  objectName: string,
  objectType: 'table' | 'external' = 'table',
  fks?: ForeignKeyInfo[],
): string {
  if (cols.length === 0) return `<p class="empty">No column metadata for [${schema}].[${objectName}]</p>`;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const typeIcon = objectType === 'external' ? '⬡' : '■';
  const typeLabel = objectType === 'external' ? 'EXTERNAL TABLE' : 'TABLE';

  const hasExtra  = cols.some(c => c.extra);
  const hasUnique = cols.some(c => c.unique !== undefined && c.unique !== '');
  const hasCheck  = cols.some(c => c.check !== undefined && c.check !== '');

  const lines: string[] = [];
  lines.push(`<h2><span class="type-icon type-${objectType}">${typeIcon}</span> ${esc(typeLabel)}: [${esc(schema)}].[${esc(objectName)}]</h2>`);

  // Columns table
  lines.push('<table class="design-table">');
  lines.push('<thead><tr>');
  lines.push('<th>Column</th><th>Type</th><th>Nullable</th>');
  if (hasExtra) lines.push('<th>Extra</th>');
  if (hasUnique) lines.push('<th>UQ</th>');
  if (hasCheck) lines.push('<th>CK</th>');
  lines.push('</tr></thead>');
  lines.push('<tbody>');
  for (const c of cols) {
    const extraBadge = c.extra ? `<span class="badge badge-${c.extra.replace(/[()]/g, '').toLowerCase()}">${esc(c.extra)}</span>` : '';
    const uqBadge = c.unique ? '<span class="badge badge-uq">UQ</span>' : '';
    const ckBadge = c.check ? '<span class="badge badge-ck">CK</span>' : '';
    lines.push('<tr>');
    lines.push(`<td class="col-name">${esc(c.name)}</td>`);
    lines.push(`<td class="col-type">${esc(c.type)}</td>`);
    lines.push(`<td class="col-nullable">${esc(c.nullable)}</td>`);
    if (hasExtra) lines.push(`<td class="col-extra">${extraBadge}</td>`);
    if (hasUnique) lines.push(`<td class="col-uq">${uqBadge}</td>`);
    if (hasCheck) lines.push(`<td class="col-ck">${ckBadge}</td>`);
    lines.push('</tr>');
  }
  lines.push('</tbody></table>');

  // FK table
  if (fks !== undefined) {
    lines.push('<h3>FOREIGN KEYS</h3>');
    if (fks.length === 0) {
      lines.push('<p class="empty">(none)</p>');
    } else {
      lines.push('<table class="design-table fk-table">');
      lines.push('<thead><tr><th>Constraint</th><th>Column(s)</th><th>References</th><th>On Delete</th></tr></thead>');
      lines.push('<tbody>');
      for (const fk of fks) {
        lines.push('<tr>');
        lines.push(`<td>${esc(fk.name)}</td>`);
        lines.push(`<td>${esc(fk.columns.join(', '))}</td>`);
        lines.push(`<td>[${esc(fk.refSchema)}].[${esc(fk.refTable)}](${esc(fk.refColumns.join(', '))})</td>`);
        lines.push(`<td>${esc(fk.onDelete)}</td>`);
        lines.push('</tr>');
      }
      lines.push('</tbody></table>');
    }
  }

  return lines.join('\n');
}

// ─── Core Pipeline ──────────────────────────────────────────────────────────

function buildNodesAndEdges(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
  allObjects?: ExtractedObject[],
): { nodes: LineageNode[]; edges: LineageEdge[]; stats: ParseStats; neighborPairs: Array<{ source: string; target: string }> } {
  // Phase 1: Build nodes
  const nodes: LineageNode[] = [];
  const nodeIds = new Set<string>();

  // Full catalog IDs and metadata — used for cross-schema classification and direction inference.
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

  // Cross-schema neighbor pairs: schema-qualified, in full catalog, outside filter context.
  // Populated by all dep paths so NodeInfoBar shows them with ⊘ even when not rendered.
  const neighborPairs: Array<{ source: string; target: string }> = [];

  for (const obj of objects) {
    const { schema, objectName } = parseName(obj.fullName);
    const id = normalizeName(obj.fullName);

    if (nodeIds.has(id)) continue;
    nodeIds.add(id);

    // For tables (and external tables) without bodyScript: render design view from column metadata
    const bodyScript = obj.bodyScript;
    let bodyHtml: string | undefined;
    if (!bodyScript && (obj.type === 'table' || obj.type === 'external') && obj.columns && obj.columns.length > 0) {
      bodyHtml = buildTableDesignHtml(obj.columns, schema, objectName, obj.type as 'table' | 'external', obj.fks);
    }

    nodes.push({
      id,
      schema,
      name: objectName,
      fullName: obj.fullName,
      type: obj.type,
      bodyScript,
      ...(bodyHtml && { bodyHtml }),
      ...(obj.columns && obj.columns.length > 0 && { columns: obj.columns }),
      ...(obj.externalKind && { externalKind: obj.externalKind }),
    });
  }

  // Phase 2: Build edges
  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();
  const stats: ParseStats = { parsedRefs: 0, resolvedEdges: 0, droppedRefs: [], spDetails: [] };
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Group dependencies by source.
  // crossSchemaDepsForNode tracks deps where source ∈ filter context, target ∈ full catalog only.
  // unresolvableDepsForNode tracks deps where target is schema-qualified but not in any catalog.
  const depsPerSource = new Map<string, string[]>();
  const crossSchemaDepsForNode = new Map<string, string[]>();
  const unresolvableDepsForNode = new Map<string, string[]>();
  for (const dep of deps) {
    const sourceId = normalizeName(dep.sourceName);
    const targetId = normalizeName(dep.targetName);

    if (sourceId === targetId) continue;

    if (!nodeIds.has(sourceId)) {
      // Source is from an unselected schema (possible when the deps query includes OR referenced_schema).
      // If source is in the full catalog and target IS a selected node, record as an inbound
      // cross-schema neighbor: target is upstream data for the unselected source object.
      if (allNodeIds.size > 0 && allNodeIds.has(sourceId) && nodeIds.has(targetId)) {
        neighborPairs.push({ source: targetId, target: sourceId }); // target feeds source (default: read)
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
      // Target not in filter context and not in full catalog.
      // Track schema-qualified, non-system names so they surface as Unresolved — no silent drop.
      if (isSchemaQualified(dep.targetName) && !isSystemRef(dep.targetName)) {
        if (!unresolvableDepsForNode.has(sourceId)) unresolvableDepsForNode.set(sourceId, []);
        unresolvableDepsForNode.get(sourceId)!.push(dep.targetName);
      }
    }
  }

  // Process each node's edges
  for (const node of nodes) {
    const sourceId = node.id;
    const xmlDeps = depsPerSource.get(sourceId) ?? [];
    const willRegexParse = node.bodyScript && node.type === 'procedure';

    if (!willRegexParse) {
      // Non-SP: add dependency edges as inbound (dep → this node)
      for (const depId of xmlDeps) {
        addEdge(edges, edgeKeys, depId, sourceId, 'body');
      }
      // Cross-schema deps for non-SP: referenced object is upstream (inbound).
      for (const csDepId of crossSchemaDepsForNode.get(sourceId) ?? []) {
        neighborPairs.push({ source: csDepId, target: sourceId });
      }

      // Views and functions: parser supplement — MS metadata is primary source.
      // Parser runs as fallback; only differences beyond metadata are recorded.
      // All parser-found refs are inbound (views/functions never write).
      // Logs: edges added beyond metadata (inRefs), unresolvable refs (unrelated).
      if (node.bodyScript && (node.type === 'view' || node.type === 'function')) {
        const parsed = parseSqlBody(node.bodyScript);
        const xmlDepIds = new Set(xmlDeps);
        const spLabel = `${node.schema}.${node.name}`;
        const spParserAdded: string[] = []; // edges added by parser beyond MS metadata
        const spUnrelated: string[] = [];
        const spSkipped: string[] = [];

        for (const dep of parsed.sources) {
          if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
          if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
          const depId = normalizeName(dep);
          if (depId === sourceId || xmlDepIds.has(depId)) continue; // already from metadata — no delta
          stats.parsedRefs++;
          if (nodeIds.has(depId)) {
            addEdge(edges, edgeKeys, depId, sourceId, 'body');
            stats.resolvedEdges++;
            const n = nodeMap.get(depId);
            spParserAdded.push(n ? `${n.schema}.${n.name}` : dep); // log the delta
          } else if (allNodeIds.size > 0 && allNodeIds.has(depId)) {
            neighborPairs.push({ source: depId, target: sourceId });
          } else {
            // Not in any catalog. Skip SQL Server XML type method calls
            // (e.g. [ref].[value], [resume].[nodes]) — they look like schema.object
            // to the parser but are never real catalog references.
            const parts = splitSqlName(dep);
            const objPart = stripBrackets(parts[parts.length - 1]).toLowerCase();
            if (XML_METHODS.has(objPart)) { spSkipped.push(dep); continue; }
            spUnrelated.push(dep);
            stats.droppedRefs.push(`${spLabel} → ${dep}`);
          }
        }

        // Surface metadata refs not in any catalog (previously silently dropped for non-SPs)
        for (const rawName of unresolvableDepsForNode.get(sourceId) ?? []) {
          spUnrelated.push(rawName);
          stats.droppedRefs.push(`${spLabel} → ${rawName}`);
        }

        // Only emit a spDetails entry when there is something to report (delta only)
        if (spParserAdded.length > 0 || spUnrelated.length > 0 || spSkipped.length > 0) {
          stats.spDetails.push({
            name: spLabel,
            inCount: spParserAdded.length,
            outCount: 0,
            ...(spParserAdded.length > 0 && { inRefs: spParserAdded }),
            unrelated: spUnrelated,
            ...(spSkipped.length > 0 && { skippedRefs: spSkipped }),
          });
        }
      }

      continue;
    }

    // SP: regex-based body parsing
    const parsed = parseSqlBody(node.bodyScript!);
    let spIn = 0, spOut = 0;
    const spInRefs: string[] = [];
    const spOutRefs: string[] = [];
    const spUnrelated: string[] = [];
    const spSkipped: string[] = [];

    // Collect target/exec IDs to exclude from dep fallback
    // Only schema-qualified, non-system refs are eligible outbound candidates.
    const outboundIds = new Set<string>();
    for (const dep of parsed.targets) {
      if (isSchemaQualified(dep) && !isSystemRef(dep)) outboundIds.add(normalizeName(dep));
    }
    for (const dep of parsed.execCalls) {
      if (isSchemaQualified(dep) && !isSystemRef(dep)) outboundIds.add(normalizeName(dep));
    }

    // Add dependency edges not already handled by regex (exclude targets/exec to prevent reverse edges)
    for (const depId of xmlDeps) {
      if (!outboundIds.has(depId)) {
        const depNode = nodeMap.get(depId);
        if (depNode?.type === 'procedure') {
          addEdge(edges, edgeKeys, sourceId, depId, 'exec');
        } else if (
          (depNode?.type === 'table' || depNode?.type === 'external') &&
          node.bodyScript &&
          inferBodyDirection(node.bodyScript, depNode.schema, depNode.name) === 'write'
        ) {
          addEdge(edges, edgeKeys, sourceId, depId, 'body');
        } else {
          addEdge(edges, edgeKeys, depId, sourceId, 'body');
        }
      }
    }
    // XML fallback for cross-schema deps of this SP: infer direction from catalog metadata.
    for (const csDepId of crossSchemaDepsForNode.get(sourceId) ?? []) {
      if (!outboundIds.has(csDepId)) {
        const meta = allObjectMeta.get(csDepId);
        if (meta?.type === 'procedure') {
          neighborPairs.push({ source: sourceId, target: csDepId }); // outbound exec
        } else if (
          (meta?.type === 'table' || meta?.type === 'external') &&
          node.bodyScript &&
          inferBodyDirection(node.bodyScript, meta.schema, meta.name) === 'write'
        ) {
          neighborPairs.push({ source: sourceId, target: csDepId }); // outbound write
        } else {
          neighborPairs.push({ source: csDepId, target: sourceId }); // inbound read
        }
      }
    }

    // Metadata deps with no catalog match — surface as Unresolved so no schema-qualified name is silently dropped.
    const spLabel = `${node.schema}.${node.name}`;
    for (const rawName of unresolvableDepsForNode.get(sourceId) ?? []) {
      spUnrelated.push(rawName);
      stats.droppedRefs.push(`${spLabel} → ${rawName}`);
    }

    // Regex sources (inbound: dep → SP)
    for (const dep of parsed.sources) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId) {
        if (nodeIds.has(depId)) {
          addEdge(edges, edgeKeys, depId, sourceId, 'body');
          stats.resolvedEdges++;
          spIn++;
          const n = nodeMap.get(depId);
          spInRefs.push(n ? `${n.schema}.${n.name}` : dep);
        } else if (allNodeIds.size > 0 && allNodeIds.has(depId)) {
          neighborPairs.push({ source: depId, target: sourceId }); // inbound: cross-schema dep is upstream
        } else {
          spUnrelated.push(dep);
          stats.droppedRefs.push(`${spLabel} → ${dep}`);
        }
      }
    }

    // Regex targets (outbound: SP → dep)
    for (const dep of parsed.targets) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId) {
        if (nodeIds.has(depId)) {
          addEdge(edges, edgeKeys, sourceId, depId, 'body');
          stats.resolvedEdges++;
          spOut++;
          const n = nodeMap.get(depId);
          spOutRefs.push(n ? `${n.schema}.${n.name}` : dep);
        } else if (allNodeIds.size > 0 && allNodeIds.has(depId)) {
          neighborPairs.push({ source: sourceId, target: depId }); // outbound: SP writes/reads cross-schema dep
        } else {
          spUnrelated.push(dep);
          stats.droppedRefs.push(`${spLabel} → ${dep}`);
        }
      }
    }

    // Regex exec calls (outbound: SP → called proc)
    for (const dep of parsed.execCalls) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId) {
        if (nodeIds.has(depId)) {
          addEdge(edges, edgeKeys, sourceId, depId, 'exec');
          stats.resolvedEdges++;
          spOut++;
          const n = nodeMap.get(depId);
          spOutRefs.push((n ? `${n.schema}.${n.name}` : dep) + ' (exec)');
        } else if (allNodeIds.size > 0 && allNodeIds.has(depId)) {
          neighborPairs.push({ source: sourceId, target: depId }); // outbound exec: SP calls cross-schema proc
        } else {
          spUnrelated.push(dep + ' (exec)');
          stats.droppedRefs.push(`${spLabel} → ${dep} (exec)`);
        }
      }
    }

    stats.spDetails.push({
      name: spLabel, inCount: spIn, outCount: spOut,
      ...(spInRefs.length > 0 && { inRefs: spInRefs }),
      ...(spOutRefs.length > 0 && { outRefs: spOutRefs }),
      unrelated: spUnrelated,
      ...(spSkipped.length > 0 && { skippedRefs: spSkipped }),
    });
  }

  return { nodes, edges, stats, neighborPairs };
}
