import type { DatabaseModel } from './types';
import { buildGraphologyGraph, traceNode, computeShortestPath } from './graphBuilder';
import { analyzeIslands, analyzeHubs, analyzeOrphans, analyzeCycles, analyzeLongestPath } from './graphAnalysis';
import { bfsReachable } from './graphGuards';
import { searchCatalog, searchBodyScripts, searchColumns, type SearchableNode } from '../utils/modelSearch';

/**
 * Deterministic engine report containing a fixed battery of backend computations
 * over a loaded {@link DatabaseModel}.
 *
 * @remarks
 * Every field is order-stable and free of timestamps or randomness, allowing callers to compare
 * reports byte-for-byte. The Extension Development Host exposes it only through the test-gated
 * `dataLineageViz.__test.engineReport` command.
 */
export interface EngineParityReport {
  /** Report schema version — bump when the battery shape changes (forces a baseline refresh). */
  schemaVersion: number;
  model: {
    nodes: number;
    edges: number;
    schemas: number;
    /** Per-schema node/type breakdown, sorted by schema name. */
    schemaBreakdown: Array<{ name: string; nodeCount: number; table: number; view: number; procedure: number; function: number; external: number }>;
    /** Order-independent fingerprint of the full node-id set. */
    nodeIdHash: string;
  };
  graph: { order: number; size: number };
  analysis: {
    cycles: { groupCount: number; totalNodes: number };
    islands: { groupCount: number; totalNodes: number };
    hubs: { count: number; topId: string | null; topDegree: number | null };
    orphans: { groupCount: number; totalNodes: number };
    longestPath: { maxDepth: number };
  };
  reachability: { origin: string; undirectedCount: number; upstreamCount: number; downstreamCount: number };
  pathfinding: { start: string; target: string; pathLength: number };
  search: Array<{ kind: 'catalog' | 'body' | 'column'; query: string; count: number; topIds: string[] }>;
}

const REPORT_SCHEMA_VERSION = 1;

/** Fixed, content-agnostic queries included in every report. */
const FIXED_QUERIES: ReadonlyArray<{ kind: 'catalog' | 'body' | 'column'; query: string }> = [
  { kind: 'catalog', query: 'a' },
  { kind: 'body', query: 'select' },
  { kind: 'column', query: 'id' },
];

/** Order-independent FNV-1a hash over a set of strings (sorted first). */
function stableHash(items: readonly string[]): string {
  const s = [...items].sort().join('');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function totalNodes(groups: ReadonlyArray<{ nodeIds: string[] }>): number {
  return groups.reduce((sum, g) => sum + g.nodeIds.length, 0);
}

/**
 * Computes the deterministic parity report for a model.
 *
 * @param model - The loaded database model (from dacpac extraction).
 * @returns A stable, JSON-comparable report of the backend engine battery.
 */
export function buildEngineParityReport(model: DatabaseModel): EngineParityReport {
  const graph = buildGraphologyGraph(model);
  const nodes = model.nodes as unknown as SearchableNode[];

  const schemaBreakdown = [...model.schemas]
    .map((s) => ({
      name: s.name,
      nodeCount: s.nodeCount,
      table: s.types['table'] ?? 0,
      view: s.types['view'] ?? 0,
      procedure: s.types['procedure'] ?? 0,
      function: s.types['function'] ?? 0,
      external: s.types['external'] ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cycles = analyzeCycles(graph);
  const islands = analyzeIslands(graph, 1000);
  const hubs = analyzeHubs(graph, 2);
  const orphans = analyzeOrphans(graph);
  const longest = analyzeLongestPath(graph, 3, 1000);

  const topHub = hubs.groups[0];
  // Deterministic origin: the top hub's actual node id (group.id is a synthetic
  // "hub-<node>" label, not a graph node), else the lexicographically-first node.
  const origin = topHub?.nodeIds[0] ?? [...model.nodes.map((n) => n.id)].sort()[0] ?? '';

  const undirected = origin ? bfsReachable(graph, origin, new Set<string>()) : new Set<string>();
  const up = origin ? traceNode(graph, origin, 'upstream') : { nodeIds: new Set<string>() };
  const down = origin ? traceNode(graph, origin, 'downstream') : { nodeIds: new Set<string>() };

  // Pathfinding: from the origin to its lexicographically-first downstream node.
  const target = [...down.nodeIds].filter((id) => id !== origin).sort()[0] ?? origin;
  const path = origin && target ? computeShortestPath(graph, origin, target) : null;

  const search = FIXED_QUERIES.map((q) => {
    let ids: string[];
    if (q.kind === 'catalog') ids = searchCatalog(nodes, q.query, undefined, undefined, 1000).map((n) => n.id);
    else if (q.kind === 'body') ids = searchBodyScripts(nodes, q.query, undefined, 2, 1000).map((m) => m.node.id);
    else ids = searchColumns(nodes, q.query, 1000).map((m) => m.node.id);
    return { kind: q.kind, query: q.query, count: ids.length, topIds: [...ids].sort().slice(0, 5) };
  });

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    model: {
      nodes: model.nodes.length,
      edges: model.edges.length,
      schemas: model.schemas.length,
      schemaBreakdown,
      nodeIdHash: stableHash(model.nodes.map((n) => n.id)),
    },
    graph: { order: graph.order, size: graph.size },
    analysis: {
      cycles: { groupCount: cycles.groups.length, totalNodes: totalNodes(cycles.groups) },
      islands: { groupCount: islands.groups.length, totalNodes: totalNodes(islands.groups) },
      hubs: {
        count: hubs.groups.length,
        topId: topHub?.id ?? null,
        topDegree: (topHub?.meta?.degree as number | undefined) ?? null,
      },
      orphans: { groupCount: orphans.groups.length, totalNodes: totalNodes(orphans.groups) },
      longestPath: { maxDepth: longest.groups.reduce((m, g) => Math.max(m, g.nodeIds.length), 0) },
    },
    reachability: {
      origin,
      undirectedCount: undirected.size,
      upstreamCount: up.nodeIds.size,
      downstreamCount: down.nodeIds.size,
    },
    pathfinding: { start: origin, target, pathLength: path ? path.nodeIds.size : 0 },
    search,
  };
}
