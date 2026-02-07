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

/** Parse all SPs from a dacpac and return structured results for comparison */
async function parseAllSpBodies(dacpacPath: string): Promise<Map<string, { sources: string[]; targets: string[]; execCalls: string[] }>> {
  const buffer = readFileSync(dacpacPath);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);
  const results = new Map<string, { sources: string[]; targets: string[]; execCalls: string[] }>();

  for (const node of model.nodes) {
    if (node.type !== 'procedure' || !node.bodyScript) continue;
    const parsed = parseSqlBody(node.bodyScript);
    results.set(node.fullName, {
      sources: parsed.sources.sort(),
      targets: parsed.targets.sort(),
      execCalls: parsed.execCalls.sort(),
    });
  }
  return results;
}

function logSpParseResults(label: string, results: Map<string, { sources: string[]; targets: string[]; execCalls: string[] }>) {
  console.log(`\n── ${label} ──`);
  for (const [name, r] of [...results.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = r.sources.length ? r.sources.join(', ') : '(none)';
    const t = r.targets.length ? r.targets.join(', ') : '(none)';
    const e = r.execCalls.length ? r.execCalls.join(', ') : '(none)';
    console.log(`  ${name}`);
    console.log(`    sources: ${s}`);
    console.log(`    targets: ${t}`);
    if (r.execCalls.length) console.log(`    exec:    ${e}`);
  }
}

function compareSpParseResults(
  before: Map<string, { sources: string[]; targets: string[]; execCalls: string[] }>,
  after: Map<string, { sources: string[]; targets: string[]; execCalls: string[] }>,
): { regressions: string[]; improvements: string[] } {
  const regressions: string[] = [];
  const improvements: string[] = [];

  for (const [name, b] of before) {
    const a = after.get(name);
    if (!a) { regressions.push(`${name}: MISSING after change`); continue; }

    // Check for lost refs (regression)
    for (const s of b.sources) if (!a.sources.includes(s)) regressions.push(`${name}: LOST source "${s}"`);
    for (const t of b.targets) if (!a.targets.includes(t)) regressions.push(`${name}: LOST target "${t}"`);
    for (const e of b.execCalls) if (!a.execCalls.includes(e)) regressions.push(`${name}: LOST exec "${e}"`);

    // Check for new refs (improvement)
    for (const s of a.sources) if (!b.sources.includes(s)) improvements.push(`${name}: NEW source "${s}"`);
    for (const t of a.targets) if (!b.targets.includes(t)) improvements.push(`${name}: NEW target "${t}"`);
    for (const e of a.execCalls) if (!b.execCalls.includes(e)) improvements.push(`${name}: NEW exec "${e}"`);
  }
  return { regressions, improvements };
}

async function testAllSpParsing() {
  const fabricPath = resolve(__dirname, './AdventureWorks_sdk-style.dacpac');
  const ssdtPath = resolve(__dirname, './AdventureWorks.dacpac');

  const fabricResults = await parseAllSpBodies(fabricPath);
  const ssdtResults = await parseAllSpBodies(ssdtPath);

  logSpParseResults('Fabric SP Parsing (all SPs)', fabricResults);
  logSpParseResults('SSDT SP Parsing (all SPs)', ssdtResults);

  // Return for later comparison
  return { fabricResults, ssdtResults };
}

function testCase1Sql() {
  console.log('\n── Case 1: INSERT INTO detection ──');
  const sql = readFileSync(resolve(__dirname, 'sql/case1.sql'), 'utf-8');
  const r = parseSqlBody(sql);
  console.log('  Sources:', r.sources);
  console.log('  Targets:', r.targets);
  console.log('  ExecCalls:', r.execCalls);

  assert(r.targets.some(t => t.includes('OrderWorker')), 'INSERT INTO OrderWorker detected as target');
  assert(r.sources.some(s => s.includes('OrderExtract_20260121')), 'OrderExtract source detected');
  assert(r.sources.some(s => s.includes('DataFilters')), 'DataFilters source detected');
  assert(r.execCalls.some(e => e.includes('LogMessage')), 'LogMessage exec call detected');
  // CTE names should NOT appear as sources
  assert(!r.sources.some(s => s.toLowerCase() === 'sourcecte'), 'CTE SourceCTE excluded');
  assert(!r.sources.some(s => s.toLowerCase() === 'cte_taskcountry'), 'CTE cte_taskcountry excluded');
  assert(!r.sources.some(s => s.toLowerCase() === 'cte_combine'), 'CTE cte_combine excluded');
  assert(!r.sources.some(s => s.toLowerCase() === 'cte_init_calculations'), 'CTE cte_init_calculations excluded');
}

function testCase1RealObjectResolution() {
  console.log('\n── Case 1: Real Object Resolution + Edge Direction ──');

  // Simulate a dacpac model with the real objects from case1.sql
  const sql = readFileSync(resolve(__dirname, 'sql/case1.sql'), 'utf-8');
  const parsed = parseSqlBody(sql);

  // These are the "real" objects that would exist in the dacpac
  const realObjects = [
    '[ETL].[spProcessOrders_INIT]',  // the SP itself
    '[ETL].[OrderWorker]',        // INSERT INTO target
    '[STAGING].[OrderExtract_20260121]',     // source table
    '[REPORTING].[DataFilters]',              // source table
    '[dbo].[LogMessage]',                                  // exec call
  ];

  // normalizeName: strip brackets, re-bracket, lowercase
  function normalizeName(name: string): string {
    const parts = name.replace(/\[|\]/g, '').split('.');
    if (parts.length >= 2) {
      return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
    }
    return `[dbo].[${parts[0]}]`.toLowerCase();
  }

  const nodeIds = new Set(realObjects.map(normalizeName));
  const spId = normalizeName('[ETL].[spProcessOrders_INIT]');

  // Check sources resolve to real objects
  const resolvedSources: string[] = [];
  for (const dep of parsed.sources) {
    const depId = normalizeName(dep);
    if (depId !== spId && nodeIds.has(depId)) resolvedSources.push(dep);
  }
  console.log('  Resolved sources:', resolvedSources);
  assert(resolvedSources.some(s => s.includes('OrderExtract_20260121')), 'Source OrderExtract resolves to real object');
  assert(resolvedSources.some(s => s.includes('DataFilters')), 'Source DataFilters resolves to real object');

  // Check targets resolve to real objects
  const resolvedTargets: string[] = [];
  for (const dep of parsed.targets) {
    const depId = normalizeName(dep);
    if (depId !== spId && nodeIds.has(depId)) resolvedTargets.push(dep);
  }
  console.log('  Resolved targets:', resolvedTargets);
  assert(resolvedTargets.some(t => t.includes('OrderWorker')), 'Target OrderWorker resolves to real object');

  // Check exec calls resolve
  const resolvedExec: string[] = [];
  for (const dep of parsed.execCalls) {
    const depId = normalizeName(dep);
    if (depId !== spId && nodeIds.has(depId)) resolvedExec.push(dep);
  }
  console.log('  Resolved exec:', resolvedExec);
  assert(resolvedExec.some(e => e.includes('LogMessage')), 'Exec LogMessage resolves to real object');

  // Verify edge directions (the bug fix)
  // Sources: table → SP (incoming)
  // Targets: SP → table (outgoing) — was previously reversed!
  // Exec: SP → called_SP (outgoing)
  const edges: Array<{ source: string; target: string; type: string }> = [];

  for (const dep of parsed.sources) {
    const depId = normalizeName(dep);
    if (depId !== spId && nodeIds.has(depId)) {
      edges.push({ source: depId, target: spId, type: 'source' });
    }
  }
  for (const dep of parsed.targets) {
    const depId = normalizeName(dep);
    if (depId !== spId && nodeIds.has(depId)) {
      // FIXED: SP → target (outgoing), not target → SP
      edges.push({ source: spId, target: depId, type: 'target' });
    }
  }
  for (const dep of parsed.execCalls) {
    const depId = normalizeName(dep);
    if (depId !== spId && nodeIds.has(depId)) {
      edges.push({ source: spId, target: depId, type: 'exec' });
    }
  }

  console.log('  Edges:', edges.map(e => `${e.source} → ${e.target} (${e.type})`));

  const targetEdge = edges.find(e => e.type === 'target');
  assert(!!targetEdge, 'Target edge exists');
  assert(targetEdge!.source === spId, 'Target edge source is the SP (outgoing)');
  assert(targetEdge!.target === normalizeName('ETL.OrderWorker'), 'Target edge target is OrderWorker');

  const sourceEdge = edges.find(e => e.type === 'source' && e.source.includes('cadenceextract'));
  assert(!!sourceEdge, 'Source edge exists');
  assert(sourceEdge!.target === spId, 'Source edge target is the SP (incoming)');
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

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('═══ DACPAC Lineage Engine Tests ═══');

  try {
    const model = await testExtraction();
    await testFiltering(model);
    testSqlBodyParser();
    testTraceNoSiblings();
    await testSynapseTrace();
    // Skipped: testCase1Sql() - requires test/sql/case1.sql
    // Skipped: testCase1RealObjectResolution() - requires test/sql/case1.sql
    await testAllSpParsing();
    await testGraphBuilder(model);
    await testEdgeIntegrity(model);
    await testFabricDacpac();
    await testNumericEntitySecurity();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
    failed++;
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
