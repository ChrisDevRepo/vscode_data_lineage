/**
 * integration-db.test.ts — Live DB integration tests for ET (External Table) detection,
 * dacpac ET extraction, and strict DB vs dacpac parity.
 * Run with: npm run test:db
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { createDbAdapter } from './helpers/dbAdapter.js';
import { buildModelFromDmv, buildSchemaPreview } from '../../src/engine/dmvExtractor.js';
import { extractDacpac } from '../../src/engine/dacpacExtractor.js';
import { loadRules } from '../../src/engine/sqlBodyParser.js';
import type { ParseRulesConfig } from '../../src/engine/sqlBodyParser.js';
import {
  buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult,
} from '../../src/engine/profilingEngine.js';
import type { StatsMode } from '../../src/engine/profilingEngine.js';
import { DEFAULT_CONFIG } from '../../src/engine/types.js';
import type { ColumnDef, LineageNode } from '../../src/engine/types.js';
import { buildGraph } from '../../src/engine/graphBuilder.js';
import { runAnalysis } from '../../src/engine/graphAnalysis.js';
import { expandSchemaPlaceholder } from '../../src/utils/sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load parse rules once — required by extractDacpac → buildModel → parseSqlBody
const rulesYaml = readFileSync(resolve(__dirname, '../assets/defaultParseRules.yaml'), 'utf-8');
loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

const AW_DACPAC = resolve(__dirname, '..', 'fixtures', 'AdventureWorks2025_AI.dacpac');

let pass = 0, fail = 0;

function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

// ─── Dacpac: ET extraction (no live DB required) ─────────────────────────────

async function testAWDacpac() {
  console.log('\n── AdventureWorks2025 (dacpac) ──');
  const buffer = readFileSync(AW_DACPAC).buffer as ArrayBuffer;
  const model = await extractDacpac(buffer);

  ok('Nodes extracted', model.nodes.length > 0, `${model.nodes.length}`);
  ok('Edges extracted', model.edges.length > 0, `${model.edges.length}`);

  const etNodes = model.nodes.filter(n => n.type === 'external');
  const hasExt  = etNodes.some(n => n.fullName.toLowerCase().includes('externalsales'));
  ok('External table nodes detected (dacpac)', etNodes.length > 0, `found ${etNodes.length}`);
  ok('ext.ExternalSales found (dacpac)', hasExt,
    `nodes: ${etNodes.map(n => n.fullName).join(', ') || '(none)'}`);
  if (etNodes.length > 0) {
    ok('ET node externalType=et (dacpac)', etNodes[0].externalType === 'et', `${etNodes[0].externalType}`);
    ok('ET node has columns (dacpac)', (etNodes[0].columns?.length ?? 0) > 0,
      'columns should be populated from XML column extraction');
  }

  const extSchema = model.schemas.find(s => s.name.toLowerCase() === 'ext');
  ok('ext schema present (dacpac)', !!extSchema,
    `schemas: ${model.schemas.map(s => s.name).join(', ')}`);
  if (extSchema) ok('ext.types.external > 0 (dacpac)', extSchema.types.external > 0,
    JSON.stringify(extSchema.types));
}

// ─── DB: Live ET detection ───────────────────────────────────────────────────

async function testAW() {
  console.log('\n── AdventureWorks2025 (DB import) ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const { dmvResults } = await db.runAllPhases();
    const model = buildModelFromDmv(dmvResults);
    ok('Nodes extracted', model.nodes.length > 0, `${model.nodes.length}`);
    ok('Edges extracted', model.edges.length > 0, `${model.edges.length}`);

    const etNodes = model.nodes.filter(n => n.type === 'external');
    const hasExt  = etNodes.some(n => n.fullName.toLowerCase().includes('externalsales'));
    ok('External table nodes detected (DB)', etNodes.length > 0, `found ${etNodes.length}`);
    ok('ext.ExternalSales found (DB)', hasExt,
      `nodes: ${etNodes.map(n => n.fullName).join(', ') || '(none)'}`);
    if (etNodes.length > 0) {
      ok('ET node externalType=et (DB)', etNodes[0].externalType === 'et', `${etNodes[0].externalType}`);
      ok('ET node has columns (DB)', (etNodes[0].columns?.length ?? 0) > 0,
        'columns should be populated from columns query');
    }
  } finally { await db.close(); }
}

async function testSchemaPreviewET() {
  console.log('\n── Schema Preview ET count (DB) ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const queries = (db as any).queries as Array<{name: string; sql: string}>;
    const previewQ = queries.find((q: any) => q.name === 'schema-preview')!;
    const result = await db.query(previewQ.sql);
    const preview = buildSchemaPreview(result);

    const extSchema = preview.schemas.find(s => s.name.toLowerCase() === 'ext');
    ok('ext schema in preview', !!extSchema, `schemas: ${preview.schemas.map(s=>s.name).join(', ')}`);
    if (extSchema) ok('ext has external count > 0', extSchema.types.external > 0,
      JSON.stringify(extSchema.types));
  } finally { await db.close(); }
}

async function testDW() {
  console.log('\n── AdventureWorksDW2025 (DB import) ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW_DW ?? 'AdventureWorksDW2025');
  try {
    const { dmvResults } = await db.runAllPhases();
    const model = buildModelFromDmv(dmvResults);
    ok('Nodes extracted', model.nodes.length > 0, `${model.nodes.length}`);
    ok('No warnings', !model.warnings?.length);
  } finally { await db.close(); }
}

// ─── Parity: dacpac and DB must produce identical nodes and lineage ───────────

async function testParityDacpacVsDb() {
  console.log('\n── Parity: dacpac vs DB import ──');

  // Dacpac model
  const buffer = readFileSync(AW_DACPAC).buffer as ArrayBuffer;
  const dacpacModel = await extractDacpac(buffer);

  // DB model
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  let dbModel;
  try {
    const { dmvResults } = await db.runAllPhases();
    dbModel = buildModelFromDmv(dmvResults);
  } finally { await db.close(); }

  // ── Node sets must match exactly ──────────────────────────────────────────
  const dacpacNames = new Set(dacpacModel.nodes.map(n => n.fullName.toLowerCase()));
  const dbNames     = new Set(dbModel.nodes.map(n => n.fullName.toLowerCase()));

  const onlyInDacpac = [...dacpacNames].filter(n => !dbNames.has(n));
  const onlyInDb     = [...dbNames].filter(n => !dacpacNames.has(n));
  ok('Node sets match exactly',
    onlyInDacpac.length === 0 && onlyInDb.length === 0,
    `only in dacpac: [${onlyInDacpac.join(', ')}]  only in db: [${onlyInDb.join(', ')}]`);

  // Node types must match for every shared node
  const dacpacTypeMap = new Map(dacpacModel.nodes.map(n => [n.fullName.toLowerCase(), n.type]));
  const typeErrors: string[] = [];
  for (const dbNode of dbModel.nodes) {
    const key = dbNode.fullName.toLowerCase();
    const dacpacType = dacpacTypeMap.get(key);
    if (dacpacType && dacpacType !== dbNode.type) {
      typeErrors.push(`${dbNode.fullName}: dacpac=${dacpacType} db=${dbNode.type}`);
    }
  }
  ok('Node types match for all shared nodes', typeErrors.length === 0,
    typeErrors.join('; '));

  // ET detection must match
  const dacpacET = dacpacModel.nodes.filter(n => n.type === 'external');
  const dbET     = dbModel.nodes.filter(n => n.type === 'external');
  ok('ET node count matches', dacpacET.length === dbET.length,
    `dacpac: ${dacpacET.length}, db: ${dbET.length}`);
  ok('externalType=et in both paths',
    dacpacET.every(n => n.externalType === 'et') && dbET.every(n => n.externalType === 'et'));

  // ── Edge sets must match (excluding known DMV-only method refs) ──────────
  // XML/HierarchyID method calls appear as deps in sys.sql_expression_dependencies
  // but not in dacpac BodyDependencies — these are method invocations, not object refs
  const METHOD_NAMES = new Set(['getancestor', 'getdescendant', 'getlevel', 'getreparentedvalue',
    'isdescendantof', 'parse', 'read', 'tostring', 'write', 'value', 'query', 'exist', 'modify', 'nodes']);
  const isMethodRef = (ek: string) => {
    const target = ek.split('→')[1] ?? '';
    const name = target.replace(/\[|\]/g, '').split('.').pop() ?? '';
    return METHOD_NAMES.has(name);
  };

  // Dacpac BodyDependencies cannot express cross-schema deps to external tables (ET) —
  // the dep is in sys.sql_expression_dependencies but not in XML. List known structural deltas.
  const KNOWN_DB_ONLY_EDGES = new Set([
    '[dbo].[fnexternal]→[ext].[externalsales]',
  ]);
  const isKnownDelta = (ek: string) => KNOWN_DB_ONLY_EDGES.has(ek);

  const edgeKey = (s: string, t: string) => `${s.toLowerCase()}→${t.toLowerCase()}`;
  const dacpacEdges = new Set(dacpacModel.edges.map(e => edgeKey(e.source, e.target)));
  const dbEdges     = new Set(dbModel.edges.map(e => edgeKey(e.source, e.target)));

  const onlyInDacpacEdges = [...dacpacEdges].filter(e => !dbEdges.has(e) && !isMethodRef(e));
  const onlyInDbEdges     = [...dbEdges].filter(e => !dacpacEdges.has(e) && !isMethodRef(e) && !isKnownDelta(e));
  const methodRefEdges    = [...dbEdges].filter(e => !dacpacEdges.has(e) && isMethodRef(e));
  const knownDeltaEdges   = [...dbEdges].filter(e => !dacpacEdges.has(e) && isKnownDelta(e));
  if (methodRefEdges.length > 0) {
    console.log(`  (excluded ${methodRefEdges.length} XML/HierarchyID method refs from parity check)`);
  }
  if (knownDeltaEdges.length > 0) {
    console.log(`  (excluded ${knownDeltaEdges.length} known DB-only structural deltas: ${knownDeltaEdges.join(', ')})`);
  }
  ok('Edge sets match (excl. method refs + known deltas)',
    onlyInDacpacEdges.length === 0 && onlyInDbEdges.length === 0,
    `only in dacpac (${onlyInDacpacEdges.length}): ${onlyInDacpacEdges.slice(0,5).join(', ')}` +
    `  only in db (${onlyInDbEdges.length}): ${onlyInDbEdges.slice(0,5).join(', ')}`);
}

// ─── Constraint parity: dacpac vs DB, side by side ───────────────────────────

/** Extract constraint counts directly from LineageNode model data. */
function getConstraintCounts(node: LineageNode): {
  fkCount: number; colCount: number;
} {
  return {
    fkCount: node.fks?.length ?? 0,
    colCount: node.columns?.length ?? 0,
  };
}

async function testConstraintParity() {
  console.log('\n── Constraint Parity: dacpac vs DB (per table) ──');

  const buffer = readFileSync(AW_DACPAC).buffer as ArrayBuffer;
  const dacpacModel = await extractDacpac(buffer);

  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  let dbModel;
  try {
    const { dmvResults } = await db.runAllPhases();
    dbModel = buildModelFromDmv(dmvResults);
  } finally { await db.close(); }

  const dacpacTables = new Map(dacpacModel.nodes.filter(n => n.type === 'table' || n.type === 'external').map(n => [n.fullName.toLowerCase(), n]));
  const dbTables     = new Map(dbModel.nodes.filter(n => n.type === 'table' || n.type === 'external').map(n => [n.fullName.toLowerCase(), n]));

  const sharedKeys = [...dacpacTables.keys()].filter(k => dbTables.has(k)).sort();

  // Header
  const col1 = 35, col2 = 14, col3 = 14;
  console.log(`\n  ${'Table'.padEnd(col1)} | ${'Dacpac FK/Col'.padEnd(col2)} | ${'DB FK/Col'.padEnd(col3)} | Match`);
  console.log(`  ${'-'.repeat(col1)}-+-${'-'.repeat(col2)}-+-${'-'.repeat(col3)}-+------`);

  let matchCount = 0, mismatchCount = 0;
  for (const key of sharedKeys) {
    const dacpacNode = dacpacTables.get(key)!;
    const dbNode     = dbTables.get(key)!;
    const dp = getConstraintCounts(dacpacNode);
    const db2 = getConstraintCounts(dbNode);

    const dpSummary = `FK:${dp.fkCount} Col:${dp.colCount}`;
    const dbSummary = `FK:${db2.fkCount} Col:${db2.colCount}`;
    const match = dp.fkCount === db2.fkCount;
    if (match) matchCount++; else mismatchCount++;

    const label = dacpacNode.fullName.replace(/\[|\]/g, '').replace('.', '.');
    const icon  = match ? '✓' : '✗';
    console.log(`  ${label.padEnd(col1)} | ${dpSummary.padEnd(col2)} | ${dbSummary.padEnd(col3)} | ${icon}`);

    if (!match) {
      console.log(`    dacpac: ${dpSummary}  db: ${dbSummary}`);
    }
  }

  console.log(`\n  Shared tables: ${sharedKeys.length}  Match: ${matchCount}  Mismatch: ${mismatchCount}`);
  ok('All shared tables have identical FK counts', mismatchCount === 0,
    `${mismatchCount} mismatches`);
}

// ─── Profiling: live SQL execution against DB ────────────────────────────────

async function testProfiling() {
  console.log('\n── Profiling: live SQL against AdventureWorks2025 ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    // Pick a known table: HumanResources.Employee (small, mixed types)
    const schema = 'HumanResources';
    const table = 'Employee';

    // 1. Row count via DMV
    const rcSql = buildRowCountQuery(schema, table);
    console.log(`  Row count query:\n    ${rcSql.replace(/\n/g, '\n    ')}`);
    const rcResult = await db.query(rcSql);
    const rowCount = rcResult.rowCount > 0 ? parseInt(rcResult.rows[0][0].displayValue, 10) || 0 : 0;
    console.log(`  Row count: ${rowCount}`);
    ok('Row count > 0', rowCount > 0, `${rowCount}`);

    // 2. Get column metadata from model
    const { dmvResults } = await db.runAllPhases(schema);
    const model = buildModelFromDmv(dmvResults);
    const empNode = model.nodes.find(n => n.name === table && n.schema === schema);
    ok('Employee node found', !!empNode);

    // Build column defs from the DMV columns query result.
    // Column order: schema_name(0), table_name(1), ordinal(2), column_name(3),
    //               type_name(4), max_length(5), precision(6), scale(7),
    //               is_nullable(8), is_identity(9), is_computed(10)
    const colsResult = dmvResults.columns;
    const colDefs: ColumnDef[] = [];
    if (colsResult) {
      for (const row of colsResult.rows) {
        const objName = row[1].displayValue;
        if (objName !== table) continue;
        const colName = row[3].displayValue;
        const typeName = row[4].displayValue;
        const maxLen = row[5].displayValue;
        const prec = row[6].displayValue;
        const scale = row[7].displayValue;
        const nullable = row[8].displayValue === '1' || row[8].displayValue === 'true' ? 'NULL' : 'NOT NULL';
        const isComputed = row[10]?.displayValue === '1' || row[10]?.displayValue === 'true';

        let typeStr = typeName;
        if (['varchar','nvarchar','char','nchar','varbinary'].includes(typeName)) {
          const len = parseInt(maxLen, 10);
          typeStr = len === -1 ? `${typeName}(max)` : `${typeName}(${typeName.startsWith('n') ? len/2 : len})`;
        } else if (['decimal','numeric'].includes(typeName)) {
          typeStr = `${typeName}(${prec},${scale})`;
        }

        colDefs.push({
          name: colName,
          type: isComputed ? '(computed)' : typeStr,
          nullable,
          extra: isComputed ? 'COMPUTED' : '',
        });
      }
    }
    ok('Columns extracted for Employee', colDefs.length > 0, `${colDefs.length} columns`);
    console.log(`  Columns: ${colDefs.map(c => `${c.name}(${c.type})`).join(', ')}`);

    // 3. Quick stats — full scan (Employee is small)
    const quickAggs = buildColumnAggregations(colDefs, false, 'quick');
    ok('Quick aggregations generated', quickAggs.length > 0, `${quickAggs.length} profilable columns`);

    const quickSql = buildProfilingQuery(schema, table, quickAggs, 2, rowCount, 100000, 10000);
    console.log(`  Quick stats query:\n    ${quickSql.replace(/\n/g, '\n    ')}`);
    ok('No TABLESAMPLE for small table', !quickSql.includes('TABLESAMPLE'));

    const quickResult = await db.query(quickSql);
    ok('Quick query returned 1 row', quickResult.rowCount === 1, `${quickResult.rowCount} rows`);

    // Parse result into row record
    const quickRow: Record<string, string> = {};
    for (let i = 0; i < quickResult.columnInfo.length; i++) {
      quickRow[quickResult.columnInfo[i].columnName] = quickResult.rows[0][i].displayValue;
    }
    const quickStats = parseProfilingResult(quickRow, colDefs, rowCount, false);
    ok('Quick stats parsed: rowCount matches', quickStats.rowCount === rowCount);
    ok('Quick stats: sampled=false', quickStats.sampled === false);

    const profiled = quickStats.columns.filter(c => !c.skipped);
    ok('Quick stats: profiled columns > 0', profiled.length > 0, `${profiled.length}`);
    for (const c of profiled) {
      ok(`  ${c.name}: distinctCount >= 0`, c.distinctCount >= 0, `${c.distinctCount}`);
      if (c.nullCount !== null) {
        ok(`  ${c.name}: nullCount >= 0`, c.nullCount >= 0, `${c.nullCount}`);
        ok(`  ${c.name}: nullPercent in [0,100]`, c.nullPercent! >= 0 && c.nullPercent! <= 100, `${c.nullPercent}%`);
      }
    }

    // 4. Detail stats
    const detailAggs = buildColumnAggregations(colDefs, false, 'standard');
    const detailSql = buildProfilingQuery(schema, table, detailAggs, 2, rowCount, 100000, 10000);
    console.log(`  Detail stats query:\n    ${detailSql.replace(/\n/g, '\n    ')}`);

    const detailResult = await db.query(detailSql);
    ok('Detail query returned 1 row', detailResult.rowCount === 1);

    const detailRow: Record<string, string> = {};
    for (let i = 0; i < detailResult.columnInfo.length; i++) {
      detailRow[detailResult.columnInfo[i].columnName] = detailResult.rows[0][i].displayValue;
    }
    const detailStats = parseProfilingResult(detailRow, colDefs, rowCount, false);
    const hasMinMax = detailStats.columns.some(c => c.min !== undefined);
    const hasLen = detailStats.columns.some(c => c.minLength !== undefined);
    ok('Detail stats: has min/max values', hasMinMax);
    ok('Detail stats: has string lengths', hasLen);

    // 5. Sampling test: force sampling by setting threshold=0
    const sampleAggs = buildColumnAggregations(colDefs, true, 'quick');
    const sampleSql = buildProfilingQuery(schema, table, sampleAggs, 2, rowCount, 0, 50);
    console.log(`  Sampling query (threshold=0, sampleSize=50):\n    ${sampleSql.replace(/\n/g, '\n    ')}`);
    ok('Sampling query has TABLESAMPLE', sampleSql.includes('TABLESAMPLE'));

    const sampleResult = await db.query(sampleSql);
    ok('Sampling query executed successfully', sampleResult.rowCount === 1);

    // 6. Approx vs exact distinct
    const approxAggs = buildColumnAggregations(colDefs, true, 'quick');
    const exactAggs = buildColumnAggregations(colDefs, false, 'quick');
    ok('Approx uses APPROX_COUNT_DISTINCT', approxAggs[0].fragments[0].includes('APPROX_COUNT_DISTINCT'));
    ok('Exact uses COUNT(DISTINCT', exactAggs[0].fragments[0].includes('COUNT(DISTINCT'));

    // Run both and compare (should be close for small table)
    const approxSql = buildProfilingQuery(schema, table, approxAggs, 2, rowCount, 100000, 10000);
    const exactSql = buildProfilingQuery(schema, table, exactAggs, 2, rowCount, 100000, 10000);
    const [approxRes, exactRes] = await Promise.all([db.query(approxSql), db.query(exactSql)]);
    ok('Both approx and exact queries execute', approxRes.rowCount === 1 && exactRes.rowCount === 1);

    console.log(`\n  Summary: ${colDefs.length} total columns, ${profiled.length} profiled, ${colDefs.length - profiled.length} skipped`);
    console.log(`  Quick stats columns: ${profiled.map(c => `${c.name}=${c.distinctCount}d/${c.nullCount ?? 0}n`).join(', ')}`);

  } finally { await db.close(); }
}

// ─── CTE wrapping: constraints query with schema filter ──────────────────────

async function testCteWrapping() {
  console.log('\n── CTE Wrapping: constraints query with schema filter ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    // Get the raw constraints query (contains WITH ... AS CTEs)
    const queries = (db as any).queries as Array<{name: string; sql: string}>;
    const constraintsQ = queries.find((q: any) => q.name === 'constraints')!;
    ok('Constraints query found', !!constraintsQ);
    ok('Constraints query uses CTE (WITH)', /^\s*WITH\s+/i.test(constraintsQ.sql));

    // 1. Run the correctly wrapped query (CTE-aware: wraps final SELECT only)
    const { dmvResults } = await db.runAllPhases('HumanResources');
    const constraintsResult = dmvResults.constraints;
    ok('Wrapped CTE query executes without error', !!constraintsResult);
    ok('Constraints returned rows', constraintsResult!.rowCount > 0, `${constraintsResult!.rowCount} rows`);

    // Verify FK data is correct
    const fkRows = constraintsResult!.rows.filter(r => r[2].displayValue === 'FK');
    ok('FK constraints found for HumanResources', fkRows.length > 0, `${fkRows.length} FK rows`);

    // 2. Simulate the OLD broken wrapping (subquery around entire CTE) — must fail
    const stripped = constraintsQ.sql.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '');
    const brokenSql = `SELECT * FROM (\n${stripped}\n) AS _sub\nWHERE _sub.schema_name IN ('HumanResources')`;
    let brokenFailed = false;
    try {
      await db.query(brokenSql);
    } catch (err) {
      brokenFailed = true;
      const msg = String(err);
      ok('Old wrapping fails with WITH syntax error', msg.includes('WITH') || msg.includes('syntax'),
        msg.slice(0, 100));
    }
    ok('Old subquery-around-CTE wrapping correctly rejected by SQL Server', brokenFailed);

  } finally { await db.close(); }
}

// ─── Per-query execution: every YAML query must run without SQL error ────────

async function testPerQueryExecution() {
  console.log('\n── Per-query execution: all YAML queries against live DB ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const queries = (db as any).queries as Array<{ name: string; sql: string; phase?: number }>;

    // Phase 1: execute raw (no expansion needed)
    const phase1 = queries.filter(q => q.phase === 1);
    for (const q of phase1) {
      const result = await db.query(q.sql);
      ok(`Phase 1 '${q.name}' executes`, result.rowCount >= 0, `${result.rowCount} rows`);
      ok(`Phase 1 '${q.name}' returns rows`, result.rowCount > 0, `${result.rowCount} rows`);
    }

    // Get all schema names from schema-preview for expansion
    const previewQ = phase1.find(q => q.name === 'schema-preview')!;
    const previewResult = await db.query(previewQ.sql);
    const allSchemas = [...new Set(previewResult.rows.map(r => r[0].displayValue))];
    ok('Schema list non-empty', allSchemas.length > 0, allSchemas.join(', '));

    // Phase 2: expand {{SCHEMAS}} then execute
    const phase2 = queries.filter(q => (q.phase ?? 2) !== 1);
    for (const q of phase2) {
      // Verify placeholder exists before expansion
      ok(`Phase 2 '${q.name}' has {{SCHEMAS}}`, q.sql.includes('{{SCHEMAS}}'));

      const expanded = expandSchemaPlaceholder(q.sql, allSchemas);

      // Verify expansion removed all placeholders
      ok(`Phase 2 '${q.name}' expanded (no remnants)`, !expanded.includes('{{SCHEMAS}}'));

      // Execute against live DB — catches unexpanded {{SCHEMAS}} bugs
      const result = await db.query(expanded);
      ok(`Phase 2 '${q.name}' executes after expansion`, result.rowCount >= 0, `${result.rowCount} rows`);
      ok(`Phase 2 '${q.name}' returns rows`, result.rowCount > 0, `${result.rowCount} rows`);
    }
  } finally { await db.close(); }
}

// ─── Wizard flow simulation: Phase 1 → select schemas → Phase 2 → model ─────

async function testWizardFlow() {
  console.log('\n── Wizard flow simulation ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const queries = (db as any).queries as Array<{ name: string; sql: string; phase?: number }>;

    // Step 1: Phase 1 — schema-preview + all-objects (unfiltered)
    console.log('  Step 1: Phase 1 queries (unfiltered)');
    const previewQ = queries.find(q => q.name === 'schema-preview')!;
    const allObjQ = queries.find(q => q.name === 'all-objects')!;
    ok('schema-preview query found', !!previewQ);
    ok('all-objects query found', !!allObjQ);

    const [previewResult, allObjectsResult] = await Promise.all([
      db.query(previewQ.sql),
      db.query(allObjQ.sql),
    ]);
    ok('Phase 1 schema-preview returned rows', previewResult.rowCount > 0);
    ok('Phase 1 all-objects returned rows', allObjectsResult.rowCount > 0);

    // Step 2: Parse schema preview (simulates wizard UI showing schema list)
    const preview = buildSchemaPreview(previewResult);
    ok('Schema preview parsed', preview.schemas.length > 0, `${preview.schemas.length} schemas`);
    console.log(`  Step 2: Schema preview — ${preview.schemas.map(s => `${s.name}(${s.objectCount})`).join(', ')}`);

    // Step 3: User selects a subset of schemas (simulates wizard checkbox selection)
    const selectedSchemas = ['Production', 'Sales'];
    console.log(`  Step 3: User selects schemas: ${selectedSchemas.join(', ')}`);

    // Step 4: Phase 2 — expand {{SCHEMAS}} and execute filtered queries
    console.log('  Step 4: Phase 2 queries (filtered)');
    const phase2 = queries.filter(q => (q.phase ?? 2) !== 1);
    const resultMap = new Map<string, import('../src/types/mssql').SimpleExecuteResult>();

    for (const q of phase2) {
      const expanded = expandSchemaPlaceholder(q.sql, selectedSchemas);
      ok(`'${q.name}' expanded without remnants`, !expanded.includes('{{SCHEMAS}}'));
      const result = await db.query(expanded);
      ok(`'${q.name}' executed successfully`, result.rowCount >= 0, `${result.rowCount} rows`);
      resultMap.set(q.name, result);
    }

    // Step 5: Build model (same as production runDbPhase2)
    console.log('  Step 5: Build model from DMV results');
    const dmvResults = {
      nodes: resultMap.get('nodes')!,
      columns: resultMap.get('columns')!,
      dependencies: resultMap.get('dependencies')!,
      allObjects: allObjectsResult,
      constraints: resultMap.get('constraints'),
    };
    const model = buildModelFromDmv(dmvResults);

    ok('Model has nodes', model.nodes.length > 0, `${model.nodes.length}`);
    ok('Model has edges', model.edges.length > 0, `${model.edges.length}`);
    ok('Model has schemas', model.schemas.length > 0, `${model.schemas.length}`);

    // Verify all non-virtual nodes belong to selected schemas
    // Virtual nodes (file/db external refs) have empty schema — exclude from this check
    const selectedLower = new Set(selectedSchemas.map(s => s.toLowerCase()));
    const primaryNodes = model.nodes.filter(n => n.externalType !== 'file' && n.externalType !== 'db');
    const nodesInSelected = primaryNodes.filter(n => selectedLower.has(n.schema.toLowerCase()));
    ok('All primary nodes from selected schemas', nodesInSelected.length === primaryNodes.length,
      `${nodesInSelected.length}/${primaryNodes.length} primary nodes in selected schemas` +
      (primaryNodes.length < model.nodes.length ? ` (${model.nodes.length - primaryNodes.length} virtual excluded)` : ''));

    console.log(`  Result: ${model.nodes.length} nodes, ${model.edges.length} edges, ${model.schemas.length} schemas`);

  } finally { await db.close(); }
}

// ─── Dep Coverage Bucket Validation ──────────────────────────────────────────

const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema', 'msdb', 'tempdb', 'model', 'master']);
const MODELED_TYPES  = new Set(['u', 'v', 'p', 'fn', 'if', 'tf', 'et']);
// XML/HierarchyID method calls appear as deps in sys.sql_expression_dependencies
// but are method invocations, not object references — exclude from coverage check
const DEP_METHOD_NAMES = new Set(['getancestor', 'getdescendant', 'getlevel', 'getreparentedvalue',
  'isdescendantof', 'parse', 'read', 'tostring', 'write', 'value', 'query', 'exist', 'modify', 'nodes']);

async function testDepCoverageBuckets() {
  console.log('\n── Dependency Coverage: every DMV dep must land in a bucket ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const { dmvResults, rawDepsAllSchemas, allObjectsResult } = await db.runAllPhases();
    const model = buildModelFromDmv(dmvResults);

    // Build catalog: all objects from Phase 1 (schema.name → type)
    const catalog = new Map<string, string>();
    for (const row of allObjectsResult.rows) {
      const schema = row[0].displayValue.toLowerCase();
      const name   = row[1].displayValue.toLowerCase();
      const type   = row[2].displayValue.toLowerCase().trim();
      catalog.set(`${schema}.${name}`, type);
    }

    // Build edge set from model
    const edgeSet = new Set<string>();
    for (const e of model.edges) {
      edgeSet.add(`${e.source.toLowerCase()}→${e.target.toLowerCase()}`);
      edgeSet.add(`${e.target.toLowerCase()}→${e.source.toLowerCase()}`);
    }

    // Build neighborIndex set (filtered cross-schema refs)
    const neighborSet = new Set<string>();
    if (model.neighborIndex) {
      for (const [key, val] of Object.entries(model.neighborIndex)) {
        neighborSet.add(key.toLowerCase());
      }
    }

    // Build unrelated set from spDetails
    const unrelatedSet = new Set<string>();
    if (model.stats?.spDetails) {
      for (const sp of model.stats.spDetails) {
        for (const u of sp.unrelated) {
          // Normalize: strip brackets, direction suffix, lowercase
          const cleaned = u.replace(/\[|\]/g, '').replace(/\s*\((?:read|write|exec)\)\s*$/i, '').toLowerCase();
          unrelatedSet.add(cleaned);
        }
      }
    }

    // Classify each raw DMV dep
    const depsColInfo = rawDepsAllSchemas.columnInfo;
    const refingSchemaIdx = depsColInfo.findIndex(c => c.columnName.toLowerCase() === 'referencing_schema');
    const refingNameIdx   = depsColInfo.findIndex(c => c.columnName.toLowerCase() === 'referencing_name');
    const refedSchemaIdx  = depsColInfo.findIndex(c => c.columnName.toLowerCase() === 'referenced_schema');
    const refedNameIdx    = depsColInfo.findIndex(c => c.columnName.toLowerCase() === 'referenced_name');

    ok('Dep result has expected columns', refingSchemaIdx >= 0 && refedSchemaIdx >= 0);

    let totalDeps = 0, edgeBucket = 0, neighborBucket = 0, unrelatedBucket = 0, excludedBucket = 0;
    const silentDrops: string[] = [];

    for (const row of rawDepsAllSchemas.rows) {
      const refingSchema = row[refingSchemaIdx].displayValue.toLowerCase();
      const refingName   = row[refingNameIdx].displayValue.toLowerCase();
      const refedSchema  = row[refedSchemaIdx].displayValue.toLowerCase();
      const refedName    = row[refedNameIdx].displayValue.toLowerCase();

      const refing = `${refingSchema}.${refingName}`;
      const refed  = `${refedSchema}.${refedName}`;

      // Skip: self-reference
      if (refing === refed) { excludedBucket++; continue; }
      // Skip: system schema target
      if (SYSTEM_SCHEMAS.has(refedSchema)) { excludedBucket++; continue; }
      // Skip: XML/HierarchyID method calls (not real object refs)
      if (DEP_METHOD_NAMES.has(refedName)) { excludedBucket++; continue; }
      // Skip: non-modeled target type
      const targetType = catalog.get(refed);
      if (targetType && !MODELED_TYPES.has(targetType)) { excludedBucket++; continue; }
      // Skip: referencing object is not modeled — either not in catalog at all (CHECK constraints,
      // triggers, defaults whose type isn't in allObjects) or known non-modeled type
      const sourceType = catalog.get(refing);
      if (!sourceType || !MODELED_TYPES.has(sourceType)) { excludedBucket++; continue; }

      totalDeps++;

      // Check: is it an edge in the model?
      const fwd = `[${refingSchema}].[${refingName}]→[${refedSchema}].[${refedName}]`;
      const rev = `[${refedSchema}].[${refedName}]→[${refingSchema}].[${refingName}]`;
      if (edgeSet.has(fwd) || edgeSet.has(rev)) { edgeBucket++; continue; }

      // Check: is it in neighborIndex (filtered cross-schema)?
      if (neighborSet.has(refed) || neighborSet.has(`[${refedSchema}].[${refedName}]`)) { neighborBucket++; continue; }

      // Check: is it in unrelated (not in catalog)?
      if (unrelatedSet.has(refed) || unrelatedSet.has(`${refedSchema}.${refedName}`)) { unrelatedBucket++; continue; }

      // Not found in any bucket — target not in catalog at all
      if (!targetType) { unrelatedBucket++; continue; }

      // Still not classified — silent drop
      silentDrops.push(`${refing} → ${refed} (targetType=${targetType})`);
    }

    console.log(`  Total modeled deps: ${totalDeps}  edge: ${edgeBucket}  neighbor: ${neighborBucket}  unrelated: ${unrelatedBucket}  excluded: ${excludedBucket}`);
    if (silentDrops.length > 0) {
      console.log(`  Silent drops:`);
      for (const d of silentDrops.slice(0, 10)) console.log(`    ${d}`);
      if (silentDrops.length > 10) console.log(`    ... and ${silentDrops.length - 10} more`);
    }
    ok('Zero silent drops (all deps classified)', silentDrops.length === 0,
      `${silentDrops.length} deps not in any bucket`);
    ok('Edge bucket non-empty', edgeBucket > 0, `${edgeBucket}`);
    ok('Total modeled deps > 0', totalDeps > 0, `${totalDeps}`);

  } finally { await db.close(); }
}

// ─── Cross-Schema Edge Correctness ──────────────────────────────────────────

async function testCrossSchemaEdges() {
  console.log('\n── Cross-Schema Edges: filtered vs full model ──');
  const dbName = process.env.DB_DATABASE_AW ?? 'AdventureWorks2025';

  // Full model (all schemas)
  const dbFull = await createDbAdapter(dbName);
  let fullModel;
  try {
    const { dmvResults } = await dbFull.runAllPhases();
    fullModel = buildModelFromDmv(dmvResults);
  } finally { await dbFull.close(); }

  // Filtered model (2 schemas)
  const selected = ['Production', 'Sales'];
  const dbFiltered = await createDbAdapter(dbName);
  let filteredModel;
  try {
    const { dmvResults } = await dbFiltered.runAllPhases(selected.join(','));
    filteredModel = buildModelFromDmv(dmvResults);
  } finally { await dbFiltered.close(); }

  ok('Full model has nodes', fullModel.nodes.length > 0);
  ok('Filtered model has nodes', filteredModel.nodes.length > 0);
  ok('Filtered model has fewer nodes', filteredModel.nodes.length <= fullModel.nodes.length,
    `filtered: ${filteredModel.nodes.length}, full: ${fullModel.nodes.length}`);

  // Build edge sets
  const edgeKey = (s: string, t: string) => `${s.toLowerCase()}→${t.toLowerCase()}`;
  const fullEdges = new Set(fullModel.edges.map(e => edgeKey(e.source, e.target)));
  const filteredEdges = new Set(filteredModel.edges.map(e => edgeKey(e.source, e.target)));

  // Every filtered edge must exist in full model
  const filteredOnly: string[] = [];
  for (const fe of filteredEdges) {
    if (!fullEdges.has(fe)) filteredOnly.push(fe);
  }
  ok('All filtered edges exist in full model', filteredOnly.length === 0,
    `${filteredOnly.length} edges in filtered but not full: ${filteredOnly.slice(0, 3).join(', ')}`);

  // Check: edges in full model touching selected schemas should be present in filtered model
  const selectedLower = new Set(selected.map(s => s.toLowerCase()));
  const filteredNodeSet = new Set(filteredModel.nodes.map(n => n.fullName.toLowerCase()));
  let missing = 0;
  const missingEdges: string[] = [];
  for (const e of fullModel.edges) {
    const srcNode = fullModel.nodes.find(n => n.fullName.toLowerCase() === e.source.toLowerCase());
    const tgtNode = fullModel.nodes.find(n => n.fullName.toLowerCase() === e.target.toLowerCase());
    if (!srcNode || !tgtNode) continue;

    const srcInSelected = selectedLower.has(srcNode.schema.toLowerCase());
    const tgtInSelected = selectedLower.has(tgtNode.schema.toLowerCase());

    // Only check edges where BOTH endpoints are in selected schemas
    if (srcInSelected && tgtInSelected) {
      const key = edgeKey(e.source, e.target);
      if (!filteredEdges.has(key)) {
        missing++;
        if (missingEdges.length < 5) missingEdges.push(key);
      }
    }
  }
  ok('No intra-selected-schema edges lost in filtered model', missing === 0,
    `${missing} missing: ${missingEdges.join(', ')}`);

  console.log(`  Full: ${fullModel.nodes.length} nodes, ${fullModel.edges.length} edges`);
  console.log(`  Filtered (${selected.join(',')}): ${filteredModel.nodes.length} nodes, ${filteredModel.edges.length} edges`);
}

// ─── Parser Performance (no DB required) ────────────────────────────────────

async function testParserPerformance() {
  console.log('\n── Parser Performance: adversarial SQL ──');
  const { parseSqlBody } = await import('../src/engine/sqlBodyParser.js');

  const cases: Array<{ name: string; sql: string }> = [
    {
      name: 'Deeply nested brackets (1000)',
      sql: 'SELECT ' + '[col]'.repeat(1000) + ' FROM [dbo].[T1]',
    },
    {
      name: 'Long string literal (10k chars)',
      sql: `SELECT x FROM [dbo].[T1] WHERE y = '${"a''b".repeat(2500)}' AND z = 1`,
    },
    {
      name: 'Massive FROM with 50 tables',
      sql: 'SELECT * FROM ' + Array.from({ length: 50 }, (_, i) => `[dbo].[Table${i}]`).join(' JOIN ') + ' ON 1=1',
    },
    {
      name: 'Nested block comments (100 deep)',
      sql: '/*'.repeat(100) + ' SELECT * FROM [dbo].[T1] ' + '*/'.repeat(100),
    },
    {
      name: 'Many line comments (500)',
      sql: Array.from({ length: 500 }, (_, i) => `-- comment ${i}`).join('\n') + '\nSELECT * FROM [dbo].[T1]',
    },
  ];

  for (const { name, sql } of cases) {
    const start = performance.now();
    try {
      parseSqlBody(sql);
      const elapsed = performance.now() - start;
      ok(`${name}: ${elapsed.toFixed(0)}ms`, elapsed < 5000, `took ${elapsed.toFixed(0)}ms (limit 5000ms)`);
    } catch (e) {
      const elapsed = performance.now() - start;
      ok(`${name}: crashed after ${elapsed.toFixed(0)}ms`, false, String(e).slice(0, 100));
    }
  }
}

// ─── Query Timeout Handling ─────────────────────────────────────────────────

async function testQueryTimeout() {
  console.log('\n── Query Timeout: error recovery ──');
  const dbName = process.env.DB_DATABASE_AW ?? 'AdventureWorks2025';

  // Create adapter with very short timeout
  // Dynamic import of CJS module wraps exports under .default in ESM/tsx context
  const mssqlMod = await import('mssql');
  const MssqlPool = (mssqlMod.default?.ConnectionPool ?? (mssqlMod as any).ConnectionPool) as typeof mssqlMod.ConnectionPool;
  const pool = new MssqlPool({
    server:   process.env.DB_SERVER ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '1433', 10),
    database: dbName,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      encrypt: process.env.DB_ENCRYPT !== 'false',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    },
    connectionTimeout: 15_000,
    requestTimeout:    1_000, // 1 second timeout
  });
  await pool.connect();

  try {
    // Execute slow query — should timeout
    let timedOut = false;
    try {
      await pool.request().query("WAITFOR DELAY '00:00:05'; SELECT 1 AS x");
    } catch (e) {
      timedOut = true;
      const msg = String(e);
      ok('Timeout error caught', msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('cancel'),
        msg.slice(0, 120));
    }
    ok('Slow query timed out as expected', timedOut);

    // Verify connection still usable after timeout
    const result = await pool.request().query('SELECT 1 AS alive');
    ok('Connection alive after timeout', result.recordset[0].alive === 1);
  } finally {
    await pool.close();
  }
}

// ─── Large-Table Sampling ───────────────────────────────────────────────────

async function testLargeTableSampling() {
  console.log('\n── Large-Table Sampling: TABLESAMPLE execution ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    // Find the largest table by row count
    const sizeResult = await db.query(`
      SELECT TOP 1 s.name AS schema_name, t.name AS table_name, p.rows
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
      ORDER BY p.rows DESC
    `);
    ok('Found largest table', sizeResult.rowCount > 0);

    const schema   = sizeResult.rows[0][0].displayValue;
    const table    = sizeResult.rows[0][1].displayValue;
    const rowCount = parseInt(sizeResult.rows[0][2].displayValue, 10);
    console.log(`  Largest table: [${schema}].[${table}] (${rowCount} rows)`);

    // Build column defs
    const colResult = await db.query(`
      SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_computed
      FROM sys.columns c
      JOIN sys.types t ON c.user_type_id = t.user_type_id
      WHERE c.object_id = OBJECT_ID('[${schema}].[${table}]')
      ORDER BY c.column_id
    `);
    const colDefs: ColumnDef[] = colResult.rows.map(r => ({
      name: r[0].displayValue,
      type: r[6].displayValue === '1' ? '(computed)' : r[1].displayValue,
      nullable: r[5].displayValue === '1' ? 'NULL' : 'NOT NULL',
      extra: r[6].displayValue === '1' ? 'COMPUTED' : '',
    }));

    // Force sampling with threshold=0
    const aggs = buildColumnAggregations(colDefs, true, 'quick');
    if (aggs.length === 0) {
      ok('No profilable columns (all skipped types)', true);
      return;
    }

    const sampleSql = buildProfilingQuery(schema, table, aggs, 2, rowCount, 0, 1000);
    ok('TABLESAMPLE in generated SQL', sampleSql.includes('TABLESAMPLE'));

    const sampleResult = await db.query(sampleSql);
    ok('Sampling query executed', sampleResult.rowCount === 1);

    // Parse and validate
    const sampleRow: Record<string, string> = {};
    for (let i = 0; i < sampleResult.columnInfo.length; i++) {
      sampleRow[sampleResult.columnInfo[i].columnName] = sampleResult.rows[0][i].displayValue;
    }
    const stats = parseProfilingResult(sampleRow, colDefs, rowCount, true);
    ok('Sampled flag set', stats.sampled === true);
    ok('Has profiled columns', stats.columns.filter(c => !c.skipped).length > 0);

    console.log(`  Profiled ${stats.columns.filter(c => !c.skipped).length} columns with TABLESAMPLE`);

  } finally { await db.close(); }
}

// ─── Cross-DB Reference Detection (Live DB) ─────────────────────────────────

async function testCrossDbRefs() {
  console.log('\n── Cross-DB Reference Detection (Live DB) ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const { dmvResults } = await db.runAllPhases();
    const currentDb = process.env.DB_DATABASE_AW ?? 'AdventureWorks2025';
    const model = buildModelFromDmv(dmvResults, currentDb);

    const crossDbNodes = model.nodes.filter(n => n.externalType === 'db');
    const fileNodes = model.nodes.filter(n => n.externalType === 'file');

    console.log(`  Cross-DB virtual nodes: ${crossDbNodes.length}`);
    console.log(`  File virtual nodes: ${fileNodes.length}`);

    // Soft check: if test SPs exist, validate cross-DB detection
    const hasArchiveSp = model.nodes.some(n =>
      n.name.toLowerCase().includes('loadfromarchive'));
    if (hasArchiveSp) {
      ok('Cross-DB virtual nodes created (ArchiveDB SP present)', crossDbNodes.length > 0,
        `found ${crossDbNodes.length} cross-DB nodes`);
      ok('Cross-DB node has externalDatabase', crossDbNodes.some(n => n.externalDatabase !== undefined));
    } else {
      console.log('  (skipped cross-DB assertion: usp_LoadFromArchive not found in DB)');
    }

    const hasOpenrowsetSp = model.nodes.some(n =>
      n.name.toLowerCase().includes('openrowsettestproc'));
    if (hasOpenrowsetSp) {
      ok('File virtual nodes created (OPENROWSET SP present)', fileNodes.length > 0,
        `found ${fileNodes.length} file nodes`);
    } else {
      console.log('  (skipped file node assertion: usp_OpenrowsetTestProc not found in DB)');
    }

    // All virtual nodes must be in catalog
    for (const n of [...crossDbNodes, ...fileNodes]) {
      ok(`Virtual node ${n.id.slice(0, 30)} in catalog`, model.catalog[n.id] !== undefined);
    }
  } finally { await db.close(); }
}

// ─── Virtual Node Catalog Validation ─────────────────────────────────────────

async function testVirtualNodeCatalog() {
  console.log('\n── Virtual Node Catalog Validation ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const { dmvResults } = await db.runAllPhases();
    const currentDb = process.env.DB_DATABASE_AW ?? 'AdventureWorks2025';
    const model = buildModelFromDmv(dmvResults, currentDb);

    const etNodes = model.nodes.filter(n => n.externalType === 'et');
    const fileNodes = model.nodes.filter(n => n.externalType === 'file');
    const dbNodes = model.nodes.filter(n => n.externalType === 'db');

    console.log(`  ET nodes: ${etNodes.length}, File nodes: ${fileNodes.length}, DB nodes: ${dbNodes.length}`);

    // All ET nodes must have externalType='et' and be in catalog
    for (const n of etNodes) {
      ok(`ET ${n.name} externalType=et`, n.externalType === 'et');
      ok(`ET ${n.name} in catalog`, model.catalog[n.id] !== undefined);
      ok(`ET ${n.name} catalog type=external`, model.catalog[n.id]?.type === 'external');
    }

    // All file virtual nodes must have externalUrl set
    for (const n of fileNodes) {
      ok(`File ${n.name} has externalUrl`, n.externalUrl !== undefined && n.externalUrl.length > 0);
    }

    // All DB virtual nodes must have externalDatabase set
    for (const n of dbNodes) {
      ok(`DB ${n.name} has externalDatabase`, n.externalDatabase !== undefined && n.externalDatabase.length > 0);
    }

    // Total node count should not exceed maxNodes cap
    ok(`Total nodes <= maxNodes`, model.nodes.length <= 750, `${model.nodes.length}`);
  } finally { await db.close(); }
}

// ─── Full Pipeline: DB → graph → all analysis types ──────────────────────────

async function testFullPipeline() {
  console.log('\n── Full Pipeline: DB → graph → analysis ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    const { dmvResults } = await db.runAllPhases();
    const model = buildModelFromDmv(dmvResults);

    // ── Graph build ───────────────────────────────────────────────────────────
    const { flowNodes, flowEdges, graph } = buildGraph(model, DEFAULT_CONFIG);
    ok('graph node count matches model', graph.order === model.nodes.length,
      `graph=${graph.order} model=${model.nodes.length}`);
    ok('graph has directed edges', graph.size > 0, `${graph.size}`);
    ok('flowNodes count matches model', flowNodes.length === model.nodes.length,
      `flowNodes=${flowNodes.length}`);
    ok('flowEdges present', flowEdges.length > 0, `${flowEdges.length}`);

    // ── Analysis: orphans ─────────────────────────────────────────────────────
    const cfg = DEFAULT_CONFIG.analysis;
    const maxN = DEFAULT_CONFIG.maxNodes;

    const orphans = runAnalysis(graph, 'orphans', cfg, maxN);
    ok('orphans analysis returns groups', Array.isArray(orphans.groups));
    ok('orphan groups are non-empty', orphans.groups.every(g => g.nodeIds.length > 0));

    // ── Analysis: hubs ────────────────────────────────────────────────────────
    const hubs = runAnalysis(graph, 'hubs', cfg, maxN);
    ok('hubs analysis returns groups', Array.isArray(hubs.groups));
    ok('hubs have degree metadata', hubs.groups.every(g => typeof g.meta?.degree === 'number'));

    // ── Analysis: islands ─────────────────────────────────────────────────────
    const islands = runAnalysis(graph, 'islands', cfg, maxN);
    ok('islands analysis returns groups', Array.isArray(islands.groups));
    ok('islands include main connected component', islands.groups.some(g => g.nodeIds.length > 50));

    // ── Analysis: longest-path ────────────────────────────────────────────────
    const lp = runAnalysis(graph, 'longest-path', cfg, maxN);
    ok('longest-path returns groups', Array.isArray(lp.groups));
    ok('longest-path chains have depth metadata',
      lp.groups.length === 0 || typeof lp.groups[0].meta?.depth === 'number');

    // ── Analysis: cycles ──────────────────────────────────────────────────────
    const cycles = runAnalysis(graph, 'cycles', cfg, maxN);
    ok('cycles analysis returns groups', Array.isArray(cycles.groups));

    console.log(`  Graph: ${flowNodes.length} nodes, ${flowEdges.length} flow-edges, ${graph.size} directed edges`);
    console.log(`  Analysis: orphan=${orphans.groups.length} hub=${hubs.groups.length} island=${islands.groups.length} lp=${lp.groups.length} cycle=${cycles.groups.length}`);
  } finally { await db.close(); }
}

// ─── Schema Subset Pipeline: select one schema → graph → cross-schema edges ───

async function testSchemaSubsetPipeline() {
  console.log('\n── Schema Subset Pipeline: HumanResources only ──');
  const db = await createDbAdapter(process.env.DB_DATABASE_AW ?? 'AdventureWorks2025');
  try {
    // Phase 1 (all-objects) is unfiltered — full catalog for cross-schema resolution.
    // Phase 2 (nodes/columns/deps) is filtered to HumanResources only.
    const { dmvResults } = await db.runAllPhases('HumanResources');
    const model = buildModelFromDmv(dmvResults);

    const hrNodes = model.nodes.filter(n => n.schema === 'HumanResources');
    ok('HumanResources nodes present', hrNodes.length > 0, `${hrNodes.length}`);

    // Neighbor nodes from other schemas appear when HR objects reference them
    const crossSchemaNodes = model.nodes.filter(n => n.schema !== 'HumanResources');
    console.log(`  Cross-schema neighbor nodes: ${crossSchemaNodes.length}` +
      ` (${[...new Set(crossSchemaNodes.map(n => n.schema))].join(', ')})`);
    ok('Cross-schema neighbor nodes resolved from catalog', crossSchemaNodes.length > 0,
      `${crossSchemaNodes.length} nodes from other schemas`);

    // At least one edge crosses the schema boundary
    const hrIds = new Set(hrNodes.map(n => n.id));
    const crossEdges = model.edges.filter(e => !hrIds.has(e.source) || !hrIds.has(e.target));
    ok('Cross-schema edges present in model', crossEdges.length > 0,
      `${crossEdges.length} edges cross schema boundary`);

    // ── Build graph on subset model ───────────────────────────────────────────
    const { flowNodes, flowEdges, graph } = buildGraph(model, DEFAULT_CONFIG);
    ok('Graph builds from subset model', graph.order === model.nodes.length,
      `${graph.order} nodes`);
    ok('Subset has fewer nodes than full graph', flowNodes.length < 112,
      `subset=${flowNodes.length}`);
    ok('Subset graph has edges', flowEdges.length > 0, `${flowEdges.length}`);

    // ── Analysis on subset graph ──────────────────────────────────────────────
    const orphans = runAnalysis(graph, 'orphans', DEFAULT_CONFIG.analysis, DEFAULT_CONFIG.maxNodes);
    ok('Orphans analysis runs on subset', Array.isArray(orphans.groups));

    const hubs = runAnalysis(graph, 'hubs', DEFAULT_CONFIG.analysis, DEFAULT_CONFIG.maxNodes);
    ok('Hubs analysis runs on subset', Array.isArray(hubs.groups));

    console.log(`  Subset: ${hrNodes.length} HR nodes + ${crossSchemaNodes.length} neighbor nodes,` +
      ` ${flowEdges.length} flow-edges, ${crossEdges.length} cross-schema edges`);
  } finally { await db.close(); }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  console.log('Integration DB Tests\n');
  try {
    await testAWDacpac();           // dacpac-only, no live DB needed
    await testParserPerformance();  // no DB needed

    if (!process.env.DB_SERVER) {
      console.log('\nDB_SERVER not set — skipping live DB tests');
    } else {
      await testAW();
      await testSchemaPreviewET();
      await testDW();
      await testParityDacpacVsDb();
      await testConstraintParity();
      await testProfiling();
      await testCteWrapping();
      await testPerQueryExecution();
      await testWizardFlow();
      await testDepCoverageBuckets();
      await testCrossSchemaEdges();
      await testQueryTimeout();
      await testLargeTableSampling();
      await testCrossDbRefs();
      await testVirtualNodeCatalog();
      await testFullPipeline();
      await testSchemaSubsetPipeline();
    }
  } catch (e) { console.error('FATAL:', e); fail++; }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
