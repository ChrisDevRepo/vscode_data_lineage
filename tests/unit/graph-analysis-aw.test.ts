/**
 * Snapshot-based baseline test for graph analysis on AdventureWorks2025_AI.dacpac.
 * COMPARES AGAINST: tests/fixtures/graph-baseline-aw.json (Verified with NetworkX)
 * 
 * Execute with: npx tsx tests/unit/graph-analysis-aw.test.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  analyzeIslands,
  analyzeHubs,
  analyzeOrphans,
  analyzeCycles,
  analyzeLongestPath,
} from '../../src/engine/graphAnalysis';
import { buildGraph, traceNode } from '../../src/engine/graphBuilder';
import { filterBySchemas } from '../../src/engine/dacpacExtractor';
import { applyExclusionFilter, applyIsolationFilter } from '../../src/engine/modelFilters';
import { bfsReachable } from '../../src/ai/sm/smGuards';
import { assert, assertEq, loadAdventureWorksModel, printSummary } from './helpers/testUtils';
import { bidirectional } from 'graphology-shortest-path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, '../fixtures/graph-baseline-aw.json');

async function main() {
  console.log('═══ AdventureWorks Graph Analysis Snapshot Verification ═══');

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const model = await loadAdventureWorksModel();
  const { graph } = buildGraph(model);

  console.log(`Graph: ${graph.order} nodes, ${graph.size} edges`);
  assertEq(graph.order, baseline.stats.nodes, `AW: ${baseline.stats.nodes} nodes`);
  assertEq(graph.size, baseline.stats.edges, `AW: ${baseline.stats.edges} edges`);

  // 1. SCCs (Cycles)
  console.log('\n── SCCs (Cycles) ──');
  const cycleResult = analyzeCycles(graph);
  assertEq(cycleResult.groups.length, baseline.analysis.cycles.groupCount, `AW-Cycles: ${baseline.analysis.cycles.groupCount} cycle groups`);
  const totalCycleNodes = cycleResult.groups.reduce((s, g) => s + g.nodeIds.length, 0);
  assertEq(totalCycleNodes, baseline.analysis.cycles.totalNodes, `AW-Cycles: ${baseline.analysis.cycles.totalNodes} nodes involved`);

  // 2. Islands (Disconnected Components)
  console.log('\n── Islands ──');
  const islandResult = analyzeIslands(graph, 1000);
  assertEq(islandResult.groups.length, baseline.analysis.islands.groupCount, `AW-Islands: ${baseline.analysis.islands.groupCount} islands`);
  const totalIslandNodes = islandResult.groups.reduce((s, g) => s + g.nodeIds.length, 0);
  assertEq(totalIslandNodes, baseline.analysis.islands.totalNodes, `AW-Islands: ${baseline.analysis.islands.totalNodes} nodes`);

  // 3. Hubs
  console.log('\n── Hubs ──');
  const hubResult = analyzeHubs(graph, 10);
  assertEq(hubResult.groups[0].id, baseline.analysis.hubs.topId, `AW-Hubs: Top hub matches baseline (${baseline.analysis.hubs.topId})`);
  assertEq(hubResult.groups[0].meta?.degree, baseline.analysis.hubs.topDegree, `AW-Hubs: Top degree=${baseline.analysis.hubs.topDegree}`);

  // 4. Longest Path
  console.log('\n── Longest Path ──');
  const pathResult = analyzeLongestPath(graph, 3, 100);
  const maxDepth = Math.max(...pathResult.groups.map(g => g.nodeIds.length));
  assertEq(maxDepth, baseline.analysis.longestPath.maxDepth, `AW-Path: Longest path matches baseline (${baseline.analysis.longestPath.maxDepth})`);

  // 5. Reachability (undirected)
  console.log('\n── BFS Reachability Consistency ──');
  const origin = baseline.reachability.origin;
  const aiReachable = bfsReachable(graph, origin, new Set());
  assertEq(aiReachable.size, baseline.reachability.undirectedCount, `AW-BFS: Undirected reachability from ${origin} is ${baseline.reachability.undirectedCount}`);

  // 5.1 Trace directionality
  const upTrace = traceNode(graph, origin, 'upstream');
  assertEq(upTrace.nodeIds.size, baseline.reachability.upstreamCount, `AW-BFS: Upstream trace matches baseline (${baseline.reachability.upstreamCount})`);
  const downTrace = traceNode(graph, origin, 'downstream');
  assertEq(downTrace.nodeIds.size, baseline.reachability.downstreamCount, `AW-BFS: Downstream trace matches baseline (${baseline.reachability.downstreamCount})`);

  // 6. Pathfinding
  console.log('\n── Path Finding (A to B) ──');
  const startId = baseline.pathfinding.start;
  const targetId = baseline.pathfinding.target;
  const path = bidirectional(graph, startId, targetId);
  assert(!!path, `AW-Pathfinding: Path exists between ${startId} and ${targetId}`);
  assert(path!.length >= baseline.pathfinding.minPathLength, `AW-Pathfinding: Path is at least ${baseline.pathfinding.minPathLength} nodes`);

  // 7. Filter Interaction (Sanity)
  console.log('\n── Filter Interaction ──');
  const salesModel = filterBySchemas(model, new Set(['Sales']));
  const { graph: salesGraph } = buildGraph(salesModel);
  const salesOrigin = '[sales].[vsalesperson]';
  const salesTrace = traceNode(salesGraph, salesOrigin, 'both');
  for (const tid of salesTrace.nodeIds) {
    assert(salesGraph.hasNode(tid), `AW-Trace-Filter: Traced node ${tid} is within the filtered Sales graph`);
  }

  printSummary('AdventureWorks Graph Baseline (Snapshot)');
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err);
  process.exit(1);
});
