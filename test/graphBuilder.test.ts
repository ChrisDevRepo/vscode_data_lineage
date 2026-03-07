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
    testVirtualNodeBuilding();
    testVirtualNodeTrace();
    testSameDbResolution();
    testOpenrowsetDedup();
    testCopyIntoBulkInsert();
    testCetasTarget();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Graph Builder');
}

main();
