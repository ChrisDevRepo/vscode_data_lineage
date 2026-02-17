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
import { stripBrackets } from '../utils/sql';

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

/** Parse "[schema].[object]" — schema is uppercased for case-insensitive consistency */
export function parseName(fullName: string): { schema: string; objectName: string } {
  const parts = stripBrackets(fullName).split('.');
  if (parts.length >= 2) {
    return { schema: parts[0].toUpperCase(), objectName: parts[1] };
  }
  return { schema: 'DBO', objectName: parts[0] };
}

/** Normalize to lowercase "[schema].[object]" for consistent matching */
export function normalizeName(name: string): string {
  const parts = stripBrackets(name).split('.');
  if (parts.length >= 2) {
    return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
  }
  return `[dbo].[${parts[0]}]`.toLowerCase();
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
    const spUnrelated: string[] = [];

    // Collect target/exec IDs to exclude from dep fallback
    const outboundIds = new Set<string>();
    for (const dep of parsed.targets) outboundIds.add(normalizeName(dep));
    for (const dep of parsed.execCalls) outboundIds.add(normalizeName(dep));

    // Add dependency edges not already handled by regex (exclude targets/exec to prevent reverse edges)
    // Direction is type-aware: procedures are EXEC calls (outbound), everything else is inbound
    for (const depId of xmlDeps) {
      if (!outboundIds.has(depId)) {
        const depType = nodeMap.get(depId)?.type;
        if (depType === 'procedure') {
          addEdge(edges, edgeKeys, sourceId, depId, 'exec');
        } else {
          addEdge(edges, edgeKeys, depId, sourceId, 'body');
        }
      }
    }

    // Regex sources (inbound: dep → SP)
    const spLabel = `${node.schema}.${node.name}`;
    for (const dep of parsed.sources) {
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId && nodeIds.has(depId)) {
        addEdge(edges, edgeKeys, depId, sourceId, 'body');
        stats.resolvedEdges++;
        spIn++;
      } else if (depId !== sourceId) {
        spUnrelated.push(dep);
        stats.droppedRefs.push(`${spLabel} → ${dep}`);
      }
    }

    // Regex targets (outbound: SP → dep)
    for (const dep of parsed.targets) {
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId && nodeIds.has(depId)) {
        addEdge(edges, edgeKeys, sourceId, depId, 'body');
        stats.resolvedEdges++;
        spOut++;
      } else if (depId !== sourceId) {
        spUnrelated.push(dep);
        stats.droppedRefs.push(`${spLabel} → ${dep}`);
      }
    }

    // Regex exec calls (outbound: SP → called proc)
    for (const dep of parsed.execCalls) {
      const depId = normalizeName(dep);
      stats.parsedRefs++;
      if (depId !== sourceId && nodeIds.has(depId)) {
        addEdge(edges, edgeKeys, sourceId, depId, 'exec');
        stats.resolvedEdges++;
        spOut++;
      } else if (depId !== sourceId) {
        spUnrelated.push(dep + ' (exec)');
        stats.droppedRefs.push(`${spLabel} → ${dep} (exec)`);
      }
    }

    stats.spDetails.push({ name: spLabel, inCount: spIn, outCount: spOut, unrelated: spUnrelated });
  }

  return { nodes, edges, stats };
}
