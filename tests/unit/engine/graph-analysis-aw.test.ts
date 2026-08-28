/**
 * Snapshot baseline for graph analysis over AdventureWorks2025_AI.dacpac.
 *
 * COMPARES AGAINST: tests/fixtures/graph-baseline-aw.json (verified with NetworkX)
 *
 * @remarks
 * One test per baseline dimension, deliberately. These assertions are not independent
 * observations of one fact — a node-count drift and a BFS reachability drift are
 * different defects with different causes, and collapsing them into a single block
 * meant the first one to fail hid every one after it. The dacpac is extracted once in
 * `beforeAll` and shared read-only, so the split costs nothing.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeCycles,
  analyzeHubs,
  analyzeIslands,
  analyzeLongestPath,
} from '../../../src/engine/graphAnalysis';
import { buildGraph, traceNodeWithLevels } from '../../../src/engine/graphBuilder';
import { filterBySchemas } from '../../../src/engine/dacpacExtractor';
import { bfsReachable } from '../../../src/engine/graphGuards';
import type { DatabaseModel } from '../../../src/engine/types';
import { loadAdventureWorksModel } from '../helpers/testUtils';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Baseline = {
  stats: { nodes: number; edges: number };
  analysis: {
    cycles: { groupCount: number; totalNodes: number };
    islands: { groupCount: number; totalNodes: number };
    hubs: { topId: string; topDegree: number };
    longestPath: { maxDepth: number };
  };
  reachability: { origin: string; undirectedCount: number; upstreamCount: number; downstreamCount: number };
  pathfinding: { start: string; target: string; minPathLength: number };
};

const baseline = JSON.parse(
  readFileSync(resolve(__dirname, '../../fixtures/graph-baseline-aw.json'), 'utf8'),
) as Baseline;

let model: DatabaseModel;
let graph: Graph;

beforeAll(async () => {
  model = await loadAdventureWorksModel();
  graph = buildGraph(model).graph;
});

describe('AdventureWorks baseline — graph shape', () => {
  it(`carries ${baseline.stats.nodes} nodes`, () => {
    expect(graph.order).toBe(baseline.stats.nodes);
  });

  it(`carries ${baseline.stats.edges} edges`, () => {
    expect(graph.size).toBe(baseline.stats.edges);
  });
});

describe('AdventureWorks baseline — analysis', () => {
  it(`finds ${baseline.analysis.cycles.groupCount} cycle groups over ${baseline.analysis.cycles.totalNodes} nodes`, () => {
    const groups = analyzeCycles(graph).groups;
    expect(groups).toHaveLength(baseline.analysis.cycles.groupCount);
    expect(groups.reduce((total, group) => total + group.nodeIds.length, 0))
      .toBe(baseline.analysis.cycles.totalNodes);
  });

  it(`finds ${baseline.analysis.islands.groupCount} islands over ${baseline.analysis.islands.totalNodes} nodes`, () => {
    const groups = analyzeIslands(graph, 1000).groups;
    expect(groups).toHaveLength(baseline.analysis.islands.groupCount);
    expect(groups.reduce((total, group) => total + group.nodeIds.length, 0))
      .toBe(baseline.analysis.islands.totalNodes);
  });

  it(`ranks ${baseline.analysis.hubs.topId} top, at degree ${baseline.analysis.hubs.topDegree}`, () => {
    const top = analyzeHubs(graph, 10).groups[0];
    expect(top.id).toBe(baseline.analysis.hubs.topId);
    expect(top.meta?.degree).toBe(baseline.analysis.hubs.topDegree);
  });

  it(`finds a longest chain of ${baseline.analysis.longestPath.maxDepth} nodes`, () => {
    const depths = analyzeLongestPath(graph, 3, 100).groups.map(group => group.nodeIds.length);
    expect(Math.max(...depths)).toBe(baseline.analysis.longestPath.maxDepth);
  });
});

describe('AdventureWorks baseline — BFS reachability', () => {
  const { origin } = baseline.reachability;

  it(`reaches ${baseline.reachability.undirectedCount} nodes undirected from ${origin}`, () => {
    expect(bfsReachable(graph, origin, new Set()).size).toBe(baseline.reachability.undirectedCount);
  });

  it(`reaches ${baseline.reachability.upstreamCount} node(s) tracing upstream only`, () => {
    expect(traceNodeWithLevels(graph, origin, Infinity, 0).nodeIds.size)
      .toBe(baseline.reachability.upstreamCount);
  });

  it(`reaches ${baseline.reachability.downstreamCount} nodes tracing downstream only`, () => {
    expect(traceNodeWithLevels(graph, origin, 0, Infinity).nodeIds.size)
      .toBe(baseline.reachability.downstreamCount);
  });

  it('reaches no more in one direction than it does undirected', () => {
    const up = traceNodeWithLevels(graph, origin, Infinity, 0).nodeIds.size;
    const down = traceNodeWithLevels(graph, origin, 0, Infinity).nodeIds.size;
    expect(Math.max(up, down)).toBeLessThanOrEqual(bfsReachable(graph, origin, new Set()).size);
  });
});

describe('AdventureWorks baseline — pathfinding', () => {
  const { start, target, minPathLength } = baseline.pathfinding;

  it(`finds a path of at least ${minPathLength} nodes from ${start} to ${target}`, () => {
    const path = bidirectional(graph, start, target);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThanOrEqual(minPathLength);
  });
});

describe('AdventureWorks baseline — schema filter', () => {
  it('keeps every traced node inside the filtered Sales graph', () => {
    const salesGraph = buildGraph(filterBySchemas(model, new Set(['Sales']))).graph;
    const traced = traceNodeWithLevels(salesGraph, '[sales].[vsalesperson]', Infinity, Infinity);

    expect(traced.nodeIds.size).toBeGreaterThan(0);
    expect([...traced.nodeIds].filter(id => !salesGraph.hasNode(id))).toEqual([]);
  });
});
