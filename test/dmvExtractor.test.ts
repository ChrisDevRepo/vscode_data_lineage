/**
 * DMV Extractor test — uses synthetic DMV data to verify model building.
 * Execute with: npx tsx test/dmvExtractor.test.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { buildModelFromDmv, validateQueryResult } from '../src/engine/dmvExtractor';
import { formatColumnType } from '../src/engine/types';
import type { DmvResults } from '../src/engine/dmvExtractor';
import type { SimpleExecuteResult, DbCellValue, IDbColumn } from '../src/types/mssql';
import { loadRules } from '../src/engine/sqlBodyParser';
import type { ParseRulesConfig } from '../src/engine/sqlBodyParser';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load built-in rules from single source of truth (assets/defaultParseRules.yaml)
const rulesYaml = readFileSync(resolve(__dirname, '../assets/defaultParseRules.yaml'), 'utf-8');
loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

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

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

// ─── Test Data Helpers ──────────────────────────────────────────────────────

function cell(value: string): DbCellValue {
  return { displayValue: value, isNull: false };
}
function nullCell(): DbCellValue {
  return { displayValue: '', isNull: true };
}
function cols(...names: string[]): IDbColumn[] {
  return names.map(n => ({ columnName: n, dataType: 'string', dataTypeName: 'varchar' }));
}
function makeResult(columns: IDbColumn[], rows: DbCellValue[][]): SimpleExecuteResult {
  return { rowCount: rows.length, columnInfo: columns, rows };
}

// ─── Synthetic DMV Data ─────────────────────────────────────────────────────

function buildSyntheticResults(): DmvResults {
  // 3 tables, 1 view, 2 procedures
  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
    [cell('dbo'), cell('Orders'), cell('U '), nullCell()],
    [cell('dbo'), cell('Products'), cell('U '), nullCell()],
    [cell('dbo'), cell('vActiveCustomers'), cell('V '), cell('CREATE VIEW [dbo].[vActiveCustomers] AS\nSELECT * FROM [dbo].[Customers] WHERE Active = 1')],
    [cell('sales'), cell('uspGetOrdersByCustomer'), cell('P '), cell('CREATE PROCEDURE [sales].[uspGetOrdersByCustomer]\nAS\nSELECT o.* FROM [dbo].[Orders] o\nINNER JOIN [dbo].[Customers] c ON o.CustomerId = c.Id')],
    [cell('sales'), cell('uspCreateOrder'), cell('P '), cell('CREATE PROCEDURE [sales].[uspCreateOrder]\nAS\nINSERT INTO [dbo].[Orders] (CustomerId, ProductId)\nSELECT c.Id, p.Id FROM [dbo].[Customers] c\nCROSS JOIN [dbo].[Products] p')],
  ];

  // Column metadata for tables
  const columnsCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');
  const columnsRows: DbCellValue[][] = [
    [cell('dbo'), cell('Customers'), cell('1'), cell('Id'), cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('1'), cell('0')],
    [cell('dbo'), cell('Customers'), cell('2'), cell('Name'), cell('nvarchar'), cell('200'), cell('0'), cell('0'), cell('1'), cell('0'), cell('0')],
    [cell('dbo'), cell('Customers'), cell('3'), cell('Active'), cell('bit'), cell('1'), cell('1'), cell('0'), cell('0'), cell('0'), cell('0')],
    [cell('dbo'), cell('Orders'), cell('1'), cell('OrderId'), cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('1'), cell('0')],
    [cell('dbo'), cell('Orders'), cell('2'), cell('CustomerId'), cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('0'), cell('0')],
    [cell('dbo'), cell('Orders'), cell('3'), cell('ProductId'), cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('0'), cell('0')],
    [cell('dbo'), cell('Products'), cell('1'), cell('Id'), cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('1'), cell('0')],
    [cell('dbo'), cell('Products'), cell('2'), cell('Name'), cell('nvarchar'), cell('510'), cell('0'), cell('0'), cell('0'), cell('0'), cell('0')],
  ];

  // Dependencies (DMV-level — these supplement regex parsing for SPs)
  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    // View depends on Customers
    [cell('dbo'), cell('vActiveCustomers'), cell('dbo'), cell('Customers')],
    // SP depends on Orders, Customers
    [cell('sales'), cell('uspGetOrdersByCustomer'), cell('dbo'), cell('Orders')],
    [cell('sales'), cell('uspGetOrdersByCustomer'), cell('dbo'), cell('Customers')],
    // SP depends on Orders, Customers, Products
    [cell('sales'), cell('uspCreateOrder'), cell('dbo'), cell('Orders')],
    [cell('sales'), cell('uspCreateOrder'), cell('dbo'), cell('Customers')],
    [cell('sales'), cell('uspCreateOrder'), cell('dbo'), cell('Products')],
  ];

  return {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(columnsCols, columnsRows),
    dependencies: makeResult(depsCols, depsRows),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

function testBuildModelFromDmv() {
  console.log('\n── DMV Extractor: buildModelFromDmv ──');
  const results = buildSyntheticResults();
  const model = buildModelFromDmv(results);

  // Node counts
  assertEq(model.nodes.length, 6, 'Should have 6 nodes');
  const tables = model.nodes.filter(n => n.type === 'table');
  const views = model.nodes.filter(n => n.type === 'view');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  assertEq(tables.length, 3, 'Should have 3 tables');
  assertEq(views.length, 1, 'Should have 1 view');
  assertEq(procs.length, 2, 'Should have 2 procedures');

  // Schema computation
  assertEq(model.schemas.length, 2, 'Should have 2 schemas');
  const dboSchema = model.schemas.find(s => s.name === 'DBO');
  const salesSchema = model.schemas.find(s => s.name === 'SALES');
  assert(dboSchema !== undefined, 'DBO schema found');
  assert(salesSchema !== undefined, 'SALES schema found');
  assertEq(dboSchema!.nodeCount, 4, 'DBO has 4 nodes');
  assertEq(salesSchema!.nodeCount, 2, 'SALES has 2 nodes');

  // Node IDs are normalized
  const customerNode = model.nodes.find(n => n.name === 'Customers');
  assertEq(customerNode?.id, '[dbo].[customers]', 'Customer ID normalized to lowercase');
  assertEq(customerNode?.schema, 'DBO', 'Customer schema uppercased');

  // Edges
  assert(model.edges.length > 0, `Has ${model.edges.length} edges`);

  // View edge (from DMV deps — not regex parsed): Customers → vActiveCustomers
  const viewEdge = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[dbo].[vactivecustomers]'
  );
  assert(viewEdge !== undefined, 'View has inbound edge from Customers');

  // SP edges (regex-parsed): uspGetOrdersByCustomer reads Orders and Customers
  const spReadOrders = model.edges.find(e =>
    e.source === '[dbo].[orders]' && e.target === '[sales].[uspgetordersbycustomer]'
  );
  assert(spReadOrders !== undefined, 'SP uspGetOrdersByCustomer reads Orders');

  const spReadCustomers = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[sales].[uspgetordersbycustomer]'
  );
  assert(spReadCustomers !== undefined, 'SP uspGetOrdersByCustomer reads Customers');

  // SP edges (regex-parsed): uspCreateOrder writes to Orders, reads Customers + Products
  const spWriteOrders = model.edges.find(e =>
    e.source === '[sales].[uspcreateorder]' && e.target === '[dbo].[orders]'
  );
  assert(spWriteOrders !== undefined, 'SP uspCreateOrder writes to Orders');

  const spReadCustomers2 = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[sales].[uspcreateorder]'
  );
  assert(spReadCustomers2 !== undefined, 'SP uspCreateOrder reads Customers');

  const spReadProducts = model.edges.find(e =>
    e.source === '[dbo].[products]' && e.target === '[sales].[uspcreateorder]'
  );
  assert(spReadProducts !== undefined, 'SP uspCreateOrder reads Products');

  // Parse stats
  assert(model.parseStats !== undefined, 'Parse stats present');
  assertEq(model.parseStats!.spDetails.length, 2, '2 SPs in parse details');

  // Table body scripts (design view from columns)
  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  assert(ordersNode?.bodyScript?.includes('OrderId'), 'Orders table has column design view');
  assert(ordersNode?.bodyScript?.includes('int'), 'Orders table design shows int type');

  // No warnings for valid data
  assert(model.warnings === undefined, 'No warnings for valid data');
}

function testEmptyDatabase() {
  console.log('\n── DMV Extractor: Empty Database ──');
  const results: DmvResults = {
    nodes: makeResult(cols('schema_name', 'object_name', 'type_code', 'body_script'), []),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []),
  };

  const model = buildModelFromDmv(results);
  assertEq(model.nodes.length, 0, 'Empty DB has 0 nodes');
  assertEq(model.edges.length, 0, 'Empty DB has 0 edges');
  assert(model.warnings !== undefined && model.warnings.length > 0, 'Empty DB produces warning');
}

function testValidateQueryResult() {
  console.log('\n── DMV Extractor: Column Validation ──');

  // Valid result
  const validResult = makeResult(
    cols('schema_name', 'object_name', 'type_code', 'body_script'),
    []
  );
  const validMissing = validateQueryResult('nodes', validResult);
  assertEq(validMissing.length, 0, 'Valid nodes result has no missing columns');

  // Missing columns
  const invalidResult = makeResult(
    cols('schema_name', 'object_name'),
    []
  );
  const invalidMissing = validateQueryResult('nodes', invalidResult);
  assertEq(invalidMissing.length, 2, 'Invalid nodes result missing 2 columns');
  assert(invalidMissing.includes('type_code'), 'Missing type_code detected');
  assert(invalidMissing.includes('body_script'), 'Missing body_script detected');

  // Case insensitive
  const mixedCase = makeResult(
    cols('Schema_Name', 'Object_Name', 'Type_Code', 'Body_Script'),
    []
  );
  const mixedMissing = validateQueryResult('nodes', mixedCase);
  assertEq(mixedMissing.length, 0, 'Column validation is case-insensitive');

  // Dependencies
  const depResult = makeResult(
    cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'),
    []
  );
  const depMissing = validateQueryResult('dependencies', depResult);
  assertEq(depMissing.length, 0, 'Valid dependencies result has no missing columns');

  // Unknown query name
  const unknownMissing = validateQueryResult('unknown', validResult);
  assertEq(unknownMissing.length, 0, 'Unknown query name returns no missing columns');
}

function testFormatColumnType() {
  console.log('\n── DMV Extractor: formatColumnType ──');

  // Simple types (no size params)
  assertEq(formatColumnType('int', '4', '10', '0'), 'int', 'int has no size');
  assertEq(formatColumnType('bigint', '8', '19', '0'), 'bigint', 'bigint has no size');
  assertEq(formatColumnType('bit', '1', '1', '0'), 'bit', 'bit has no size');
  assertEq(formatColumnType('uniqueidentifier', '16', '0', '0'), 'uniqueidentifier', 'uniqueidentifier has no size');

  // String types with max_length
  assertEq(formatColumnType('varchar', '50', '0', '0'), 'varchar(50)', 'varchar(50)');
  assertEq(formatColumnType('varchar', '-1', '0', '0'), 'varchar(max)', 'varchar(max)');
  assertEq(formatColumnType('nvarchar', '200', '0', '0'), 'nvarchar(100)', 'nvarchar(200 bytes) = nvarchar(100 chars)');
  assertEq(formatColumnType('nvarchar', '-1', '0', '0'), 'nvarchar(max)', 'nvarchar(max)');
  assertEq(formatColumnType('char', '10', '0', '0'), 'char(10)', 'char(10)');
  assertEq(formatColumnType('nchar', '20', '0', '0'), 'nchar(10)', 'nchar(20 bytes) = nchar(10 chars)');

  // Binary types
  assertEq(formatColumnType('varbinary', '-1', '0', '0'), 'varbinary(max)', 'varbinary(max)');
  assertEq(formatColumnType('varbinary', '100', '0', '0'), 'varbinary(100)', 'varbinary(100)');

  // Decimal/numeric
  assertEq(formatColumnType('decimal', '9', '18', '2'), 'decimal(18,2)', 'decimal(18,2)');
  assertEq(formatColumnType('numeric', '9', '10', '0'), 'numeric(10,0)', 'numeric(10,0)');

  // Date types (no size)
  assertEq(formatColumnType('datetime', '8', '23', '3'), 'datetime', 'datetime has no size');
  assertEq(formatColumnType('date', '3', '10', '0'), 'date', 'date has no size');
}

function testDuplicateNodes() {
  console.log('\n── DMV Extractor: Duplicate Node Handling ──');
  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
    [cell('dbo'), cell('Customers'), cell('U '), nullCell()], // duplicate
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []),
  };

  const model = buildModelFromDmv(results);
  assertEq(model.nodes.length, 1, 'Duplicate nodes are deduplicated');
}

function testSelfReferenceExcluded() {
  console.log('\n── DMV Extractor: Self-Reference Exclusion ──');
  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('MyTable'), cell('U '), nullCell()],
  ];
  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('dbo'), cell('MyTable'), cell('dbo'), cell('MyTable')], // self-reference
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);
  assertEq(model.edges.length, 0, 'Self-references produce no edges');
}

// ─── Run ────────────────────────────────────────────────────────────────────

testBuildModelFromDmv();
testEmptyDatabase();
testValidateQueryResult();
testFormatColumnType();
testDuplicateNodes();
testSelfReferenceExcluded();

console.log(`\n═══ DMV Extractor: ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
