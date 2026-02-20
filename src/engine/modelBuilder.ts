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
} from './types';
import { parseSqlBody } from './sqlBodyParser';
import { stripBrackets, splitSqlName } from '../utils/sql';

// ─── Public API ─────────────────────────────────────────────────────────────

export function buildModel(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
): DacpacModel {
  const { nodes, edges, stats } = buildNodesAndEdges(objects, deps);
  const schemas = computeSchemas(nodes);

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No objects found in data source.');
  } else if (nodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found.');
  }

  return { nodes, edges, schemas, parseStats: stats, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─── Name Parsing ───────────────────────────────────────────────────────────

/** Parse "[schema].[object]" — schema is uppercased for case-insensitive consistency.
 *  Uses bracket-aware splitting so dots inside [bracket identifiers] are not treated as
 *  separators (e.g., [spLoadReconciliation_Case4.5] stays as one part). */
export function parseName(fullName: string): { schema: string; objectName: string } {
  const parts = splitSqlName(fullName).map(p => stripBrackets(p));
  if (parts.length >= 2) {
    return { schema: parts[0].toUpperCase(), objectName: parts[1] };
  }
  return { schema: 'DBO', objectName: parts[0] };
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
export function addEdge(
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
    let info = map.get(node.schema);
    if (!info) {
      info = {
        name: node.schema,
        nodeCount: 0,
        types: { table: 0, view: 0, procedure: 0, function: 0 },
      };
      map.set(node.schema, info);
    }
    info.nodeCount++;
    info.types[node.type]++;
  }
  return Array.from(map.values()).sort((a, b) => b.nodeCount - a.nodeCount);
}

// ─── Table Design ASCII Renderer ────────────────────────────────────────────

export function buildTableDesignAscii(
  cols: ColumnDef[],
  schema: string,
  objectName: string,
): string {
  if (cols.length === 0) return `-- No column metadata for [${schema}].[${objectName}]`;

  const hasExtra = cols.some(c => c.extra);
  const hCol = 'Column', hType = 'Type', hNull = 'Nullable', hExtra = '';
  const wName = Math.max(hCol.length, ...cols.map(c => c.name.length));
  const wType = Math.max(hType.length, ...cols.map(c => c.type.length));
  const wNull = Math.max(hNull.length, ...cols.map(c => c.nullable.length));
  const wExtra = hasExtra ? Math.max(hExtra.length, ...cols.map(c => c.extra.length)) : 0;

  const sep = (f: string) => {
    let s = `-- +${f.repeat(wName + 2)}+${f.repeat(wType + 2)}+${f.repeat(wNull + 2)}+`;
    if (hasExtra) s += `${f.repeat(wExtra + 2)}+`;
    return s;
  };
  const row = (n: string, t: string, nu: string, ex: string) => {
    let s = `-- | ${n.padEnd(wName)} | ${t.padEnd(wType)} | ${nu.padEnd(wNull)} |`;
    if (hasExtra) s += ` ${ex.padEnd(wExtra)} |`;
    return s;
  };

  const out: string[] = [];
  out.push(`-- TABLE: [${schema}].[${objectName}]`);
  out.push(sep('-'));
  out.push(row(hCol, hType, hNull, hExtra));
  out.push(sep('-'));
  for (const c of cols) out.push(row(c.name, c.type, c.nullable, c.extra));
  out.push(sep('-'));

  return out.join('\n');
}

// ─── Core Pipeline ──────────────────────────────────────────────────────────

function buildNodesAndEdges(
  objects: ExtractedObject[],
  deps: ExtractedDependency[],
): { nodes: LineageNode[]; edges: LineageEdge[]; stats: ParseStats } {
  // Phase 1: Build nodes
  const nodes: LineageNode[] = [];
  const nodeIds = new Set<string>();

  for (const obj of objects) {
    const { schema, objectName } = parseName(obj.fullName);
    const id = normalizeName(obj.fullName);

    if (nodeIds.has(id)) continue;
    nodeIds.add(id);

    // For tables without bodyScript: render design view from column metadata
    let bodyScript = obj.bodyScript;
    if (!bodyScript && obj.type === 'table' && obj.columns && obj.columns.length > 0) {
      bodyScript = buildTableDesignAscii(obj.columns, schema, objectName);
    }

    nodes.push({
      id,
      schema,
      name: objectName,
      fullName: obj.fullName,
      type: obj.type,
      bodyScript,
    });
  }

  // Phase 2: Build edges
  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();
  const stats: ParseStats = { parsedRefs: 0, resolvedEdges: 0, droppedRefs: [], spDetails: [] };
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Group dependencies by source
  const depsPerSource = new Map<string, string[]>();
  for (const dep of deps) {
    const sourceId = normalizeName(dep.sourceName);
    const targetId = normalizeName(dep.targetName);

    if (sourceId === targetId) continue;
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;

    if (!depsPerSource.has(sourceId)) depsPerSource.set(sourceId, []);
    depsPerSource.get(sourceId)!.push(targetId);
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
          depNode?.type === 'table' &&
          node.bodyScript &&
          inferBodyDirection(node.bodyScript, depNode.schema, depNode.name) === 'write'
        ) {
          addEdge(edges, edgeKeys, sourceId, depId, 'body');
        } else {
          addEdge(edges, edgeKeys, depId, sourceId, 'body');
        }
      }
    }

    // Regex sources (inbound: dep → SP)
    const spLabel = `${node.schema}.${node.name}`;
    for (const dep of parsed.sources) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId && nodeIds.has(depId)) {
        addEdge(edges, edgeKeys, depId, sourceId, 'body');
        stats.resolvedEdges++;
        spIn++;
        const n = nodeMap.get(depId);
        spInRefs.push(n ? `${n.schema}.${n.name}` : dep);
      } else if (depId !== sourceId) {
        spUnrelated.push(dep);
        stats.droppedRefs.push(`${spLabel} → ${dep}`);
      }
    }

    // Regex targets (outbound: SP → dep)
    for (const dep of parsed.targets) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId && nodeIds.has(depId)) {
        addEdge(edges, edgeKeys, sourceId, depId, 'body');
        stats.resolvedEdges++;
        spOut++;
        const n = nodeMap.get(depId);
        spOutRefs.push(n ? `${n.schema}.${n.name}` : dep);
      } else if (depId !== sourceId) {
        spUnrelated.push(dep);
        stats.droppedRefs.push(`${spLabel} → ${dep}`);
      }
    }

    // Regex exec calls (outbound: SP → called proc)
    for (const dep of parsed.execCalls) {
      if (!isSchemaQualified(dep)) { spSkipped.push(dep); continue; }
      if (isSystemRef(dep)) { spSkipped.push(dep); continue; }
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId && nodeIds.has(depId)) {
        addEdge(edges, edgeKeys, sourceId, depId, 'exec');
        stats.resolvedEdges++;
        spOut++;
        const n = nodeMap.get(depId);
        spOutRefs.push((n ? `${n.schema}.${n.name}` : dep) + ' (exec)');
      } else if (depId !== sourceId) {
        spUnrelated.push(dep + ' (exec)');
        stats.droppedRefs.push(`${spLabel} → ${dep} (exec)`);
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

  return { nodes, edges, stats };
}
