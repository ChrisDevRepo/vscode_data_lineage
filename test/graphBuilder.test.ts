/**
 * Tests for graph construction, layout, and BFS trace algorithms.
 * Execute with: npx tsx test/graphBuilder.test.ts
 */

import { readFileSync } from 'fs';
import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { extractDacpac } from '../src/engine/dacpacExtractor';
import { buildGraph, traceNode, traceNodeWithLevels, getGraphMetrics } from '../src/engine/graphBuilder';
import { buildModel } from '../src/engine/modelBuilder';
import { assert, makeGraph, testPath, loadParseRules, printSummary } from './testUtils';

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
  assert(leveled.edgeIds.has('P1→C1'), 'Leveled: P1→C1 included (all edges between traced nodes)');
  assert(!leveled.edgeIds.has('GP→P1'), 'Leveled: GP→P1 edge excluded (beyond level)');

  // Test traceNode (unlimited): upstream + downstream
  const unlimited = traceNode(graph, 'X', 'both');
  assert(unlimited.nodeIds.has('GP'), 'Unlimited: GP included');
  assert(unlimited.edgeIds.has('GP→P1'), 'Unlimited: GP→P1 included');
  assert(unlimited.edgeIds.has('P1→X'), 'Unlimited: P1→X included');
  assert(unlimited.edgeIds.has('X→C1'), 'Unlimited: X→C1 included');
  assert(unlimited.edgeIds.has('P1→C1'), 'Unlimited: P1→C1 included (all edges between traced nodes)');

  // Test upstream-only: directional edge filtering
  const upOnly = traceNodeWithLevels(graph, 'X', 2, 0);
  assert(upOnly.nodeIds.has('GP'), 'UpOnly: GP included at level 2');
  assert(upOnly.edgeIds.has('GP→P1'), 'UpOnly: GP→P1 included (depth 2→1, toward origin)');
  assert(upOnly.edgeIds.has('GP→P2'), 'UpOnly: GP→P2 included (depth 2→1, toward origin)');
  assert(upOnly.edgeIds.has('P1→X'), 'UpOnly: P1→X included (depth 1→0, toward origin)');
  assert(upOnly.edgeIds.has('P2→X'), 'UpOnly: P2→X included (depth 1→0, toward origin)');
  assert(!upOnly.edgeIds.has('X→C1'), 'UpOnly: X→C1 excluded (C1 not in upstream set)');
  assert(!upOnly.edgeIds.has('X→C2'), 'UpOnly: X→C2 excluded (C2 not in upstream set)');
  assert(!upOnly.edgeIds.has('P1→C1'), 'UpOnly: P1→C1 excluded (C1 not in upstream set)');
  assert(upOnly.edgeIds.size === 4, `UpOnly: 4 upstream-flowing edges (got ${upOnly.edgeIds.size})`);

  // Test downstream-only: only edges flowing away from origin
  const downOnly = traceNodeWithLevels(graph, 'X', 0, 1);
  assert(downOnly.nodeIds.has('C1'), 'DownOnly: C1 included');
  assert(downOnly.nodeIds.has('C2'), 'DownOnly: C2 included');
  assert(!downOnly.nodeIds.has('P1'), 'DownOnly: P1 excluded (upstream)');
  assert(downOnly.edgeIds.has('X→C1'), 'DownOnly: X→C1 included');
  assert(downOnly.edgeIds.has('X→C2'), 'DownOnly: X→C2 included');
  assert(downOnly.edgeIds.size === 2, `DownOnly: 2 downstream-flowing edges (got ${downOnly.edgeIds.size})`);
}

// ─── Trace: Bidirectional BFS Correctness ───────────────────────────────────

function testBidirectionalTrace() {
  console.log('\n── Trace: Bidirectional BFS Correctness ──');

  const graph = new Graph({ type: 'directed', multi: false });

  // Graph: Table ← SP1 (bidirectional with TableA) ← TableA ← SP2 ← TableB
  // SP1 reads+writes TableA, reads Table (origin)
  for (const id of ['Table', 'SP1', 'TableA', 'SP2', 'TableB', 'SP3', 'TableC']) {
    graph.addNode(id, { type: id.startsWith('SP') ? 'procedure' : 'table' });
  }
  graph.addEdgeWithKey('SP1→Table', 'SP1', 'Table', { type: 'body' });     // SP1 writes Table
  graph.addEdgeWithKey('Table→SP1', 'Table', 'SP1', { type: 'body' });     // SP1 reads Table (bidirectional)
  graph.addEdgeWithKey('TableA→SP1', 'TableA', 'SP1', { type: 'body' });   // SP1 reads TableA
  graph.addEdgeWithKey('SP1→TableA', 'SP1', 'TableA', { type: 'body' });   // SP1 writes TableA (bidirectional)
  graph.addEdgeWithKey('SP2→TableA', 'SP2', 'TableA', { type: 'body' });   // SP2 writes TableA
  graph.addEdgeWithKey('TableB→SP2', 'TableB', 'SP2', { type: 'body' });   // SP2 reads TableB
  graph.addEdgeWithKey('SP3→TableB', 'SP3', 'TableB', { type: 'body' });   // SP3 writes TableB
  graph.addEdgeWithKey('TableC→SP3', 'TableC', 'SP3', { type: 'body' });   // SP3 reads TableC

  // Upstream trace from Table, 7 levels — should reach ALL nodes
  const result = traceNodeWithLevels(graph, 'Table', 7, 0);
  assert(result.nodeIds.has('SP1'), 'Bidir: SP1 reached (depth 1)');
  assert(result.nodeIds.has('TableA'), 'Bidir: TableA reached (depth 2) — through bidirectional SP1');
  assert(result.nodeIds.has('SP2'), 'Bidir: SP2 reached (depth 3) — continued past bidirectional');
  assert(result.nodeIds.has('TableB'), 'Bidir: TableB reached (depth 4)');
  assert(result.nodeIds.has('SP3'), 'Bidir: SP3 reached (depth 5)');
  assert(result.nodeIds.has('TableC'), 'Bidir: TableC reached (depth 6)');
  assert(result.nodeIds.size === 7, `Bidir: All 7 nodes in trace (got ${result.nodeIds.size})`);

  // Upstream-only: only edges flowing TOWARD origin (source.depth >= target.depth)
  // Excluded: Table→SP1 (depth 0→1, away from origin), SP1→TableA (depth 1→2, away)
  assert(result.edgeIds.has('SP1→Table'), 'Bidir-E: SP1→Table (depth 1→0, toward origin)');
  assert(!result.edgeIds.has('Table→SP1'), 'Bidir-E: Table→SP1 excluded (depth 0→1, away from origin)');
  assert(result.edgeIds.has('TableA→SP1'), 'Bidir-E: TableA→SP1 (depth 2→1, toward origin)');
  assert(!result.edgeIds.has('SP1→TableA'), 'Bidir-E: SP1→TableA excluded (depth 1→2, away from origin)');
  assert(result.edgeIds.has('SP2→TableA'), 'Bidir-E: SP2→TableA (depth 3→2, toward origin)');
  assert(result.edgeIds.has('TableB→SP2'), 'Bidir-E: TableB→SP2 (depth 4→3, toward origin)');
  assert(result.edgeIds.has('SP3→TableB'), 'Bidir-E: SP3→TableB (depth 5→4, toward origin)');
  assert(result.edgeIds.has('TableC→SP3'), 'Bidir-E: TableC→SP3 (depth 6→5, toward origin)');
  assert(result.edgeIds.size === 6, `Bidir-E: 6 upstream-flowing edges (got ${result.edgeIds.size})`);

  // Both directions active: ALL 8 edges shown (no filtering)
  const bothResult = traceNodeWithLevels(graph, 'Table', 7, 7);
  assert(bothResult.edgeIds.size === 8, `Bidir-Both: All 8 edges when both directions active (got ${bothResult.edgeIds.size})`);
  assert(bothResult.edgeIds.has('Table→SP1'), 'Bidir-Both: Table→SP1 included');
  assert(bothResult.edgeIds.has('SP1→TableA'), 'Bidir-Both: SP1→TableA included');

  // Depth-limited: 2 levels up from Table — should stop at TableA
  const limited = traceNodeWithLevels(graph, 'Table', 2, 0);
  assert(limited.nodeIds.has('SP1'), 'Bidir-L2: SP1 at depth 1');
  assert(limited.nodeIds.has('TableA'), 'Bidir-L2: TableA at depth 2');
  assert(!limited.nodeIds.has('SP2'), 'Bidir-L2: SP2 excluded (depth 3)');
  assert(limited.nodeIds.size === 3, `Bidir-L2: 3 nodes (got ${limited.nodeIds.size})`);
  assert(!limited.edgeIds.has('Table→SP1'), 'Bidir-L2: Table→SP1 excluded (away from origin)');
  assert(!limited.edgeIds.has('SP1→TableA'), 'Bidir-L2: SP1→TableA excluded (away from origin)');
  assert(limited.edgeIds.size === 2, `Bidir-L2: 2 upstream-flowing edges (got ${limited.edgeIds.size})`);

  // Determinism: run 50 times, results must be identical
  const baseNodes = [...result.nodeIds].sort().join(',');
  const baseEdges = [...result.edgeIds].sort().join(',');
  let allMatch = true;
  for (let i = 0; i < 50; i++) {
    const r = traceNodeWithLevels(graph, 'Table', 7, 0);
    if ([...r.nodeIds].sort().join(',') !== baseNodes) allMatch = false;
    if ([...r.edgeIds].sort().join(',') !== baseEdges) allMatch = false;
  }
  assert(allMatch, 'Bidir-Det: 50 runs produce identical results');

  // Unlimited upstream trace — same directional filtering
  const unlimited = traceNode(graph, 'Table', 'upstream');
  assert(unlimited.nodeIds.size === 7, `Bidir-Unl: All 7 nodes (got ${unlimited.nodeIds.size})`);
  assert(unlimited.edgeIds.size === 6, `Bidir-Unl: 6 upstream-flowing edges (got ${unlimited.edgeIds.size})`);
  assert(!unlimited.edgeIds.has('Table→SP1'), 'Bidir-Unl: Table→SP1 excluded (away from origin)');

  // Unlimited both — all edges
  const unlBoth = traceNode(graph, 'Table', 'both');
  assert(unlBoth.edgeIds.size === 8, `Bidir-UnlBoth: All 8 edges (got ${unlBoth.edgeIds.size})`);
}

// ─── Trace: Cycle Direction Filtering ────────────────────────────────────────

function testCycleDirectionalFiltering() {
  console.log('\n── Trace: Cycle Direction Filtering ──');

  const graph = new Graph({ type: 'directed', multi: false });

  // Cycle: A → B → C → A
  for (const id of ['A', 'B', 'C']) graph.addNode(id, {});
  graph.addEdgeWithKey('A→B', 'A', 'B');
  graph.addEdgeWithKey('B→C', 'B', 'C');
  graph.addEdgeWithKey('C→A', 'C', 'A');

  // Upstream from A: BFS inbound finds C(depth 1 via C→A), B(depth 2 via B→C)
  const up = traceNodeWithLevels(graph, 'A', 7, 0);
  assert(up.nodeIds.size === 3, `Cycle-Up: All 3 cycle nodes (got ${up.nodeIds.size})`);
  assert(up.edgeIds.has('C→A'), 'Cycle-Up: C→A included (depth 1→0, toward origin)');
  assert(up.edgeIds.has('B→C'), 'Cycle-Up: B→C included (depth 2→1, toward origin)');
  assert(!up.edgeIds.has('A→B'), 'Cycle-Up: A→B excluded (depth 0→2, away from origin = back-edge)');
  assert(up.edgeIds.size === 2, `Cycle-Up: 2 upstream-flowing edges (got ${up.edgeIds.size})`);

  // Downstream from A: BFS outbound finds B(depth 1 via A→B), C(depth 2 via B→C)
  const down = traceNodeWithLevels(graph, 'A', 0, 7);
  assert(down.nodeIds.size === 3, `Cycle-Down: All 3 cycle nodes (got ${down.nodeIds.size})`);
  assert(down.edgeIds.has('A→B'), 'Cycle-Down: A→B included (depth 0→1, away from origin)');
  assert(down.edgeIds.has('B→C'), 'Cycle-Down: B→C included (depth 1→2, away from origin)');
  assert(!down.edgeIds.has('C→A'), 'Cycle-Down: C→A excluded (depth 2→0, back toward origin)');
  assert(down.edgeIds.size === 2, `Cycle-Down: 2 downstream-flowing edges (got ${down.edgeIds.size})`);

  // Both directions: all 3 edges shown
  const both = traceNodeWithLevels(graph, 'A', 7, 7);
  assert(both.edgeIds.size === 3, `Cycle-Both: All 3 edges (got ${both.edgeIds.size})`);

  // Unlimited modes
  const unlUp = traceNode(graph, 'A', 'upstream');
  assert(unlUp.edgeIds.size === 2, `Cycle-UnlUp: 2 upstream edges (got ${unlUp.edgeIds.size})`);
  assert(!unlUp.edgeIds.has('A→B'), 'Cycle-UnlUp: A→B excluded');

  const unlDown = traceNode(graph, 'A', 'downstream');
  assert(unlDown.edgeIds.size === 2, `Cycle-UnlDown: 2 downstream edges (got ${unlDown.edgeIds.size})`);
  assert(!unlDown.edgeIds.has('C→A'), 'Cycle-UnlDown: C→A excluded');

  const unlBoth = traceNode(graph, 'A', 'both');
  assert(unlBoth.edgeIds.size === 3, `Cycle-UnlBoth: All 3 edges (got ${unlBoth.edgeIds.size})`);
}

// ─── Trace: Same-Depth Cross-Edges ──────────────────────────────────────────

function testSameDepthCrossEdges() {
  console.log('\n── Trace: Same-Depth Cross-Edges ──');

  const graph = new Graph({ type: 'directed', multi: false });

  // Diamond: A → B, A → C, B → D, C → D, plus cross-edge B → C (same depth)
  for (const id of ['A', 'B', 'C', 'D']) graph.addNode(id, {});
  graph.addEdgeWithKey('A→B', 'A', 'B');
  graph.addEdgeWithKey('A→C', 'A', 'C');
  graph.addEdgeWithKey('B→D', 'B', 'D');
  graph.addEdgeWithKey('C→D', 'C', 'D');
  graph.addEdgeWithKey('B→C', 'B', 'C'); // same-depth cross-edge

  // Upstream from D, 2 levels: finds B(1), C(1), A(2) — B and C at same depth
  const up = traceNodeWithLevels(graph, 'D', 2, 0);
  assert(up.nodeIds.size === 4, `Diamond-Up: All 4 nodes (got ${up.nodeIds.size})`);
  assert(up.edgeIds.has('B→D'), 'Diamond-Up: B→D included (depth 1→0)');
  assert(up.edgeIds.has('C→D'), 'Diamond-Up: C→D included (depth 1→0)');
  assert(up.edgeIds.has('A→B'), 'Diamond-Up: A→B included (depth 2→1)');
  assert(up.edgeIds.has('A→C'), 'Diamond-Up: A→C included (depth 2→1)');
  assert(up.edgeIds.has('B→C'), 'Diamond-Up: B→C included (same depth 1→1, >= passes)');
  assert(up.edgeIds.size === 5, `Diamond-Up: 5 edges including same-depth (got ${up.edgeIds.size})`);

  // Downstream from A, 2 levels: B(1), C(1), D(2)
  const down = traceNodeWithLevels(graph, 'A', 0, 2);
  assert(down.edgeIds.has('B→C'), 'Diamond-Down: B→C included (same depth 1→1)');
  assert(down.edgeIds.size === 5, `Diamond-Down: 5 edges including same-depth (got ${down.edgeIds.size})`);
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

    // Verify all traced edges connect traced nodes (no phantom edges)
    let phantomEdges = 0;
    for (const edgeId of traced.edgeIds) {
      const src = graph.source(edgeId);
      const tgt = graph.target(edgeId);
      if (!traced.nodeIds.has(src) || !traced.nodeIds.has(tgt)) {
        phantomEdges++;
      }
    }

    console.log(`  ${proc.id}: in=${inDeg} out=${outDeg} traced=${traced.nodeIds.size} nodes, ${traced.edgeIds.size} edges, phantom=${phantomEdges}`);
    assert(phantomEdges === 0, `${proc.id}: no phantom edges (endpoints outside trace)`);
  }
}

// ─── Virtual External Nodes: Model Building ─────────────────────────────────

function testVirtualNodeBuilding() {
  console.log('\n── Virtual External Nodes: Model Building ──');
  loadParseRules();

  // SP reads from OPENROWSET and references a cross-DB table
  const objects = [
    {
      fullName: '[dbo].[spLoadSales]',
      type: 'procedure' as const,
      bodyScript: `
        CREATE PROCEDURE [dbo].[spLoadSales] AS
        INSERT INTO dbo.Sales
        SELECT * FROM OPENROWSET(BULK 'https://storage.blob.core.windows.net/data/sales_2024.parquet',
          FORMAT = 'PARQUET') AS src
        UNION ALL
        SELECT * FROM Staging.dbo.Orders
      `,
    },
    { fullName: '[dbo].[Sales]', type: 'table' as const },
  ];
  const deps = [{ sourceName: '[dbo].[spLoadSales]', targetName: '[dbo].[Sales]' }];

  const model = buildModel(objects, deps);

  // File virtual node created for OPENROWSET URL
  const fileNode = model.nodes.find(n => n.externalType === 'file');
  assert(!!fileNode, 'VN: OPENROWSET creates file virtual node');
  assert(fileNode!.schema === '', 'VN: File virtual node has empty schema');
  assert(fileNode!.externalUrl === 'https://storage.blob.core.windows.net/data/sales_2024.parquet', 'VN: File node stores full URL');
  assert(fileNode!.name === 'sales_2024.parquet', 'VN: File node name is last URL segment');
  assert(fileNode!.id.startsWith('[__ext__].'), 'VN: File node ID starts with [__ext__]');

  // Edge from file node → SP (data source)
  const fileEdge = model.edges.find(e => e.source === fileNode!.id && e.target === '[dbo].[sploadsales]');
  assert(!!fileEdge, 'VN: File → SP edge exists (data source)');

  // Cross-DB virtual node created for Staging.dbo.Orders
  const crossDbNode = model.nodes.find(n => n.externalType === 'db');
  assert(!!crossDbNode, 'VN: 3-part name creates cross-DB virtual node');
  assert(crossDbNode!.schema === '', 'VN: Cross-DB node has empty schema');
  assert(crossDbNode!.externalDatabase === 'staging', 'VN: Cross-DB node stores database name');
  assert(crossDbNode!.name === 'dbo.orders', 'VN: Cross-DB node name is schema.object');

  // Edge from cross-DB → SP (data source)
  const crossDbEdge = model.edges.find(e => e.source === crossDbNode!.id);
  assert(!!crossDbEdge, 'VN: Cross-DB → SP edge exists (data source)');

  // Catalog includes virtual nodes
  assert(!!model.catalog[fileNode!.id], 'VN: File node in catalog');
  assert(!!model.catalog[crossDbNode!.id], 'VN: Cross-DB node in catalog');
  assert(model.catalog[fileNode!.id].externalType === 'file', 'VN: Catalog entry has externalType=file');
  assert(model.catalog[crossDbNode!.id].externalType === 'db', 'VN: Catalog entry has externalType=db');
}

// ─── Virtual Nodes: BFS Trace Traversal ──────────────────────────────────────

function testVirtualNodeTrace() {
  console.log('\n── Virtual Nodes: BFS Trace Traversal ──');

  // Build a graph with a virtual file node: FileNode → SP → Table
  const graph = new Graph({ type: 'directed', multi: false });
  for (const id of ['FileNode', 'SP1', 'Table1']) {
    graph.addNode(id, { type: id === 'FileNode' ? 'external' : id.startsWith('SP') ? 'procedure' : 'table' });
  }
  graph.addEdgeWithKey('FileNode→SP1', 'FileNode', 'SP1', { type: 'body' });
  graph.addEdgeWithKey('SP1→Table1', 'SP1', 'Table1', { type: 'body' });

  // Trace from SP1 should include FileNode (upstream) and Table1 (downstream)
  const traced = traceNode(graph, 'SP1', 'both');
  assert(traced.nodeIds.has('FileNode'), 'VN-BFS: FileNode reachable upstream from SP1');
  assert(traced.nodeIds.has('Table1'), 'VN-BFS: Table1 reachable downstream from SP1');
  assert(traced.edgeIds.has('FileNode→SP1'), 'VN-BFS: FileNode→SP1 edge in trace');
  assert(traced.edgeIds.has('SP1→Table1'), 'VN-BFS: SP1→Table1 edge in trace');

  // Trace with levels: upstream=1 from Table1 should reach SP1 but not FileNode
  const leveled = traceNodeWithLevels(graph, 'Table1', 1, 0);
  assert(leveled.nodeIds.has('SP1'), 'VN-BFS-L1: SP1 reachable at depth 1');
  assert(!leveled.nodeIds.has('FileNode'), 'VN-BFS-L1: FileNode not reachable at depth 1');

  // Trace with levels: upstream=2 from Table1 should reach FileNode
  const leveled2 = traceNodeWithLevels(graph, 'Table1', 2, 0);
  assert(leveled2.nodeIds.has('FileNode'), 'VN-BFS-L2: FileNode reachable at depth 2');
  assert(leveled2.edgeIds.has('FileNode→SP1'), 'VN-BFS-L2: FileNode→SP1 edge in trace');
}

// ─── Virtual Nodes: Same-DB 3-Part Ref → Local ──────────────────────────────

function testSameDbResolution() {
  console.log('\n── Virtual Nodes: Same-DB 3-Part Resolution ──');

  // SP references MyDB.dbo.Sales — same DB, should resolve locally
  const objects = [
    {
      fullName: '[dbo].[spLoad]',
      type: 'procedure' as const,
      bodyScript: `
        CREATE PROCEDURE [dbo].[spLoad] AS
        SELECT * FROM MyDB.dbo.Sales
      `,
    },
    { fullName: '[dbo].[Sales]', type: 'table' as const },
  ];
  const deps = [{ sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' }];

  // DMV path: currentDatabase = 'MyDB' → same-DB ref treated as local
  const model = buildModel(objects, deps, undefined, 'MyDB');
  const crossDbNode = model.nodes.find(n => n.externalType === 'db');
  assert(!crossDbNode, 'VN-SameDB-DMV: No cross-DB node created for same-DB ref');

  // Dacpac path: no currentDatabase but [dbo].[sales] exists → treated as local
  const model2 = buildModel(objects, deps);
  const crossDbNode2 = model2.nodes.find(n => n.externalType === 'db');
  assert(!crossDbNode2, 'VN-SameDB-Dacpac: No cross-DB node when local node exists');
}

// ─── Virtual Nodes: OPENROWSET Dedup ─────────────────────────────────────────

function testOpenrowsetDedup() {
  console.log('\n── Virtual Nodes: OPENROWSET Dedup ──');

  // Two SPs reference the same OPENROWSET URL → should create only 1 virtual node
  const url = 'https://storage.blob.core.windows.net/data/shared.csv';
  const objects = [
    {
      fullName: '[dbo].[spA]',
      type: 'procedure' as const,
      bodyScript: `CREATE PROCEDURE [dbo].[spA] AS SELECT * FROM OPENROWSET(BULK '${url}', FORMAT = 'CSV') AS r`,
    },
    {
      fullName: '[dbo].[spB]',
      type: 'procedure' as const,
      bodyScript: `CREATE PROCEDURE [dbo].[spB] AS SELECT * FROM OPENROWSET(BULK '${url}', FORMAT = 'CSV') AS r`,
    },
  ];

  const model = buildModel(objects, []);
  const fileNodes = model.nodes.filter(n => n.externalType === 'file');
  assert(fileNodes.length === 1, `VN-Dedup: Same URL creates 1 virtual node (got ${fileNodes.length})`);

  // Both SPs should have edges from the same file node
  const fileId = fileNodes[0].id;
  const fileEdges = model.edges.filter(e => e.source === fileId);
  assert(fileEdges.length === 2, `VN-Dedup: File node has 2 edges to both SPs (got ${fileEdges.length})`);
}

// ─── Virtual Nodes: COPY INTO + BULK INSERT ──────────────────────────────────

function testCopyIntoBulkInsert() {
  console.log('\n── Virtual Nodes: COPY INTO + BULK INSERT ──');

  const objects = [
    {
      fullName: '[dbo].[spCopy]',
      type: 'procedure' as const,
      bodyScript: `
        CREATE PROCEDURE [dbo].[spCopy] AS
        COPY INTO dbo.FactSales
        FROM 'https://datalake.dfs.core.windows.net/raw/fact_sales/*.parquet'
        WITH (FILE_TYPE = 'PARQUET')
      `,
    },
    {
      fullName: '[dbo].[spBulk]',
      type: 'procedure' as const,
      bodyScript: `
        CREATE PROCEDURE [dbo].[spBulk] AS
        BULK INSERT dbo.DimProduct
        FROM '\\\\fileserver\\share\\products.csv'
        WITH (FIELDTERMINATOR = ',')
      `,
    },
    { fullName: '[dbo].[FactSales]', type: 'table' as const },
    { fullName: '[dbo].[DimProduct]', type: 'table' as const },
  ];

  const model = buildModel(objects, []);
  const fileNodes = model.nodes.filter(n => n.externalType === 'file');
  assert(fileNodes.length === 2, `VN-CopyBulk: 2 file nodes for COPY INTO + BULK INSERT (got ${fileNodes.length})`);

  const copyNode = fileNodes.find(n => n.externalUrl?.includes('fact_sales'));
  assert(!!copyNode, 'VN-CopyBulk: COPY INTO file node created');

  const bulkNode = fileNodes.find(n => n.externalUrl?.includes('products.csv'));
  assert(!!bulkNode, 'VN-CopyBulk: BULK INSERT file node created');
}

// ─── Virtual Nodes: CETAS Target ─────────────────────────────────────────────

function testCetasTarget() {
  console.log('\n── Virtual Nodes: CETAS Target ──');

  // CETAS: CREATE EXTERNAL TABLE AS SELECT → target should be extracted
  const objects = [
    {
      fullName: '[dbo].[spExport]',
      type: 'procedure' as const,
      bodyScript: `
        CREATE PROCEDURE [dbo].[spExport] AS
        CREATE EXTERNAL TABLE ext.SalesExport
        WITH (LOCATION = '/export/sales/', DATA_SOURCE = MyDataSource)
        AS SELECT * FROM dbo.Sales
      `,
    },
    { fullName: '[dbo].[Sales]', type: 'table' as const },
    { fullName: '[ext].[SalesExport]', type: 'external' as const, externalType: 'et' as const },
  ];
  const deps = [
    { sourceName: '[dbo].[spExport]', targetName: '[dbo].[Sales]' },
  ];

  const model = buildModel(objects, deps);
  // The CETAS regex should detect ext.SalesExport as a target
  const spNode = model.nodes.find(n => n.id === '[dbo].[spexport]');
  const etNode = model.nodes.find(n => n.id === '[ext].[salesexport]');
  assert(!!spNode, 'CETAS: SP node exists');
  assert(!!etNode, 'CETAS: External table node exists');

  // Check edge: SP → ET (write target)
  const cetasEdge = model.edges.find(e =>
    e.source === '[dbo].[spexport]' && e.target === '[ext].[salesexport]'
  );
  assert(!!cetasEdge, 'CETAS: SP → External Table edge exists (write target)');
}

// ─── Virtual Nodes: Budget Exhaustion (maxNodes cap) ─────────────────────────

function testVirtualNodeBudgetExhaustion() {
  console.log('\n── Virtual Nodes: Budget Exhaustion (maxNodes cap) ──');

  // 3 real nodes + maxNodes=3 → budget=0 → no virtual nodes created
  const objects = [
    { fullName: '[dbo].[Sales]', type: 'table' as const },
    { fullName: '[dbo].[Products]', type: 'table' as const },
    {
      fullName: '[dbo].[spLoad]',
      type: 'procedure' as const,
      bodyScript: `CREATE PROCEDURE [dbo].[spLoad] AS
        SELECT * FROM OPENROWSET(BULK 'https://lake/data.parquet', FORMAT='PARQUET') AS r
        UNION ALL SELECT * FROM OtherDB.dbo.Remote`,
    },
  ];
  const deps = [
    { sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' },
  ];

  const model = buildModel(objects, deps, undefined, undefined, true, 3); // maxNodes=3
  const virtualNodes = model.nodes.filter(n => n.externalType === 'file' || n.externalType === 'db');
  assert(virtualNodes.length === 0, 'Budget: no virtual nodes when maxNodes=realNodes');
  assert(model.nodes.length === 3, 'Budget: only real nodes present');
}

// ─── Virtual Nodes: Mixed OPENROWSET + Cross-DB + Local ──────────────────────

function testMixedExternalRefs() {
  console.log('\n── Virtual Nodes: Mixed OPENROWSET + Cross-DB + Local ──');

  const objects = [
    { fullName: '[dbo].[FactSales]', type: 'table' as const },
    { fullName: '[dim].[Product]', type: 'table' as const },
    {
      fullName: '[dbo].[spETL]',
      type: 'procedure' as const,
      bodyScript: `CREATE PROCEDURE [dbo].[spETL] AS
        INSERT INTO [dbo].[FactSales]
        SELECT p.*, r.* FROM [dim].[Product] p
        CROSS JOIN OPENROWSET(BULK 'https://lake/raw.parquet', FORMAT='PARQUET') AS r
        UNION ALL
        SELECT * FROM Staging.dbo.Orders`,
    },
  ];
  const deps = [
    { sourceName: '[dbo].[spETL]', targetName: '[dbo].[FactSales]' },
    { sourceName: '[dbo].[spETL]', targetName: '[dim].[Product]' },
  ];

  const model = buildModel(objects, deps);

  // Local edges
  const writeEdge = model.edges.find(e => e.source === '[dbo].[spetl]' && e.target === '[dbo].[factsales]');
  assert(!!writeEdge, 'Mixed: SP → FactSales (write) edge');
  const readEdge = model.edges.find(e => e.source === '[dim].[product]' && e.target === '[dbo].[spetl]');
  assert(!!readEdge, 'Mixed: Product → SP (read) edge');

  // File virtual node
  const fileNode = model.nodes.find(n => n.externalType === 'file');
  assert(!!fileNode, 'Mixed: file virtual node created');
  const fileEdge = model.edges.find(e => e.source === fileNode!.id && e.target === '[dbo].[spetl]');
  assert(!!fileEdge, 'Mixed: file → SP edge');

  // Cross-DB virtual node
  const crossDbNode = model.nodes.find(n => n.externalType === 'db');
  assert(!!crossDbNode, 'Mixed: cross-DB virtual node created');
  const crossDbEdge = model.edges.find(e => e.source === crossDbNode!.id && e.target === '[dbo].[spetl]');
  assert(!!crossDbEdge, 'Mixed: cross-DB → SP edge (source)');

  // Total: 3 real + 2 virtual = 5
  assert(model.nodes.length === 5, `Mixed: 3 real + 2 virtual = 5 total (got ${model.nodes.length})`);
}

// ─── Virtual Nodes: Cross-DB Write Direction ─────────────────────────────────

function testCrossDbWriteDirection() {
  console.log('\n── Virtual Nodes: Cross-DB Write Direction ──');

  const objects = [
    { fullName: '[dbo].[LocalData]', type: 'table' as const },
    {
      fullName: '[dbo].[spArchive]',
      type: 'procedure' as const,
      bodyScript: `CREATE PROCEDURE [dbo].[spArchive] AS
        INSERT INTO ArchiveDB.dbo.ArchivedSales
        SELECT * FROM [dbo].[LocalData]`,
    },
  ];
  const deps = [
    { sourceName: '[dbo].[spArchive]', targetName: '[dbo].[LocalData]' },
  ];

  const model = buildModel(objects, deps);
  const crossDbNode = model.nodes.find(n => n.externalType === 'db');
  assert(!!crossDbNode, 'CrossDB-Write: virtual node created for target');

  // Edge should be SP → cross-DB (write direction)
  const writeEdge = model.edges.find(e =>
    e.source === '[dbo].[sparchive]' && e.target === crossDbNode!.id
  );
  assert(!!writeEdge, 'CrossDB-Write: SP → cross-DB edge (outbound write)');

  // Read edge from LocalData → SP should also exist
  const readEdge = model.edges.find(e =>
    e.source === '[dbo].[localdata]' && e.target === '[dbo].[sparchive]'
  );
  assert(!!readEdge, 'CrossDB-Write: LocalData → SP read edge exists');
}

// ─── Virtual Nodes: externalRefsEnabled=false ────────────────────────────────

function testExternalRefsDisabled() {
  console.log('\n── Virtual Nodes: externalRefsEnabled=false ──');

  const objects = [
    { fullName: '[dbo].[Sales]', type: 'table' as const },
    {
      fullName: '[dbo].[spLoad]',
      type: 'procedure' as const,
      bodyScript: `CREATE PROCEDURE [dbo].[spLoad] AS
        SELECT * FROM OPENROWSET(BULK 'https://lake/data.parquet', FORMAT='PARQUET') AS r
        UNION ALL SELECT * FROM OtherDB.dbo.Remote`,
    },
  ];
  const deps = [{ sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' }];

  const model = buildModel(objects, deps, undefined, undefined, false); // disabled
  const virtualNodes = model.nodes.filter(n => n.externalType === 'file' || n.externalType === 'db');
  assert(virtualNodes.length === 0, 'Disabled: no virtual nodes when externalRefsEnabled=false');
  assert(model.nodes.length === 2, 'Disabled: only 2 real nodes');
}

// ─── CLR Method Virtual Node Suppression ─────────────────────────────────────

function testClrMethodVirtualNodeSuppression() {
  console.log('\n── CLR Method Virtual Node Suppression ──');

  // ── B2 path: DMV-reported 3-part bracketed CLR method names ──────────────
  // sys.sql_expression_dependencies can report HierarchyID/XML/geometry method
  // calls as cross-DB refs: [EMP_cte].[OrganizationNode].[GetAncestor] looks
  // identical to [db].[schema].[object] — must be suppressed.

  function noCrossDbNode(targetName: string, label: string) {
    const objects = [
      { fullName: '[dbo].[spTest]', type: 'procedure' as const,
        bodyScript: 'CREATE PROCEDURE [dbo].[spTest] AS SELECT 1' },
    ];
    const deps = [{ sourceName: '[dbo].[spTest]', targetName }];
    const model = buildModel(objects, deps);
    const dbNode = model.nodes.find(n => n.externalType === 'db');
    assert(!dbNode, `CLR-B2: ${label} → no virtual node`);
  }

  noCrossDbNode('[EMP_cte].[OrganizationNode].[GetAncestor]', 'HierarchyID GetAncestor');
  noCrossDbNode('[EMP_cte].[OrganizationNode].[ToString]', 'HierarchyID ToString');
  noCrossDbNode('[EMP_cte].[OrganizationNode].[GetLevel]', 'HierarchyID GetLevel');
  noCrossDbNode('[jc].[Resume].[nodes]', 'XML nodes');
  noCrossDbNode('[ref].[col].[value]', 'XML value');
  noCrossDbNode('[loc].[point].[STDistance]', 'Geometry STDistance');

  // ── B1 path: regex-captured 3-part CLR method calls (via normalizeCrossDb) ─
  // extract_udf_calls captures `alias.column.GetAncestor(` as 3-part name.
  // normalizeCrossDb must reject these before they become virtual nodes.

  const spWithClrMethods = {
    fullName: '[dbo].[spHierarchy]',
    type: 'procedure' as const,
    bodyScript: `
      CREATE PROCEDURE [dbo].[spHierarchy] AS
      SELECT EMP_cte.OrganizationNode.GetAncestor(1),
             EMP_cte.OrganizationNode.ToString(),
             jc.Resume.nodes('/n:n/@id', 'varchar(max)'),
             loc.point.STDistance(geography::Point(0,0,4326))
      FROM dbo.Employees
    `,
  };
  const modelRegex = buildModel(
    [spWithClrMethods, { fullName: '[dbo].[Employees]', type: 'table' as const }],
    [{ sourceName: '[dbo].[spHierarchy]', targetName: '[dbo].[Employees]' }],
  );
  const dbNodesRegex = modelRegex.nodes.filter(n => n.externalType === 'db');
  assert(dbNodesRegex.length === 0, `CLR-B1: no virtual DB nodes from CLR method captures (got ${dbNodesRegex.length})`);

  // ── Sanity: real 3-part cross-DB ref still creates virtual node ───────────
  const spWithCrossDb = {
    fullName: '[dbo].[spArchive]',
    type: 'procedure' as const,
    bodyScript: `
      CREATE PROCEDURE [dbo].[spArchive] AS
      INSERT INTO ArchiveDB.dbo.ArchivedSales
      SELECT * FROM dbo.Source
    `,
  };
  const modelCrossDb = buildModel(
    [spWithCrossDb, { fullName: '[dbo].[Source]', type: 'table' as const }],
    [{ sourceName: '[dbo].[spArchive]', targetName: '[dbo].[Source]' }],
  );
  const dbNodesCrossDb = modelCrossDb.nodes.filter(n => n.externalType === 'db');
  assert(dbNodesCrossDb.length === 1, `CLR-Sanity: real cross-DB INSERT INTO creates 1 virtual node (got ${dbNodesCrossDb.length})`);
  assert(dbNodesCrossDb[0].externalDatabase === 'archivedb', 'CLR-Sanity: cross-DB node stores database name');

  // Non-CLR cross-DB ref in SQL body: real table name not in CLR list → creates node.
  // This verifies the filter is name-based, not blanket-blocking all 3-part names.
  const objectsReal = [
    {
      fullName: '[dbo].[spCrossDb]',
      type: 'procedure' as const,
      bodyScript: 'CREATE PROCEDURE [dbo].[spCrossDb] AS SELECT * FROM [OtherDB].[dbo].[FactSales]',
    },
  ];
  const modelReal = buildModel(objectsReal, []);
  const dbNodesReal = modelReal.nodes.filter(n => n.externalType === 'db');
  assert(dbNodesReal.length === 1, 'CLR-NonCLR: [OtherDB].[dbo].[FactSales] → virtual node created (real table name)');
  assert(dbNodesReal[0].externalDatabase === 'otherdb', 'CLR-NonCLR: correct database name stored');
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
    testBidirectionalTrace();
    testCycleDirectionalFiltering();
    testSameDepthCrossEdges();
    await testSynapseTrace();
    testVirtualNodeBuilding();
    testVirtualNodeTrace();
    testSameDbResolution();
    testOpenrowsetDedup();
    testCopyIntoBulkInsert();
    testCetasTarget();
    testVirtualNodeBudgetExhaustion();
    testMixedExternalRefs();
    testCrossDbWriteDirection();
    testExternalRefsDisabled();
    testClrMethodVirtualNodeSuppression();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Graph Builder');
}

main();
