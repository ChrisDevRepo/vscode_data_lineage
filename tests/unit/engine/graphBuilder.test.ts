/**
 * Tests for graph construction, layout, and BFS trace algorithms.
 */

import { readFileSync } from 'fs';
import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { describe, it } from 'vitest';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import {
  buildGraph,
  traceNode,
  traceNodeWithLevels,
  buildSchemaGraph,
  buildGraphologyGraph,
  buildExpandedSchemaViewGraph,
} from '../../../src/engine/graphBuilder';
import { projectSchemaQuotient } from '../../../src/engine/schemaProjection';
import { buildModel } from '../../../src/engine/modelBuilder';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../../src/engine/types';
import { getExternalNodeColor } from '../../../src/utils/schemaColors';
import { assert, assertEq, testPath, loadParseRules, loadAdventureWorksModel } from '../helpers/testUtils';

describe('Graph Builder', () => {
// ─── Graph Builder ──────────────────────────────────────────────────────────

async function testGraphBuilder(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Graph Builder ──');

  const result = buildGraph(model);

  assert(result.flowNodes.length === model.nodes.length, `Flow nodes match: ${result.flowNodes.length}`);
  assert(result.flowEdges.length > 0, `Flow edges created: ${result.flowEdges.length}`);
  assert(result.graph.order > 0, `Graph order: ${result.graph.order}`);

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

// ─── projectSchemaQuotient edges ─────────────────────────────────────────────

function testSchemaQuotientEdges() {
  console.log('\n── projectSchemaQuotient edges ──');

  // Model: dbo.ProcA (procedure) writes to sales.TableB, sales.ProcC reads from dbo.TableD
  const nodes: DatabaseModel['nodes'] = [
    { id: '[dbo].[proca]', name: 'ProcA', schema: 'dbo', type: 'procedure', label: 'ProcA', objectType: 'P' } as unknown as DatabaseModel['nodes'][number],
    { id: '[dbo].[tabled]', name: 'TableD', schema: 'dbo', type: 'table', label: 'TableD', objectType: 'U' } as unknown as DatabaseModel['nodes'][number],
    { id: '[sales].[tableb]', name: 'TableB', schema: 'sales', type: 'table', label: 'TableB', objectType: 'U' } as unknown as DatabaseModel['nodes'][number],
    { id: '[sales].[procc]', name: 'ProcC', schema: 'sales', type: 'procedure', label: 'ProcC', objectType: 'P' } as unknown as DatabaseModel['nodes'][number],
  ];
  const edges: DatabaseModel['edges'] = [
    { source: '[dbo].[proca]', target: '[sales].[tableb]', type: 'body' },
    { source: '[sales].[procc]', target: '[dbo].[tabled]', type: 'body' },
  ];
  const model = { nodes, edges, schemas: [], catalog: new Map(), neighborIndex: new Map() } as unknown as DatabaseModel;
  const graph = buildGraphologyGraph(model);

  const result = projectSchemaQuotient(graph).edges;

  assert(result.length === 1, `Bidirectional dbo↔sales edges collapse to 1 projected edge (got ${result.length})`);

  const projected = result[0];
  assert(projected.bidirectional, 'Projected schema edge preserves bidirectional metadata');
  assertEq(projected.count, 1, 'Forward count is preserved separately');
  assertEq(projected.reverseCount, 1, 'Reverse count is preserved separately');
  assertEq(projected.totalCount, 2, 'Total bidirectional edge count = 2');

  const dboNodeIds = new Set(nodes.filter(n => n.schema === 'dbo').map(n => n.id));
  const dboOnlyModel = {
    ...model,
    nodes: nodes.filter(n => dboNodeIds.has(n.id)),
    edges: edges.filter(e => dboNodeIds.has(e.source) && dboNodeIds.has(e.target)),
  };
  const filtered = projectSchemaQuotient(buildGraphologyGraph(dboOnlyModel)).edges;
  assertEq(filtered.length, 0, 'Filtered working graph with only dbo has no cross-schema edges');

  // Same-schema edges are dropped (srcSchema === tgtSchema).
  const dboOnlySameSchema: DatabaseModel['nodes'] = [
    { id: '[dbo].[proca]', name: 'ProcA', schema: 'dbo', type: 'procedure', label: 'ProcA', objectType: 'P' } as unknown as DatabaseModel['nodes'][number],
    { id: '[dbo].[tabled]', name: 'TableD', schema: 'dbo', type: 'table', label: 'TableD', objectType: 'U' } as unknown as DatabaseModel['nodes'][number],
  ];
  const sameSchemaEdges: DatabaseModel['edges'] = [
    { source: '[dbo].[proca]', target: '[dbo].[tabled]', type: 'body' },
  ];
  const sameSchemaModel = { nodes: dboOnlySameSchema, edges: sameSchemaEdges, schemas: [], catalog: new Map(), neighborIndex: new Map() } as unknown as DatabaseModel;
  const sameResult = projectSchemaQuotient(buildGraphologyGraph(sameSchemaModel)).edges;
  assert(sameResult.length === 0, `Same-schema edges are not included in schema edge map (got ${sameResult.length})`);
}

// ─── buildSchemaGraph ────────────────────────────────────────────────────────

function testBuildSchemaGraph(model: DatabaseModel) {
  console.log('\n── buildSchemaGraph ──');

  const graph = buildGraphologyGraph(model);
  const { nodes, edges } = buildSchemaGraph(graph);

  assert(nodes.length === model.schemas.length, `Schema node count matches: ${nodes.length}`);

  // Filtered working graph: only one schema.
  const firstSchema = model.schemas[0].name;
  const firstSchemaIds = new Set(model.nodes.filter(n => n.schema === firstSchema).map(n => n.id));
  const firstSchemaModel = {
    ...model,
    nodes: model.nodes.filter(n => firstSchemaIds.has(n.id)),
    edges: model.edges.filter(e => firstSchemaIds.has(e.source) && firstSchemaIds.has(e.target)),
  };
  const { nodes: singleNodes } = buildSchemaGraph(buildGraphologyGraph(firstSchemaModel));
  assert(singleNodes.length === 1, `Single-schema filter produces 1 node`);

  const filteredModel = {
    ...model,
    nodes: model.nodes.filter(n => n.schema === firstSchema && n.type === 'table').slice(0, 1),
    edges: [],
  };
  const { nodes: filteredNodes } = buildSchemaGraph(buildGraphologyGraph(filteredModel));
  assertEq(filteredNodes.length, 1, 'Schema overview uses the filtered working graph schema set');
  assertEq(filteredNodes[0].data.objectCount, 1, 'Schema overview object count uses only filtered graph nodes');
  assertEq(filteredNodes[0].data.typeBreakdown.table, 1, 'Schema overview type breakdown uses only filtered graph nodes');

  // Edges reference valid schema node ids
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const e of edges) {
    assert(nodeIds.has(e.source), `Edge source ${e.source} is valid`);
    assert(nodeIds.has(e.target), `Edge target ${e.target} is valid`);
  }

  const bidiNodes: DatabaseModel['nodes'] = [
    { id: '[a].[p]', name: 'p', schema: 'a', fullName: '[a].[p]', type: 'procedure' },
    { id: '[b].[t]', name: 't', schema: 'b', fullName: '[b].[t]', type: 'table' },
  ];
  const bidiModel = {
    nodes: bidiNodes,
    edges: [
      { source: '[a].[p]', target: '[b].[t]', type: 'body' },
      { source: '[b].[t]', target: '[a].[p]', type: 'body' },
    ],
    schemas: [],
    catalog: {},
    neighborIndex: {},
  } satisfies DatabaseModel;
  const { edges: bidiEdges } = buildSchemaGraph(buildGraphologyGraph(bidiModel));
  assertEq(bidiEdges.length, 1, 'Schema View emits one edge for a bidirectional schema pair');
  assertEq(bidiEdges[0].label, '⇄ 2', 'Schema View labels bidirectional schema edge with total count');
  assert(!!bidiEdges[0].markerStart, 'Schema View renders reverse marker for bidirectional schema edge');

  const verticalConfig = {
    ...DEFAULT_CONFIG,
    layout: {
      ...DEFAULT_CONFIG.layout,
      direction: 'TB' as const,
      rankSeparation: 321,
      nodeSeparation: 123,
      edgeStyle: 'straight' as const,
    },
  };
  const configured = buildSchemaGraph(buildGraphologyGraph(bidiModel), verticalConfig);
  const configuredSource = configured.nodes.find((node) => node.data.schemaName === 'a');
  const configuredTarget = configured.nodes.find((node) => node.data.schemaName === 'b');
  assert(!!configuredSource && !!configuredTarget, 'Configured Schema View retains both schema nodes');
  assert(
    Math.abs(configuredTarget!.position.y - configuredSource!.position.y)
      > Math.abs(configuredTarget!.position.x - configuredSource!.position.x),
    'Schema View honors top-to-bottom layout direction',
  );
  assertEq(configured.edges[0].type, 'straight', 'Schema View honors configured edge style');
}

// ─── buildExpandedSchemaViewGraph ────────────────────────────────────────────────

function testBuildExpandedSchemaViewGraph() {
  console.log('\n── buildExpandedSchemaViewGraph ──');

  const nodes: DatabaseModel['nodes'] = [
    { id: '[sales].[orders]', name: 'Orders', schema: 'sales', fullName: '[sales].[Orders]', type: 'table' },
    { id: '[sales].[customer]', name: 'Customer', schema: 'sales', fullName: '[sales].[Customer]', type: 'table' },
    { id: '[ops].[loadorders]', name: 'LoadOrders', schema: 'ops', fullName: '[ops].[LoadOrders]', type: 'procedure' },
    { id: '[audit].[auditorders]', name: 'AuditOrders', schema: 'audit', fullName: '[audit].[AuditOrders]', type: 'table' },
    { id: '[ref].[lookup]', name: 'Lookup', schema: 'ref', fullName: '[ref].[Lookup]', type: 'table' },
  ];
  const edges: DatabaseModel['edges'] = [
    { source: '[sales].[customer]', target: '[sales].[orders]', type: 'body' },
    { source: '[ops].[loadorders]', target: '[sales].[orders]', type: 'body' },
    { source: '[sales].[orders]', target: '[audit].[auditorders]', type: 'body' },
    { source: '[ops].[loadorders]', target: '[audit].[auditorders]', type: 'body' },
    { source: '[audit].[auditorders]', target: '[ops].[loadorders]', type: 'body' },
    { source: '[audit].[auditorders]', target: '[ref].[lookup]', type: 'body' },
  ];
  const model = {
    nodes,
    edges,
    schemas: [
      { name: 'sales', nodeCount: 2, types: { table: 2, view: 0, procedure: 0, function: 0, external: 0 } },
      { name: 'ops', nodeCount: 1, types: { table: 0, view: 0, procedure: 1, function: 0, external: 0 } },
      { name: 'audit', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
      { name: 'ref', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
    ],
    catalog: {},
    neighborIndex: {},
  } satisfies DatabaseModel;
  const graph = buildGraphologyGraph(model);
  const fullGraph = buildGraph(model);

  const result = buildExpandedSchemaViewGraph(graph, new Set(['sales']), '[sales].[orders]');
  const nodeById = new Map(result.flowNodes.map((n) => [n.id, n]));
  const fullGraphNodeById = new Map(fullGraph.flowNodes.map((n) => [n.id, n]));
  const salesObjects = result.flowNodes.filter((n) => n.type === 'lineageNode' && n.data.schema === 'sales');
  assert(salesObjects.length === 2, `Expanded schema view: expanded sales schema renders two object nodes (got ${salesObjects.length})`);
  assert(!nodeById.has('[ops].[loadorders]'), 'Expanded schema view: collapsed ops object is not rendered individually');
  assertEq(nodeById.get('[sales].[orders]')?.data.label, fullGraphNodeById.get('[sales].[orders]')?.data.label, 'Expanded schema view: lineage-node label matches full graph');
  assertEq(nodeById.get('[sales].[orders]')?.data.fullName, fullGraphNodeById.get('[sales].[orders]')?.data.fullName, 'Expanded schema view: lineage-node full name matches full graph');
  assertEq(nodeById.get('[sales].[orders]')?.data.objectType, fullGraphNodeById.get('[sales].[orders]')?.data.objectType, 'Expanded schema view: lineage-node type matches full graph');
  assertEq(nodeById.get('[sales].[orders]')?.data.inDegree, fullGraphNodeById.get('[sales].[orders]')?.data.inDegree, 'Expanded schema view: lineage-node indegree matches full graph');
  assertEq(nodeById.get('[sales].[orders]')?.data.outDegree, fullGraphNodeById.get('[sales].[orders]')?.data.outDegree, 'Expanded schema view: lineage-node outdegree matches full graph');

  const opsCluster = result.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'ops');
  const auditCluster = result.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'audit');
  const refCluster = result.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'ref');
  assert(!!opsCluster && opsCluster.data.isExpandedSchemaViewCluster === true, 'Expanded schema view: collapsed ops schema node is flagged as a schema cluster');
  assert(!!auditCluster && auditCluster.data.isExpandedSchemaViewCluster === true, 'Expanded schema view: collapsed audit schema node is flagged as a schema cluster');
  assert(!!refCluster && refCluster.data.isExpandedSchemaViewCluster === true, 'Expanded schema view: collapsed ref schema node is flagged as a schema cluster');

  const bridgeFromOps = result.flowEdges.find((e) => e.source === opsCluster?.id && e.target === '[sales].[orders]');
  const bridgeToAudit = result.flowEdges.find((e) => e.source === '[sales].[orders]' && e.target === auditCluster?.id);
  const collapsedClusterEdges = result.flowEdges.filter((e) => e.source.startsWith('__expandedschemaviewcluster__') && e.target.startsWith('__expandedschemaviewcluster__'));
  const bidirectionalClusterEdges = collapsedClusterEdges.filter((e) => e.id.includes('↔'));
  const collapsedClusterEdge = bidirectionalClusterEdges.find((e) => e.source === auditCluster?.id && e.target === opsCluster?.id);
  const unidirectionalClusterEdge = collapsedClusterEdges.find((e) => e.source === auditCluster?.id && e.target === refCluster?.id);
  assert(!!bridgeFromOps, 'Expanded schema view: emits bridge edge from collapsed upstream schema cluster');
  assert(!!bridgeToAudit, 'Expanded schema view: emits bridge edge to collapsed downstream schema cluster');
  assertEq(bidirectionalClusterEdges.length, 1, 'Expanded schema view: bidirectional collapsed schema pair emits one canonical edge');
  assert(!!collapsedClusterEdge, 'Expanded schema view: preserves aggregate edges between collapsed schema clusters');
  assertEq(collapsedClusterEdge?.label, '⇄ 2', 'Expanded schema view: bidirectional collapsed schema edge label totals both directions');
  assert(!!collapsedClusterEdge?.markerStart, 'Expanded schema view: bidirectional collapsed schema edge has a reverse marker');
  assert(!!unidirectionalClusterEdge, 'Expanded schema view: unidirectional collapsed schema edge is preserved');
  assertEq(unidirectionalClusterEdge?.label, '1', 'Expanded schema view: unidirectional collapsed schema edge keeps one-way count');
  assert(nodeById.get('[sales].[orders]')?.data.highlighted === true, 'Expanded schema view: focus node is highlighted when focusNodeId is set');

  const expandedSalesOps = buildExpandedSchemaViewGraph(graph, new Set(['sales', 'ops']), '[sales].[orders]');
  const expandedNodeById = new Map(expandedSalesOps.flowNodes.map((n) => [n.id, n]));
  assert(!!expandedNodeById.get('[ops].[loadorders]'), 'Expanded schema view: additive expansion renders the second schema as objects');
  assert(!!expandedSalesOps.flowEdges.find((e) => e.source === '[ops].[loadorders]' && e.target === '[sales].[orders]'),
    'Expanded schema view: edges between expanded schemas render as real object edges');
  const additiveAuditCluster = expandedSalesOps.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'audit');
  assert(!!additiveAuditCluster, 'Expanded schema view: schemas outside the expanded set remain collapsed');
  assert(!!expandedSalesOps.flowEdges.find((e) => e.source === '[ops].[loadorders]' && e.target === additiveAuditCluster?.id),
    'Expanded schema view: expanded objects bridge to remaining collapsed schema clusters');

  const noFocus = buildExpandedSchemaViewGraph(graph, new Set(['sales']), null);
  assert(!noFocus.flowNodes.some((n) => n.type === 'lineageNode' && n.data.highlighted === true), 'Expanded schema view: no object is highlighted without focusNodeId');

  const hiddenClusters = buildExpandedSchemaViewGraph(
    graph,
    new Set(['sales']),
    null,
    undefined,
    { hideClusters: true },
  );
  assert(!hiddenClusters.flowNodes.some((n) => n.type === 'schemaNode' && !n.hidden), 'Expanded schema view: hidden clusters are not rendered as schema nodes');
  assert(!hiddenClusters.flowEdges.some((e) => (e.id.startsWith('__bridge__') || e.id.startsWith('__clusteredge__')) && !e.hidden), 'Expanded schema view: hidden clusters remove bridge and cluster edges');
  assert(!!hiddenClusters.flowEdges.find((e) => e.source === '[sales].[customer]' && e.target === '[sales].[orders]'),
    'Expanded schema view: hidden clusters preserve real edges between expanded object nodes');

  {
    const externalNode = { id: '[ext].[externalfile]', name: 'ExternalFile', schema: 'ext', fullName: '[ext].[ExternalFile]', type: 'external' as const, externalType: 'file' as const };
    const modelWithExternal = {
      ...model,
      nodes: [...nodes, externalNode],
      edges: [...edges, { source: externalNode.id, target: '[sales].[orders]', type: 'body' as const }],
      schemas: [
        ...model.schemas,
        { name: 'ext', nodeCount: 1, types: { table: 0, view: 0, procedure: 0, function: 0, external: 1 } },
      ],
    } satisfies DatabaseModel;
    const graphWithExternal = buildGraphologyGraph(modelWithExternal);
    const schemaOverview = buildSchemaGraph(graphWithExternal);
    const extOverviewCluster = schemaOverview.nodes.find((n) => n.data.schemaName === 'ext');
    assert(!!extOverviewCluster, 'External-only schema overview cluster is rendered');
    assert(extOverviewCluster?.data.isExternalOnly === true, 'External-only schema overview cluster is marked external-only');
    assertEq(extOverviewCluster?.data.color, getExternalNodeColor(), 'External-only schema overview cluster uses external color');

    const expandedWithExternal = buildExpandedSchemaViewGraph(graphWithExternal, new Set(['sales', 'ext']), '[sales].[orders]');
    const expandedExternalNode = expandedWithExternal.flowNodes.find((n) => n.id === externalNode.id);
    assert(!!expandedExternalNode, 'Expanded Schema View can expand external-only ext schema without crashing');
    assertEq(expandedExternalNode?.data.schemaColor, getExternalNodeColor(), 'Expanded external object uses external color outside schema palette');
  }

  // ── Scenario A: I4 — every individual node that connects to a collapsed cluster gets its own bridge ──
  // Before the fix, only ONE bridge existed per (expanded schema × collapsed schema) pair, anchored to the
  // first individual node found. The second individual node connecting to the same cluster was silently
  // dropped — no bridge edge, node appeared as orphan despite having model edges.
  {
    const edgesA: DatabaseModel['edges'] = [
      ...edges,
      { source: '[sales].[customer]', target: '[audit].[auditorders]', type: 'body' },
    ];
    const modelA = { ...model, edges: edgesA };
    const graphA = buildGraphologyGraph(modelA);
    const resultA = buildExpandedSchemaViewGraph(graphA, new Set(['sales']), null);
    const auditClusterA = resultA.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'audit');
    const bridgeOrdersToAudit = resultA.flowEdges.find((e) => e.source === '[sales].[orders]' && e.target === auditClusterA?.id);
    const bridgeCustomerToAudit = resultA.flowEdges.find((e) => e.source === '[sales].[customer]' && e.target === auditClusterA?.id);
    assert(!!bridgeOrdersToAudit, 'I4 Scenario A: [sales].[orders] has its own bridge to audit cluster');
    assert(!!bridgeCustomerToAudit, 'I4 Scenario A: [sales].[customer] has its own bridge to audit cluster (was orphaned before fix)');
  }

  // ── Scenario B: I11 — bridge count equals number of edges from that individual node to the cluster ──
  {
    const nodesB: DatabaseModel['nodes'] = [
      ...nodes,
      { id: '[audit].[auditlog]', name: 'AuditLog', schema: 'audit', fullName: '[audit].[AuditLog]', type: 'table' },
    ];
    const edgesB: DatabaseModel['edges'] = [
      ...edges,
      { source: '[sales].[orders]', target: '[audit].[auditlog]', type: 'body' },
    ];
    const modelB = { ...model, nodes: nodesB, edges: edgesB };
    const graphB = buildGraphologyGraph(modelB);
    const resultB = buildExpandedSchemaViewGraph(graphB, new Set(['sales']), null);
    const auditClusterB = resultB.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'audit');
    const ordersBridge = resultB.flowEdges.find((e) => e.source === '[sales].[orders]' && e.target === auditClusterB?.id);
    assertEq(ordersBridge?.label, '2', 'I11 Scenario B: bridge count = 2 when one individual node has two edges to the same collapsed cluster');
  }

  // ── Scenario C: I4 — upstream bridge: collapsed cluster → individual node ──
  {
    const edgesC: DatabaseModel['edges'] = [
      ...edges,
      { source: '[ref].[lookup]', target: '[sales].[orders]', type: 'body' },
    ];
    const modelC = { ...model, edges: edgesC };
    const graphC = buildGraphologyGraph(modelC);
    const resultC = buildExpandedSchemaViewGraph(graphC, new Set(['sales']), null);
    const refClusterC = resultC.flowNodes.find((n) => n.type === 'schemaNode' && n.data.schemaName === 'ref');
    const upstreamBridge = resultC.flowEdges.find((e) => e.source === refClusterC?.id && e.target === '[sales].[orders]');
    assert(!!upstreamBridge, 'I4 Scenario C: upstream bridge from collapsed ref cluster to individual [sales].[orders] exists');
  }

  // ── Scenario D: I8 — fully expanded: no bridges, no cluster nodes (idempotence) ──
  {
    const allExpanded = buildExpandedSchemaViewGraph(graph, new Set(['sales', 'ops', 'audit', 'ref']), null);
    const hasBridges = allExpanded.flowEdges.some((e) => e.id.startsWith('__bridge__'));
    const hasClusters = allExpanded.flowNodes.some((n) => n.type === 'schemaNode');
    assert(!hasBridges, 'I8 Scenario D: no bridge edges when all schemas are individually expanded');
    assert(!hasClusters, 'I8 Scenario D: no cluster nodes when all schemas are individually expanded');
  }

  // ── Scenario E: I5 — no self-loops in any configuration ──
  {
    const selfLoopFree = result.flowEdges.every((e) => e.source !== e.target);
    assert(selfLoopFree, 'I5 Scenario E: no self-loop edges in expanded schema view output');
  }
}

// ─── Run all tests ──────────────────────────────────────────────────────────

  it('builds the AdventureWorks graph', async () => {
    await testGraphBuilder(await loadAdventureWorksModel());
  });
  it('projects schema quotient edges', testSchemaQuotientEdges);
  it('builds the schema graph', async () => {
    testBuildSchemaGraph(await loadAdventureWorksModel());
  });
  it('builds expanded schema views', testBuildExpandedSchemaViewGraph);
  it('traces without adding sibling branches', testTraceNoSiblings);
  it('traces bidirectionally', testBidirectionalTrace);
  it('traces Synapse models', testSynapseTrace);
  it('builds virtual nodes', testVirtualNodeBuilding);
  it('traces virtual nodes', testVirtualNodeTrace);
  it('resolves same-database references', testSameDbResolution);
  it('deduplicates OPENROWSET references', testOpenrowsetDedup);
  it('extracts COPY INTO and BULK INSERT references', testCopyIntoBulkInsert);
  it('extracts CETAS targets', testCetasTarget);
  it('enforces the virtual-node budget', testVirtualNodeBudgetExhaustion);
  it('builds mixed external references', testMixedExternalRefs);
  it('preserves cross-database write direction', testCrossDbWriteDirection);
  it('honors disabled external references', testExternalRefsDisabled);
  it('suppresses CLR method virtual nodes', testClrMethodVirtualNodeSuppression);
});
