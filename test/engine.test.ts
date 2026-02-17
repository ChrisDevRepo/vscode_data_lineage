/**
 * Standalone engine test — runs against the real dacpac file.
 * Execute with: npx tsx test/engine.test.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractDacpac, filterBySchemas } from '../src/engine/dacpacExtractor';
import { parseSqlBody } from '../src/engine/sqlBodyParser';
import { buildGraph, traceNode, traceNodeWithLevels, getGraphMetrics } from '../src/engine/graphBuilder';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DACPAC_PATH = resolve(__dirname, './AdventureWorks.dacpac');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function testExtraction() {
  console.log('\n── DACPAC Extraction ──');
  const buffer = readFileSync(DACPAC_PATH);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);

  assert(model.nodes.length > 0, `Extracted ${model.nodes.length} nodes`);
  assert(model.edges.length > 0, `Extracted ${model.edges.length} edges`);
  assert(model.schemas.length > 0, `Found ${model.schemas.length} schemas: ${model.schemas.map(s => s.name).join(', ')}`);

  // Check node types
  const tables = model.nodes.filter(n => n.type === 'table');
  const views = model.nodes.filter(n => n.type === 'view');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  const funcs = model.nodes.filter(n => n.type === 'function');

  assert(tables.length > 0, `Found ${tables.length} tables`);
  assert(views.length > 0, `Found ${views.length} views`);
  assert(procs.length > 0, `Found ${procs.length} procedures`);
  assert(funcs.length > 0, `Found ${funcs.length} functions`);

  // Check schemas match expected
  const schemaNames = model.schemas.map(s => s.name);
  assert(schemaNames.includes('DBO'), 'Schema "dbo" found');
  assert(schemaNames.includes('SALES'), 'Schema "SALES" found');

  // Check specific known objects
  const nodeNames = model.nodes.map(n => n.fullName);
  assert(nodeNames.some(n => n.includes('ErrorLog')), 'ErrorLog table found');
  assert(nodeNames.some(n => n.includes('vProductAndDescription')), 'vProductAndDescription view found');
  assert(nodeNames.some(n => n.includes('uspLogError')), 'uspLogError procedure found');

  return model;
}

async function testFiltering(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Schema Filtering ──');

  const salesLT = filterBySchemas(model, new Set(['SALES']));
  assert(salesLT.nodes.every(n => n.schema === 'SALES'), 'All filtered nodes are SALES schema');
  assert(salesLT.nodes.length > 0, `SALES has ${salesLT.nodes.length} nodes`);
  assert(salesLT.nodes.length < model.nodes.length, 'Filtered set is smaller than full set');

  const dbo = filterBySchemas(model, new Set(['DBO']));
  assert(dbo.nodes.every(n => n.schema === 'DBO'), 'All filtered nodes are dbo schema');

  // Max nodes cap
  const capped = filterBySchemas(model, new Set(['DBO', 'SALES']), 5);
  assert(capped.nodes.length <= 5, `Capped at ${capped.nodes.length} nodes (max 5)`);
}

function testSqlBodyParser() {
  console.log('\n── SQL Body Parser ──');

  // Test FROM/JOIN extraction
  const sql1 = `
    SELECT * FROM [dbo].[Orders] o
    INNER JOIN [dbo].[Customers] c ON o.CustId = c.Id
    LEFT JOIN [dbo].[Products] p ON o.ProdId = p.Id
  `;
  const r1 = parseSqlBody(sql1);
  assert(r1.sources.length >= 3, `Extracted ${r1.sources.length} sources from FROM/JOIN`);
  assert(r1.sources.some(s => s.includes('Orders')), 'Found Orders source');
  assert(r1.sources.some(s => s.includes('Customers')), 'Found Customers source');

  // Test INSERT/UPDATE extraction
  const sql2 = `
    INSERT INTO [dbo].[AuditLog] (Action) VALUES ('test');
    UPDATE [dbo].[Users] SET LastLogin = GETDATE();
  `;
  const r2 = parseSqlBody(sql2);
  assert(r2.targets.length >= 2, `Extracted ${r2.targets.length} targets`);
  assert(r2.targets.some(t => t.includes('AuditLog')), 'Found AuditLog target');

  // Test EXEC extraction
  const sql3 = `EXECUTE [dbo].[uspPrintError]; EXEC [dbo].[uspLogError] @ErrorLogID`;
  const r3 = parseSqlBody(sql3);
  assert(r3.execCalls.length >= 2, `Extracted ${r3.execCalls.length} EXEC calls`);

  // Test comment removal
  const sql4 = `
    -- This is a comment
    SELECT * FROM [dbo].[Orders] /* inline comment */
    /* multi
       line comment */
    JOIN [dbo].[Items] ON 1=1
  `;
  const r4 = parseSqlBody(sql4);
  assert(r4.sources.length >= 2, 'Comments stripped, sources still extracted');

  // Test skip patterns
  const sql5 = `SELECT * FROM #TempTable; EXEC sp_executesql @sql`;
  const r5 = parseSqlBody(sql5);
  assert(!r5.sources.some(s => s.startsWith('#')), 'Temp tables skipped');
  assert(!r5.execCalls.some(s => s.startsWith('sp_')), 'System procs skipped');

  // Test APPLY extraction
  const sql6 = `CROSS APPLY [dbo].[ufnGetCustomerInfo](c.Id) AS ci`;
  const r6 = parseSqlBody(sql6);
  assert(r6.sources.some(s => s.includes('ufnGetCustomerInfo')), 'CROSS APPLY source found');

  // Test CTE extraction (CTEs should NOT appear as sources)
  const sql7 = `
    WITH OrderCTE AS (SELECT * FROM [dbo].[Orders]),
         CustomerCTE AS (SELECT * FROM [dbo].[Customers])
    SELECT * FROM OrderCTE o JOIN CustomerCTE c ON o.CustId = c.Id
    JOIN [dbo].[Products] p ON o.ProdId = p.Id
  `;
  const r7 = parseSqlBody(sql7);
  assert(!r7.sources.some(s => s.toLowerCase().includes('ordercte')), 'CTE name "OrderCTE" excluded from sources');
  assert(!r7.sources.some(s => s.toLowerCase().includes('customercte')), 'CTE name "CustomerCTE" excluded from sources');
  assert(r7.sources.some(s => s.includes('Orders')), 'Real table inside CTE still extracted');
  assert(r7.sources.some(s => s.includes('Products')), 'Table outside CTE still extracted');

  // Test MERGE ... USING extraction
  const sql8 = `MERGE [dbo].[TargetTable] AS t USING [dbo].[SourceTable] AS s ON t.Id = s.Id`;
  const r8 = parseSqlBody(sql8);
  assert(r8.sources.some(s => s.includes('SourceTable')), 'MERGE USING source found');
  assert(r8.targets.some(t => t.includes('TargetTable')), 'MERGE INTO target found');

  // Test CREATE TABLE AS SELECT
  const sql9 = `CREATE TABLE [dbo].[NewTable] AS SELECT * FROM [dbo].[OldTable]`;
  const r9 = parseSqlBody(sql9);
  assert(r9.targets.some(t => t.includes('NewTable')), 'CTAS target found');

  // Test SELECT INTO
  const sql10 = `SELECT col1, col2 INTO [dbo].[Backup] FROM [dbo].[Original]`;
  const r10 = parseSqlBody(sql10);
  assert(r10.targets.some(t => t.includes('Backup')), 'SELECT INTO target found');
  assert(r10.sources.some(s => s.includes('Original')), 'SELECT INTO source found');

  // Test string literal neutralization
  const sql11 = `SELECT * FROM [dbo].[RealTable] WHERE Name = 'SELECT * FROM [dbo].[FakeTable]'`;
  const r11 = parseSqlBody(sql11);
  assert(r11.sources.some(s => s.includes('RealTable')), 'Real table extracted');
  assert(!r11.sources.some(s => s.includes('FakeTable')), 'String literal table correctly ignored');
}

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

async function testEdgeIntegrity(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Edge Integrity ──');

  const nodeIds = new Set(model.nodes.map(n => n.id));

  // All edge endpoints should reference existing nodes
  const danglingEdges = model.edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  assert(danglingEdges.length === 0, `No dangling edges (found ${danglingEdges.length})`);

  // No self-loops
  const selfLoops = model.edges.filter(e => e.source === e.target);
  assert(selfLoops.length === 0, `No self-loops (found ${selfLoops.length})`);

  // No duplicate edges
  const edgeKeys = model.edges.map(e => `${e.source}→${e.target}`);
  const uniqueEdges = new Set(edgeKeys);
  assert(uniqueEdges.size === edgeKeys.length, `No duplicate edges (${edgeKeys.length} total, ${uniqueEdges.size} unique)`);
}

async function testFabricDacpac() {
  console.log('\n── Fabric SDK Dacpac ──');
  const fabricPath = resolve(__dirname, './AdventureWorks_sdk-style.dacpac');
  const buffer = readFileSync(fabricPath);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);

  const views = model.nodes.filter(n => n.type === 'view');
  const tables = model.nodes.filter(n => n.type === 'table');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  const funcs = model.nodes.filter(n => n.type === 'function');

  assert(views.length > 0, `Found ${views.length} views`);
  assert(tables.length > 0, `Found ${tables.length} tables`);
  assert(procs.length > 0, `Found ${procs.length} procedures`);
  assert(funcs.length > 0, `Found ${funcs.length} functions`);

  // Views must have edges (QueryDependencies)
  const viewIds = new Set(views.map(n => n.id));
  const viewEdges = model.edges.filter(e => viewIds.has(e.target));
  assert(viewEdges.length > 0, `Views have ${viewEdges.length} incoming edges (QueryDependencies works)`);

  // Views with table refs should be connected (vw_deprecated_report has no table refs by design)
  const viewsWithEdges = new Set(viewEdges.map(e => e.target));
  const noTableViews = new Set(['[legacy].[vw_deprecated_report]']);
  const viewsMissing = views.filter(v => !viewsWithEdges.has(v.id) && !noTableViews.has(v.fullName));
  assert(viewsMissing.length === 0, viewsMissing.length === 0
    ? 'All views with table refs are connected'
    : `Disconnected views: ${viewsMissing.map(v => v.fullName).join(', ')}`);

  // Procs must also have edges (BodyDependencies still works)
  const procIds = new Set(procs.map(n => n.id));
  const procEdges = model.edges.filter(e => procIds.has(e.target));
  assert(procEdges.length > 0, `Procedures have ${procEdges.length} incoming edges (BodyDependencies works)`);

  // Edge integrity
  const nodeIds = new Set(model.nodes.map(n => n.id));
  const dangling = model.edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  assert(dangling.length === 0, `No dangling edges (found ${dangling.length})`);
}

function testTraceNoSiblings() {
  console.log('\n── Trace: No Siblings / Cross-Connections ──');

  const Graph = require('graphology');
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

function testCoWriterFilter() {
  console.log('\n── Trace: Co-Writer Filter ──');

  const Graph = require('graphology');
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

async function testSynapseTrace() {
  console.log('\n── Synapse Dacpac: Trace No Siblings ──');
  const dacpacPath = resolve(__dirname, './AdventureWorks_sdk-style.dacpac');
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
    const { bfsFromNode: bfs } = require('graphology-traversal');
    bfs(graph, proc.id, (node: string, _: unknown, depth: number) => {
      if (depth > 2) return true;
      upNodes.add(node);
    }, { mode: 'inbound' });
    bfs(graph, proc.id, (node: string, _: unknown, depth: number) => {
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

async function testTypeAwareDirection() {
  console.log('\n── Type-Aware Direction: XML type matches regex direction ──');

  // Proves: for every dep where both XML and regex agree, the object-type-based
  // direction inference matches what regex determined. If this holds for the
  // overlap set, the fallback is correct for XML-only deps too.

  const { XMLParser } = await import('fast-xml-parser');
  const JSZip = (await import('jszip')).default;

  const ELEMENT_TYPE_MAP: Record<string, string> = {
    SqlTable: 'table', SqlView: 'view', SqlProcedure: 'procedure',
    SqlScalarFunction: 'function', SqlInlineTableValuedFunction: 'function',
    SqlMultiStatementTableValuedFunction: 'function', SqlTableValuedFunction: 'function',
  };

  function normName(name: string): string {
    const parts = name.replace(/\[|\]/g, '').split('.');
    if (parts.length >= 2) return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
    return `[dbo].[${parts[0]}]`.toLowerCase();
  }

  function isObjectLevelRef(name: string): boolean {
    const parts = name.replace(/\[|\]/g, '').split('.');
    return parts.length === 2 && !parts[1].startsWith('@');
  }

  function extractPropVal(prop: any): string | undefined {
    if (prop['@_Value'] !== undefined) return String(prop['@_Value']);
    if (prop.Value !== undefined) {
      if (typeof prop.Value === 'string') return prop.Value;
      if (typeof prop.Value === 'object' && prop.Value['#text']) return String(prop.Value['#text']);
    }
    return undefined;
  }

  function asArr<T>(val: T | T[] | undefined): T[] {
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
  }

  const dacpacs = [
    { label: 'Classic', path: resolve(__dirname, './AdventureWorks.dacpac') },
    { label: 'SDK-style', path: resolve(__dirname, './AdventureWorks_sdk-style.dacpac') },
  ];

  for (const { label, path } of dacpacs) {
    const buf = readFileSync(path);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('model.xml')!.async('string');
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_',
      isArray: (n: string) => ['Element', 'Entry', 'Property', 'Relationship', 'Annotation'].includes(n),
      parseTagValue: true, trimValues: true,
    });
    const doc = parser.parse(xml);
    const elements: any[] = asArr(doc?.DataSchemaModel?.Model?.Element);

    // Build catalog with types
    const catalog = new Set<string>();
    const catalogType = new Map<string, string>();
    for (const el of elements) {
      const t = el['@_Type'];
      const n = el['@_Name'];
      if (!n) continue;
      const objType = ELEMENT_TYPE_MAP[t];
      if (objType) { const id = normName(n); catalog.add(id); catalogType.set(id, objType); }
    }

    let totalChecked = 0;
    let matches = 0;
    let expectedMismatches = 0;  // table WRITEs — handled by regex, never reach type-aware path
    const mismatches: string[] = [];

    for (const el of elements) {
      if (el['@_Type'] !== 'SqlProcedure') continue;
      const spName = el['@_Name'];
      if (!spName) continue;
      const spId = normName(spName);

      // XML BodyDependencies
      const xmlDeps = new Set<string>();
      for (const rel of asArr(el.Relationship)) {
        if (rel['@_Name'] !== 'BodyDependencies' && rel['@_Name'] !== 'QueryDependencies') continue;
        for (const entry of asArr(rel.Entry)) {
          for (const ref of asArr(entry.References)) {
            if (ref['@_ExternalSource']) continue;
            const rn = ref['@_Name'];
            if (!rn || !isObjectLevelRef(rn)) continue;
            const norm = normName(rn);
            if (norm !== spId && catalog.has(norm)) xmlDeps.add(norm);
          }
        }
      }

      // Body script
      let bodyScript: string | undefined;
      for (const ann of asArr(el.Annotation)) {
        if (ann['@_Type'] === 'SysCommentsObjectAnnotation') {
          for (const prop of asArr(ann.Property)) {
            if (prop['@_Name'] === 'HeaderContents') {
              const header = extractPropVal(prop);
              for (const p of asArr(el.Property)) {
                if (p['@_Name'] === 'BodyScript') {
                  const val = extractPropVal(p);
                  if (header && val) bodyScript = `${header}\n${val}`;
                }
              }
            }
          }
        }
      }
      if (!bodyScript) {
        for (const p of asArr(el.Property)) {
          if (p['@_Name'] === 'BodyScript') bodyScript = extractPropVal(p);
        }
      }
      if (!bodyScript) continue;

      // Regex parse
      const parsed = parseSqlBody(bodyScript);
      const regexSources = new Set<string>();
      const regexTargets = new Set<string>();
      const regexExec = new Set<string>();
      const regexAll = new Set<string>();

      for (const s of parsed.sources) { const n = normName(s); if (n !== spId && catalog.has(n)) { regexAll.add(n); regexSources.add(n); } }
      for (const t of parsed.targets) { const n = normName(t); if (n !== spId && catalog.has(n)) { regexAll.add(n); regexTargets.add(n); } }
      for (const e of parsed.execCalls) { const n = normName(e); if (n !== spId && catalog.has(n)) { regexAll.add(n); regexExec.add(n); } }

      // For each dep in both XML and regex: compare type-inferred direction vs regex direction
      for (const dep of xmlDeps) {
        if (!regexAll.has(dep)) continue;  // XML-only, skip (that's the fallback case)
        totalChecked++;

        const depType = catalogType.get(dep) || 'unknown';
        const typeInferred = depType === 'procedure' ? 'EXEC' : 'READ';
        const regexDir = regexExec.has(dep) ? 'EXEC' : regexTargets.has(dep) ? 'WRITE' : 'READ';

        if (typeInferred === regexDir) {
          matches++;
        } else if (regexDir === 'WRITE' && depType === 'table') {
          // Expected: table WRITEs are in regex outboundIds, so excluded from type-aware path
          expectedMismatches++;
        } else {
          mismatches.push(`${spName} → ${dep}: type=${depType} inferred=${typeInferred} regex=${regexDir}`);
        }
      }
    }

    const pct = totalChecked > 0 ? ((matches + expectedMismatches) / totalChecked * 100).toFixed(1) : '0';
    assert(mismatches.length === 0,
      `${label}: type-aware direction matches regex for ${matches}/${totalChecked} deps (${pct}%, ${expectedMismatches} table-WRITEs handled by regex)`);

    if (mismatches.length > 0) {
      for (const m of mismatches) console.log(`    MISMATCH: ${m}`);
    }
  }
}

async function testNumericEntitySecurity() {
  console.log('\n── Security: Numeric Entity DoS (CVE-2026-25128) ──');

  // Craft a minimal dacpac-like XML with out-of-range numeric entities
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true,
  });

  // Test 1: Out-of-range decimal entity — must NOT throw RangeError
  const xmlDecimal = `<root><item>test &#9999999; value</item></root>`;
  let decimalOk = false;
  try {
    parser.parse(xmlDecimal);
    decimalOk = true;
  } catch (e: unknown) {
    if (e instanceof RangeError) {
      decimalOk = false;
    } else {
      // Other errors are acceptable (not DoS)
      decimalOk = true;
    }
  }
  assert(decimalOk, 'Out-of-range decimal entity (&#9999999;) does not crash with RangeError');

  // Test 2: Out-of-range hex entity — must NOT throw RangeError
  const xmlHex = `<root><item>test &#xFFFFFF; value</item></root>`;
  let hexOk = false;
  try {
    parser.parse(xmlHex);
    hexOk = true;
  } catch (e: unknown) {
    if (e instanceof RangeError) {
      hexOk = false;
    } else {
      hexOk = true;
    }
  }
  assert(hexOk, 'Out-of-range hex entity (&#xFFFFFF;) does not crash with RangeError');

  // Test 3: Valid entity parses without error
  const xmlValid = `<root><item>test &#65; value</item></root>`;
  let validOk = false;
  try {
    parser.parse(xmlValid);
    validOk = true;
  } catch {
    validOk = false;
  }
  assert(validOk, 'Valid entity &#65; parses without error');

  // Test 4: processEntities mode (this is where v4.x was vulnerable)
  const parserWithEntities = new XMLParser({
    processEntities: true,
    htmlEntities: true,
  });

  let entDecOk = false;
  try {
    parserWithEntities.parse(`<root>&#9999999;</root>`);
    entDecOk = true;
  } catch (e: unknown) {
    entDecOk = !(e instanceof RangeError);
  }
  assert(entDecOk, 'processEntities + out-of-range decimal does not RangeError');

  let entHexOk = false;
  try {
    parserWithEntities.parse(`<root>&#xFFFFFF;</root>`);
    entHexOk = true;
  } catch (e: unknown) {
    entHexOk = !(e instanceof RangeError);
  }
  assert(entHexOk, 'processEntities + out-of-range hex does not RangeError');
}

async function testImportErrorHandling() {
  console.log('\n── Import Error Handling ──');
  const JSZip = (await import('jszip')).default;

  // Non-ZIP file → friendly error
  try {
    await extractDacpac(new TextEncoder().encode('this is not a zip file').buffer as ArrayBuffer);
    assert(false, 'Non-ZIP should throw');
  } catch (err: unknown) {
    const msg = (err as Error).message;
    assert(msg.includes('Not a valid .dacpac file'), `Non-ZIP error is user-friendly: "${msg}"`);
    assert(!msg.includes('https://'), 'No raw URL in error message');
  }

  // Empty file → friendly error
  try {
    await extractDacpac(new ArrayBuffer(0));
    assert(false, 'Empty file should throw');
  } catch (err: unknown) {
    const msg = (err as Error).message;
    assert(msg.includes('corrupted or truncated') || msg.includes('Not a valid'), `Empty file error is user-friendly: "${msg}"`);
  }

  // ZIP without model.xml → existing clear error
  const zip = new JSZip();
  zip.file('other.xml', '<root/>');
  const noModelBuf = await zip.generateAsync({ type: 'arraybuffer' });
  try {
    await extractDacpac(noModelBuf);
    assert(false, 'ZIP without model.xml should throw');
  } catch (err: unknown) {
    const msg = (err as Error).message;
    assert(msg.includes('model.xml not found'), `Missing model.xml error: "${msg}"`);
  }

  // Valid dacpac with no tracked elements → warnings populated
  const emptyZip = new JSZip();
  emptyZip.file('model.xml', `<?xml version="1.0"?>
    <DataSchemaModel>
      <Model>
        <Element Type="SqlDatabaseOptions" Name="Options"/>
      </Model>
    </DataSchemaModel>`);
  const emptyBuf = await emptyZip.generateAsync({ type: 'arraybuffer' });
  const emptyModel = await extractDacpac(emptyBuf);
  assert(emptyModel.nodes.length === 0, 'Empty dacpac has 0 nodes');
  assert(emptyModel.warnings !== undefined && emptyModel.warnings.length > 0, 'Empty dacpac has warnings');
  assert(emptyModel.warnings![0].includes('No tables, views, or stored procedures'), `Warning explains why: "${emptyModel.warnings![0]}"`);

  // Successful extraction → no warnings
  const buffer = readFileSync(DACPAC_PATH);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);
  assert(model.warnings === undefined, 'Successful extraction has no warnings');
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('═══ DACPAC Lineage Engine Tests ═══');

  try {
    const model = await testExtraction();
    await testFiltering(model);
    testSqlBodyParser();
    testTraceNoSiblings();
    testCoWriterFilter();
    await testSynapseTrace();
    await testGraphBuilder(model);
    await testEdgeIntegrity(model);
    await testFabricDacpac();
    await testTypeAwareDirection();
    await testNumericEntitySecurity();
    await testImportErrorHandling();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
    failed++;
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
