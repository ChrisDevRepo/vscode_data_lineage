/**
 * Tests for graph construction, layout, and BFS trace algorithms.
 * Execute with: npx tsx test/graphBuilder.test.ts
 */

import { readFileSync } from 'fs';
import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { extractDacpac } from '../src/engine/dacpacExtractor';
import { buildGraph, traceNode, traceNodeWithLevels, getGraphMetrics } from '../src/engine/graphBuilder';
import { assert, makeGraph, testPath, printSummary } from './testUtils';

// ─── Graph Builder ──────────────────────────────────────────────────────────

async function testGraphBuilder(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Graph Builder ──');

  const result = buildGraph(model);

  assert(result.flowNodes.length === model.nodes.length, `Flow nodes match: ${result.flowNodes.length}`);
  assert(result.flowEdges.length > 0, `Flow edges created: ${result.flowEdges.length}`);
  assert(result.graph.order > 0, `Graph order: ${result.graph.order}`);

  // Check positions
  const allPositioned = result.flowNodes.every(n => n.position.x !== undefined && n.position.y !== undefined);
  assert(allPositioned, 'All nodes have positions from dagre layout');

  // Check metrics
  const metrics = getGraphMetrics(result.graph);
  assert(metrics.totalNodes > 0, `Metrics: ${metrics.totalNodes} nodes, ${metrics.totalEdges} edges`);
  assert(metrics.rootNodes > 0, `Root nodes (in-degree 0): ${metrics.rootNodes}`);

  // Test trace
  const firstNodeId = model.nodes[0].id;
  const traceResult = traceNode(result.graph, firstNodeId, 'both');
  assert(traceResult.nodeIds.size >= 1, `Trace from ${firstNodeId}: ${traceResult.nodeIds.size} nodes reached`);

  return result;
}

// ─── Trace: No Siblings / Cross-Connections ─────────────────────────────────

function testTraceNoSiblings() {
  console.log('\n── Trace: No Siblings / Cross-Connections ──');

  const graph = new Graph({ type: 'directed', multi: false });

  // Graph: GP → P1 → X → C1, GP → P2 → X → C2, P1 → C1 (shortcut)
  for (const id of ['GP', 'P1', 'P2', 'X', 'C1', 'C2']) {
    graph.addNode(id, {});
  }
  graph.addEdgeWithKey('GP→P1', 'GP', 'P1');
  graph.addEdgeWithKey('GP→P2', 'GP', 'P2');
  graph.addEdgeWithKey('P1→X', 'P1', 'X');
  graph.addEdgeWithKey('P2→X', 'P2', 'X');
  graph.addEdgeWithKey('X→C1', 'X', 'C1');
  graph.addEdgeWithKey('X→C2', 'X', 'C2');
  graph.addEdgeWithKey('P1→C1', 'P1', 'C1'); // shortcut: upstream→downstream

  // Test traceNodeWithLevels: upstream=1, downstream=1
  const leveled = traceNodeWithLevels(graph, 'X', 1, 1);
  assert(leveled.nodeIds.has('P1'), 'Leveled: P1 (upstream) included');
  assert(leveled.nodeIds.has('P2'), 'Leveled: P2 (upstream) included');
  assert(leveled.nodeIds.has('C1'), 'Leveled: C1 (downstream) included');
  assert(leveled.nodeIds.has('C2'), 'Leveled: C2 (downstream) included');
  assert(!leveled.nodeIds.has('GP'), 'Leveled: GP (depth 2) excluded at level 1');
  assert(leveled.edgeIds.has('P1→X'), 'Leveled: P1→X edge included');
  assert(leveled.edgeIds.has('P2→X'), 'Leveled: P2→X edge included');
  assert(leveled.edgeIds.has('X→C1'), 'Leveled: X→C1 edge included');
  assert(leveled.edgeIds.has('X→C2'), 'Leveled: X→C2 edge included');
  assert(!leveled.edgeIds.has('P1→C1'), 'Leveled: P1→C1 cross-connection EXCLUDED');
  assert(!leveled.edgeIds.has('GP→P1'), 'Leveled: GP→P1 edge excluded (beyond level)');

  // Test traceNode (unlimited): upstream + downstream
  const unlimited = traceNode(graph, 'X', 'both');
  assert(unlimited.nodeIds.has('GP'), 'Unlimited: GP included');
  assert(unlimited.edgeIds.has('GP→P1'), 'Unlimited: GP→P1 included');
  assert(unlimited.edgeIds.has('P1→X'), 'Unlimited: P1→X included');
  assert(unlimited.edgeIds.has('X→C1'), 'Unlimited: X→C1 included');
  assert(!unlimited.edgeIds.has('P1→C1'), 'Unlimited: P1→C1 cross-connection EXCLUDED');

  // Test upstream-only
  const upOnly = traceNodeWithLevels(graph, 'X', 2, 0);
  assert(upOnly.nodeIds.has('GP'), 'UpOnly: GP included at level 2');
  assert(upOnly.edgeIds.has('GP→P1'), 'UpOnly: GP→P1 included');
  assert(upOnly.edgeIds.has('P1→X'), 'UpOnly: P1→X included');
  assert(!upOnly.edgeIds.has('X→C1'), 'UpOnly: X→C1 excluded (no downstream)');
}

// ─── Trace: Co-Writer Filter ────────────────────────────────────────────────

function testCoWriterFilter() {
  console.log('\n── Trace: Co-Writer Filter ──');

  const graph = new Graph({ type: 'directed', multi: false });

  // Graph models: Case3 reads+writes Final, Case1/Case4 only write Final,
  //               Case2 reads+writes Final (bidirectional), Case0 reads Final,
  //               Case3 reads Country, spLoad writes Country
  for (const id of ['Case3', 'Final', 'Country', 'Case1', 'Case2', 'Case4', 'Case0', 'spLoad']) {
    graph.addNode(id, { type: id.startsWith('Case') || id === 'spLoad' ? 'procedure' : 'table' });
  }
  // Case3 bidirectional with Final
  graph.addEdgeWithKey('Final→Case3', 'Final', 'Case3', { type: 'body' });   // read
  graph.addEdgeWithKey('Case3→Final', 'Case3', 'Final', { type: 'body' });   // write
  // Case3 reads Country
  graph.addEdgeWithKey('Country→Case3', 'Country', 'Case3', { type: 'body' });
  // Case1 only writes Final (pure co-writer)
  graph.addEdgeWithKey('Case1→Final', 'Case1', 'Final', { type: 'body' });
  // Case4 only writes Final (pure co-writer)
  graph.addEdgeWithKey('Case4→Final', 'Case4', 'Final', { type: 'body' });
  // Case2 bidirectional with Final (reads + writes)
  graph.addEdgeWithKey('Final→Case2', 'Final', 'Case2', { type: 'body' });
  graph.addEdgeWithKey('Case2→Final', 'Case2', 'Final', { type: 'body' });
  // Case0 reads Final (downstream)
  graph.addEdgeWithKey('Final→Case0', 'Final', 'Case0', { type: 'body' });
  // spLoad writes Country (upstream)
  graph.addEdgeWithKey('spLoad→Country', 'spLoad', 'Country', { type: 'body' });

  // Trace from Case3, 2 levels up and down
  const result = traceNodeWithLevels(graph, 'Case3', 2, 2);

  // Co-writers (only write, no read) should be EXCLUDED
  assert(!result.nodeIds.has('Case1'), 'Co-writer Case1 excluded');
  assert(!result.nodeIds.has('Case4'), 'Co-writer Case4 excluded');

  // Bidirectional (read+write) should be KEPT
  assert(result.nodeIds.has('Case2'), 'Bidirectional Case2 kept');

  // Downstream reader should be KEPT
  assert(result.nodeIds.has('Case0'), 'Downstream Case0 kept');

  // Upstream writer to different table should be KEPT
  assert(result.nodeIds.has('spLoad'), 'Upstream spLoad kept (writes Country, not a writeTarget)');

  // Tables should be KEPT
  assert(result.nodeIds.has('Final'), 'Table Final kept');
  assert(result.nodeIds.has('Country'), 'Table Country kept');

  // Edges to co-writers should be EXCLUDED
  assert(!result.edgeIds.has('Case1→Final'), 'Co-writer edge Case1→Final excluded');
  assert(!result.edgeIds.has('Case4→Final'), 'Co-writer edge Case4→Final excluded');

  // Test unlimited trace too
  const unlimited = traceNode(graph, 'Case3', 'both');
  assert(!unlimited.nodeIds.has('Case1'), 'Unlimited: Co-writer Case1 excluded');
  assert(!unlimited.nodeIds.has('Case4'), 'Unlimited: Co-writer Case4 excluded');
  assert(unlimited.nodeIds.has('Case2'), 'Unlimited: Bidirectional Case2 kept');
  assert(unlimited.nodeIds.has('spLoad'), 'Unlimited: Upstream spLoad kept');

  // Test TABLE as origin — filter must be a no-op (tables don't write)
  const tableTrace = traceNodeWithLevels(graph, 'Final', 2, 2);
  assert(tableTrace.nodeIds.has('Case1'), 'TableOrigin: Case1 kept (writer)');
  assert(tableTrace.nodeIds.has('Case2'), 'TableOrigin: Case2 kept (bidirectional)');
  assert(tableTrace.nodeIds.has('Case3'), 'TableOrigin: Case3 kept (bidirectional)');
  assert(tableTrace.nodeIds.has('Case4'), 'TableOrigin: Case4 kept (writer)');
  assert(tableTrace.nodeIds.has('Case0'), 'TableOrigin: Case0 kept (reader)');
  assert(!tableTrace.nodeIds.has('spLoad'), 'TableOrigin: spLoad excluded (depth 3, beyond level 2)');
  assert(tableTrace.nodeIds.has('Country'), 'TableOrigin: Country kept');
}

// ─── Synapse Dacpac: Trace No Siblings ──────────────────────────────────────

async function testSynapseTrace() {
  console.log('\n── Synapse Dacpac: Trace No Siblings ──');
  const dacpacPath = testPath('AdventureWorks_sdk-style.dacpac');
  const buffer = readFileSync(dacpacPath);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);

  // Check no bidirectional edges (the dacpacExtractor fix)
  const edgeKeys = new Set(model.edges.map(e => `${e.source}→${e.target}`));
  let bidir = 0;
  for (const e of model.edges) {
    const rev = `${e.target}→${e.source}`;
    if (edgeKeys.has(rev)) bidir++;
  }
  console.log(`  Bidirectional edge pairs: ${bidir / 2}`);

  // Build graph and trace a procedure with high connectivity
  const result = buildGraph(model);
  const graph = result.graph;

  // Find a procedure node with many connections to test trace
  const procs = model.nodes.filter(n => n.type === 'procedure');
  console.log(`  Procedures: ${procs.length}`);

  for (const proc of procs) {
    if (!graph.hasNode(proc.id)) continue;
    const inDeg = graph.inDegree(proc.id);
    const outDeg = graph.outDegree(proc.id);
    if (inDeg < 2 || outDeg < 1) continue;

    // Trace with upstream=2, downstream=2
    const traced = traceNodeWithLevels(graph, proc.id, 2, 2);

    // For every edge in the traced set, verify it flows in the correct BFS direction
    // i.e., no edge should connect two nodes that are BOTH only reachable via different directions
    const upNodes = new Set<string>();
    const downNodes = new Set<string>();
    bfsFromNode(graph, proc.id, (node: string, _: unknown, depth: number) => {
      if (depth > 2) return true;
      upNodes.add(node);
    }, { mode: 'inbound' });
    bfsFromNode(graph, proc.id, (node: string, _: unknown, depth: number) => {
      if (depth > 2) return true;
      downNodes.add(node);
    }, { mode: 'outbound' });

    // Siblings: upstream nodes that also have outbound edges to downstream nodes (bypassing traced node)
    let crossEdges = 0;
    for (const edgeId of traced.edgeIds) {
      const [src, tgt] = edgeId.split('→');
      // Cross-connection: source is upstream-only, target is downstream-only
      if (upNodes.has(src) && !downNodes.has(src) && downNodes.has(tgt) && !upNodes.has(tgt)) {
        crossEdges++;
      }
    }

    console.log(`  ${proc.id}: in=${inDeg} out=${outDeg} traced=${traced.nodeIds.size} nodes, ${traced.edgeIds.size} edges, cross=${crossEdges}`);
    assert(crossEdges === 0, `${proc.id}: no cross-connection edges in trace`);
  }
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('═══ Graph Builder Tests ═══');

  try {
    // Load dacpac for integration tests
    const buffer = readFileSync(testPath('AdventureWorks.dacpac'));
    const model = await extractDacpac(buffer.buffer as ArrayBuffer);

    await testGraphBuilder(model);
    testTraceNoSiblings();
    testCoWriterFilter();
    await testSynapseTrace();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Graph Builder');
}

main();
