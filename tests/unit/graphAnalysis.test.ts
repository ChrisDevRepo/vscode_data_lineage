/**
 * Unit tests for graph analysis functions.
 * Execute with: npx tsx test/graphAnalysis.test.ts
 */

import Graph from 'graphology';
import {
  analyzeIslands,
  analyzeHubs,
  analyzeOrphans,
  analyzeLongestPath,
  analyzeCycles,
  analyzeExternalRefs,
} from '../../src/engine/graphAnalysis';
import { assert, assertEq, makeGraph, printSummary } from './helpers/testUtils';

// ─── analyzeIslands ──────────────────────────────────────────────────────────

function testIslands() {
  console.log('\n── analyzeIslands ──');

  // Two disconnected 2-node components
  const g1 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['A', 'B'], ['C', 'D']]
  );
  const r1 = analyzeIslands(g1, 2);
  assert(r1.type === 'islands', 'type is islands');
  assert(r1.groups.length === 2, `2 islands detected (got ${r1.groups.length})`);

  // Single connected graph with 3 nodes → 1 island (if maxSize allows)
  const g2 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B'], ['B', 'C']]
  );
  const r2 = analyzeIslands(g2, 3);
  assert(r2.groups.length === 1, `1 island for connected graph (got ${r2.groups.length})`);

  // maxSize=2 filters out 3-node component
  const r2b = analyzeIslands(g2, 2);
  assert(r2b.groups.length === 0, `maxSize=2 filters 3-node island (got ${r2b.groups.length})`);

  // maxSize=2 keeps size-2 islands
  const r4 = analyzeIslands(g1, 2);
  assert(r4.groups.length === 2, `maxSize=2 keeps size-2 islands (got ${r4.groups.length})`);

  // Empty graph
  const g3 = new Graph({ type: 'directed', multi: false });
  const r5 = analyzeIslands(g3, 2);
  assert(r5.groups.length === 0, 'empty graph → 0 islands');

  // Isolated nodes are NOT islands (need 2+ nodes) — they go to Orphan analysis
  const g4 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    []
  );
  const r6 = analyzeIslands(g4, 2);
  assert(r6.groups.length === 0, `3 isolated nodes → 0 islands (orphans, not islands) (got ${r6.groups.length})`);

  // Mixed: 2-node island + 1 orphan → only the 2-node island returned
  const g5 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B']]
  );
  const r7 = analyzeIslands(g5, 2);
  assert(r7.groups.length === 1, `1 island (2-node), orphan C excluded (got ${r7.groups.length})`);
  assert(r7.groups[0].nodeIds.length === 2, `island has 2 nodes (got ${r7.groups[0].nodeIds.length})`);
}

// ─── analyzeHubs ─────────────────────────────────────────────────────────────

function testHubs() {
  console.log('\n── analyzeHubs ──');

  // Hub node with high degree
  const g1 = makeGraph(
    [
      { id: 'hub', type: 'table' },
      { id: 'sp1', type: 'procedure' }, { id: 'sp2', type: 'procedure' },
      { id: 'sp3', type: 'procedure' }, { id: 'sp4', type: 'procedure' },
    ],
    [['hub', 'sp1'], ['hub', 'sp2'], ['hub', 'sp3'], ['hub', 'sp4']]
  );
  const r1 = analyzeHubs(g1, 3);
  assert(r1.type === 'hubs', 'type is hubs');
  assert(r1.groups.length === 1, `1 hub with degree ≥3 (got ${r1.groups.length})`);
  assert(r1.groups[0].meta?.outDegree === 4, `hub outDegree=4 (got ${r1.groups[0].meta?.outDegree})`);
  assert(r1.groups[0].meta?.inDegree === 0, `hub inDegree=0 (got ${r1.groups[0].meta?.inDegree})`);

  // No nodes meet minDegree
  const r2 = analyzeHubs(g1, 10);
  assert(r2.groups.length === 0, `no hubs with degree ≥10 (got ${r2.groups.length})`);

  // Bidirectional edge → degree counts both directions
  const g2 = makeGraph(
    [{ id: 'A', type: 'procedure' }, { id: 'B', type: 'table' }],
    [['A', 'B'], ['B', 'A']]
  );
  const r3 = analyzeHubs(g2, 2);
  assert(r3.groups.length === 2, `both nodes are hubs with bidirectional edge (got ${r3.groups.length})`);
  // Each node has inDegree=1, outDegree=1, degree=2
  for (const grp of r3.groups) {
    assert(grp.meta?.degree === 2, `${grp.label} degree=2 (got ${grp.meta?.degree})`);
  }

  // Empty graph
  const g3 = new Graph({ type: 'directed', multi: false });
  const r4 = analyzeHubs(g3, 1);
  assert(r4.groups.length === 0, 'empty graph → 0 hubs');

  // Sorted by degree descending
  const g4 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
    [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C']]
  );
  const r5 = analyzeHubs(g4, 2);
  assert(r5.groups.length >= 1, `at least 1 hub (got ${r5.groups.length})`);
  assert(r5.groups[0].meta?.degree === 3, `highest degree hub first (got ${r5.groups[0].meta?.degree})`);

  // Virtual node as hub: file node with degree=3
  const gv = makeGraph([
    { id: 'file1', type: 'external' },
    { id: 'sp1', type: 'procedure' }, { id: 'sp2', type: 'procedure' }, { id: 'sp3', type: 'procedure' },
  ], [['file1', 'sp1'], ['file1', 'sp2'], ['file1', 'sp3']]);
  const rv = analyzeHubs(gv, 3);
  assert(rv.groups.some(grp => grp.nodeIds.includes('file1')), 'virtual file node detected as hub');
}

// ─── analyzeOrphans ──────────────────────────────────────────────────────────

function testOrphans() {
  console.log('\n── analyzeOrphans ──');

  // Mix of connected + isolated nodes
  const g1 = makeGraph(
    [
      { id: 'A', schema: 'dbo', type: 'table' },
      { id: 'B', schema: 'dbo', type: 'table' },
      { id: 'C', schema: 'dbo', type: 'table' },
      { id: 'D', schema: 'sales', type: 'view' },
    ],
    [['A', 'B']]
  );
  const r1 = analyzeOrphans(g1);
  assert(r1.type === 'orphans', 'type is orphans');
  // C and D are orphans (degree 0)
  const orphanNodeIds = r1.groups.flatMap(g => g.nodeIds);
  assert(orphanNodeIds.includes('C'), 'C is orphan');
  assert(orphanNodeIds.includes('D'), 'D is orphan');
  assert(!orphanNodeIds.includes('A'), 'A is not orphan');
  assert(!orphanNodeIds.includes('B'), 'B is not orphan');

  // All nodes connected → no orphans
  const g2 = makeGraph(
    [{ id: 'A' }, { id: 'B' }],
    [['A', 'B']]
  );
  const r2 = analyzeOrphans(g2);
  assert(r2.groups.length === 0, `no orphans when all connected (got ${r2.groups.length})`);

  // Grouped by schema+type
  const r3 = analyzeOrphans(g1);
  assert(r3.groups.length === 2, `2 orphan groups: dbo/table + sales/view (got ${r3.groups.length})`);

  // Empty graph
  const g3 = new Graph({ type: 'directed', multi: false });
  const r4 = analyzeOrphans(g3);
  assert(r4.groups.length === 0, 'empty graph → 0 orphans');
}

// ─── analyzeLongestPath ──────────────────────────────────────────────────────

function testLongestPath() {
  console.log('\n── analyzeLongestPath ──');

  // Linear chain A→B→C→D → depth 3
  const g1 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['A', 'B'], ['B', 'C'], ['C', 'D']]
  );
  const r1 = analyzeLongestPath(g1, 2);
  assert(r1.type === 'longest-path', 'type is longest-path');
  assert(r1.groups.length >= 1, `at least 1 chain found (got ${r1.groups.length})`);
  assert(r1.groups[0].meta?.depth === 3, `chain depth=3 steps (got ${r1.groups[0].meta?.depth})`);
  assert(r1.groups[0].nodeIds[0] === 'A', `chain starts at A (got ${r1.groups[0].nodeIds[0]})`);
  assert(r1.groups[0].nodeIds[r1.groups[0].nodeIds.length - 1] === 'D', `chain ends at D`);

  // minNodes filter
  const r2 = analyzeLongestPath(g1, 5);
  assert(r2.groups.length === 0, `minNodes=5 filters out 4-node chain (got ${r2.groups.length})`);

  // Graph with branching → finds longest branch
  const g2 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
    [['A', 'B'], ['B', 'C'], ['A', 'D'], ['D', 'E']]
  );
  const r3 = analyzeLongestPath(g2, 2);
  assert(r3.groups.length >= 1, `at least 1 chain (got ${r3.groups.length})`);
  // Both branches have length 3, so either is valid
  assert(r3.groups[0].nodeIds.length === 3, `longest chain has 3 nodes (got ${r3.groups[0].nodeIds.length})`);

  // Cycle handling → doesn't infinite loop
  const g3 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B'], ['B', 'C'], ['C', 'A']]
  );
  const r4 = analyzeLongestPath(g3, 2);
  // Should return without hanging — cycle guard prevents infinite loop
  assert(r4.type === 'longest-path', 'cycle graph does not hang');

  // Empty graph
  const g4 = new Graph({ type: 'directed', multi: false });
  const r5 = analyzeLongestPath(g4, 2);
  assert(r5.groups.length === 0, 'empty graph → 0 chains');
}

// testLongestPathChainEdges removed: redundant with testLongestPath (same chain detection logic)

// ─── analyzeCycles ───────────────────────────────────────────────────────────

function testCycles() {
  console.log('\n── analyzeCycles ──');

  // A→B→C→A cycle — all 3 nodes must be in the same group
  const g1 = makeGraph(
    [{ id: 'A', schema: 'dbo' }, { id: 'B', schema: 'dbo' }, { id: 'C', schema: 'dbo' }],
    [['A', 'B'], ['B', 'C'], ['C', 'A']]
  );
  const r1 = analyzeCycles(g1);
  assert(r1.type === 'cycles', 'type is cycles');
  assert(r1.groups.length === 1, `1 cycle group (got ${r1.groups.length})`);
  const cycleNodeIds = r1.groups.flatMap(g => g.nodeIds);
  assert(cycleNodeIds.includes('A'), 'A in cycle');
  assert(cycleNodeIds.includes('B'), 'B in cycle (middle node)');
  assert(cycleNodeIds.includes('C'), 'C in cycle');
  assert(cycleNodeIds.length === 3, `full 3-node cycle captured (got ${cycleNodeIds.length})`);

  // A→B→C→D→A — all 4 nodes in one cycle
  const g1b = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']]
  );
  const r1b = analyzeCycles(g1b);
  assert(r1b.groups.length === 1, `1 cycle group for 4-node cycle (got ${r1b.groups.length})`);
  const ids4 = r1b.groups.flatMap(g => g.nodeIds);
  assert(ids4.length === 4, `4-node cycle fully captured (got ${ids4.length})`);

  // Bidirectional A↔B — labeled as bidirectional
  const g1c = makeGraph(
    [{ id: 'A', name: 'TableA' }, { id: 'B', name: 'ProcB' }],
    [['A', 'B'], ['B', 'A']]
  );
  const r1c = analyzeCycles(g1c);
  assert(r1c.groups.length === 1, `1 bidirectional group (got ${r1c.groups.length})`);
  assert(r1c.groups[0].label.includes('Bidirectional'), `label says Bidirectional (got "${r1c.groups[0].label}")`);

  // Two separate cycles → 2 groups
  const g1d = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'X' }, { id: 'Y' }],
    [['A', 'B'], ['B', 'C'], ['C', 'A'], ['X', 'Y'], ['Y', 'X']]
  );
  const r1d = analyzeCycles(g1d);
  assert(r1d.groups.length === 2, `2 separate cycle groups (got ${r1d.groups.length})`);

  // DAG → no cycles
  const g2 = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B'], ['A', 'C']]
  );
  const r2 = analyzeCycles(g2);
  assert(r2.groups.length === 0, `DAG → 0 cycle groups (got ${r2.groups.length})`);

  // Self-referencing node (if edge added manually)
  // Note: dacpacExtractor prevents self-loops, but analysis should handle them
  const g3 = new Graph({ type: 'directed', multi: false });
  g3.addNode('X', { schema: 'dbo', name: 'X', type: 'table' });
  g3.addEdgeWithKey('X→X', 'X', 'X', { type: 'body' });
  const r3 = analyzeCycles(g3);
  assert(r3.groups.length >= 0, 'self-loop does not crash');

  // Empty graph
  const g4 = new Graph({ type: 'directed', multi: false });
  const r4 = analyzeCycles(g4);
  assert(r4.groups.length === 0, 'empty graph → 0 cycles');
}

// ─── selectAnalysisGroup edge filtering (integration-style) ──────────────────

function testSubsetEdgeFiltering() {
  console.log('\n── Subset edge filtering (graph.hasEdge) ──');

  // Simulate the scenario: full model has edges, but filtered graph is missing some
  const fullModelEdges: Array<{ source: string; target: string }> = [
    { source: 'A', target: 'B' },
    { source: 'A', target: 'C' },
    { source: 'A', target: 'D' }, // This edge is NOT in the filtered graph
  ];

  // Filtered graph only has A→B and A→C (D was filtered out by type filter)
  const filteredGraph = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B'], ['A', 'C']]
  );

  // Without fix: would include A→D if D is in nodeIdSet
  const nodeIdSet = new Set(['A', 'B', 'C', 'D']);

  // Old behavior (broken): filter only by nodeIdSet
  const oldSubsetEdges = fullModelEdges.filter(e =>
    nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
  );
  assert(oldSubsetEdges.length === 3, `old: includes phantom edge A→D (got ${oldSubsetEdges.length})`);

  // New behavior (fixed): also check graph.hasEdge
  const newSubsetEdges = fullModelEdges.filter(e =>
    nodeIdSet.has(e.source) && nodeIdSet.has(e.target) &&
    filteredGraph.hasEdge(e.source, e.target)
  );
  assert(newSubsetEdges.length === 2, `new: excludes phantom edge A→D (got ${newSubsetEdges.length})`);
  assert(
    newSubsetEdges.every(e => e.source === 'A' && (e.target === 'B' || e.target === 'C')),
    'new: only A→B and A→C remain'
  );
}

// testHubsWithVirtualNodes merged into testHubs; testIslandWithVirtualBridge removed (trivial, 1 assertion)

// ─── analyzeExternalRefs ──────────────────────────────────────────────────────

function testExternalRefs() {
  console.log('\n── analyzeExternalRefs ──');

  // Empty graph
  {
    const g = makeGraph([], []);
    const r = analyzeExternalRefs(g);
    assert(r.type === 'external-refs', 'ER1: type is external-refs');
    assert(r.groups.length === 0, 'ER1: empty graph → 0 groups');
    assert(r.summary === 'No nodes in graph', 'ER1: empty graph summary');
  }

  // File source — label extracted from URL basename
  {
    const g = new Graph({ type: 'directed', multi: false });
    g.addNode('file1', { schema: '', name: 'report.csv', type: 'external', externalType: 'file', externalUrl: 'https://host/path/report.csv', externalDatabase: '' });
    const r = analyzeExternalRefs(g);
    assertEq(r.groups.length, 1, 'ER2: file source → 1 group');
    assertEq(r.groups[0].label, 'report.csv', 'ER2: label extracted from URL basename');
    assertEq(String(r.groups[0].meta?.kind), 'file', 'ER2: meta.kind = file');
  }

  // DB cross-ref — label uses "database / name" format
  {
    const g = new Graph({ type: 'directed', multi: false });
    g.addNode('db1', { schema: 'dbo', name: 'dbo.Sales', type: 'external', externalType: 'db', externalUrl: '', externalDatabase: 'OtherDB' });
    const r = analyzeExternalRefs(g);
    assertEq(r.groups.length, 1, 'ER3: db cross-ref → 1 group');
    assertEq(r.groups[0].label, 'OtherDB / dbo.Sales', 'ER3: db label = database / name');
    assertEq(String(r.groups[0].meta?.database), 'OtherDB', 'ER3: meta.database preserved');
  }

  // Sort order: file groups before db groups; alphabetical within each type
  {
    const g = new Graph({ type: 'directed', multi: false });
    g.addNode('db1',  { schema: '', name: 'schema.T1', type: 'external', externalType: 'db',   externalUrl: '',                       externalDatabase: 'BDB' });
    g.addNode('file2',{ schema: '', name: 'zz.csv',   type: 'external', externalType: 'file', externalUrl: 'https://host/zz.csv',    externalDatabase: '' });
    g.addNode('file1',{ schema: '', name: 'aa.csv',   type: 'external', externalType: 'file', externalUrl: 'https://host/aa.csv',    externalDatabase: '' });
    g.addNode('db2',  { schema: '', name: 'schema.T2', type: 'external', externalType: 'db',   externalUrl: '',                       externalDatabase: 'ADB' });
    const r = analyzeExternalRefs(g);
    assertEq(r.groups.length, 4, 'ER4: 4 groups total');
    assert(r.groups[0].label === 'aa.csv',          'ER4: file aa.csv first');
    assert(r.groups[1].label === 'zz.csv',          'ER4: file zz.csv second');
    assert(r.groups[2].label === 'ADB / schema.T2', 'ER4: db ADB first');
    assert(r.groups[3].label === 'BDB / schema.T1', 'ER4: db BDB last');
  }

  // Neighbor nodeIds included: file node + connected SPs
  {
    const g = new Graph({ type: 'directed', multi: false });
    g.addNode('file1', { schema: '', name: 'data.csv', type: 'external', externalType: 'file', externalUrl: 'https://host/data.csv', externalDatabase: '' });
    g.addNode('sp1',   { schema: 'dbo', name: 'sp1', type: 'procedure', externalType: undefined });
    g.addNode('sp2',   { schema: 'dbo', name: 'sp2', type: 'procedure', externalType: undefined });
    g.addEdgeWithKey('file1→sp1', 'file1', 'sp1', { type: 'body' });
    g.addEdgeWithKey('file1→sp2', 'file1', 'sp2', { type: 'body' });
    const r = analyzeExternalRefs(g);
    assertEq(r.groups.length, 1, 'ER5: 1 file group');
    assert(r.groups[0].nodeIds.includes('file1'), 'ER5: file node in nodeIds');
    assert(r.groups[0].nodeIds.includes('sp1'),   'ER5: sp1 in nodeIds');
    assert(r.groups[0].nodeIds.includes('sp2'),   'ER5: sp2 in nodeIds');
    assertEq(r.groups[0].nodeIds.length, 3,       'ER5: exactly 3 nodeIds');
  }
}

// ─── Run all tests ───────────────────────────────────────────────────────────

testIslands();
testHubs();
testOrphans();
testLongestPath();
testCycles();
testSubsetEdgeFiltering();
testExternalRefs();

printSummary('Graph Analysis');
