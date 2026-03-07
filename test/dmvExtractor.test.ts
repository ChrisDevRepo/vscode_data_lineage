/**
 * DMV Extractor test — uses synthetic DMV data to verify model building.
 * Execute with: npx tsx test/dmvExtractor.test.ts
 */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { buildModelFromDmv, validateQueryResult } from '../src/engine/dmvExtractor';
import { formatColumnType } from '../src/engine/types';
import type { DmvResults } from '../src/engine/dmvExtractor';
import type { SimpleExecuteResult, DbCellValue, IDbColumn } from '../src/types/mssql';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../src/utils/sql';
import { assert, assertEq, loadParseRules, rootPath, printSummary } from './testUtils';

loadParseRules();

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
  const dboSchema = model.schemas.find(s => s.name === 'dbo');
  const salesSchema = model.schemas.find(s => s.name === 'sales');
  assert(dboSchema !== undefined, 'dbo schema found');
  assert(salesSchema !== undefined, 'sales schema found');
  assertEq(dboSchema!.nodeCount, 4, 'dbo has 4 nodes');
  assertEq(salesSchema!.nodeCount, 2, 'sales has 2 nodes');

  // Node IDs are normalized
  const customerNode = model.nodes.find(n => n.name === 'Customers');
  assertEq(customerNode?.id, '[dbo].[customers]', 'Customer ID normalized to lowercase');
  assertEq(customerNode?.schema, 'dbo', 'Customer schema preserved in catalog-original casing');

  // Catalog and neighborIndex are present and populated
  assert(model.catalog !== undefined, 'Catalog present');
  assert(Object.keys(model.catalog).length >= model.nodes.length, 'Catalog has at least one entry per node');
  assert(model.neighborIndex !== undefined, 'NeighborIndex present');

  // neighborIndex: vActiveCustomers should have Customers as inbound neighbor
  const viewId = '[dbo].[vactivecustomers]';
  assert(model.neighborIndex[viewId]?.in.includes('[dbo].[customers]'), 'neighborIndex: Customers → vActiveCustomers');
  // catalog: Customers entry should have original casing
  assert(model.catalog['[dbo].[customers]']?.schema === 'dbo', 'catalog: Customers schema is dbo');

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

  // Table columns available on node
  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  assert(ordersNode?.columns?.some(c => c.name === 'OrderId'), 'Orders table has OrderId column');
  assert(ordersNode?.columns?.some(c => c.type.includes('int')), 'Orders table has int type column');

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

function testFallbackBodyDirection() {
  console.log('\n── DMV Extractor: Fallback Body Direction ──');

  // SP body uses unqualified table refs (no schema prefix) — regex skips them (normalizeCaptured rejects).
  // MS metadata (DMV deps) knows about both tables with schema. inferBodyDirection() should
  // correctly classify writes vs reads based on the keyword preceding the table name.
  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('WriteTarget'), cell('U '), nullCell()],
    [cell('dbo'), cell('ReadSource'),  cell('U '), nullCell()],
    [cell('dbo'), cell('TestFallbackSP'), cell('P '),
      cell('CREATE PROCEDURE dbo.TestFallbackSP AS UPDATE WriteTarget SET x = 1; SELECT * FROM ReadSource')],
  ];

  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('dbo'), cell('TestFallbackSP'), cell('dbo'), cell('WriteTarget')],
    [cell('dbo'), cell('TestFallbackSP'), cell('dbo'), cell('ReadSource')],
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);

  const writeEdge = model.edges.find(e =>
    e.source === '[dbo].[testfallbacksp]' && e.target === '[dbo].[writetarget]'
  );
  assert(writeEdge !== undefined, 'Fallback: unqualified UPDATE → WRITE edge (SP → table)');

  const readEdge = model.edges.find(e =>
    e.source === '[dbo].[readsource]' && e.target === '[dbo].[testfallbacksp]'
  );
  assert(readEdge !== undefined, 'Fallback: unqualified FROM → READ edge (table → SP)');
}

// ─── Test: Cross-schema EXEC appears in Out with ⊘ when dbo is excluded ─────

function testCrossSchemaNeighborIndex() {
  console.log('\n── DMV: Cross-Schema Out (EXEC [dbo].[uspLogError] from HumanResources SP) ──');

  // Scenario: user selected HumanResources only — dbo is excluded from the schema filter.
  // Phase 1 allObjects contains the full catalog including dbo objects.
  // SP uspUpdateEmployeePersonalInfo:
  //   UPDATE [HumanResources].[Employee]  → intra-schema write edge
  //   EXECUTE [dbo].[uspLogError]         → cross-schema exec → Out with ⊘

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const SP_BODY = [
    'CREATE PROCEDURE [HumanResources].[uspUpdateEmployeePersonalInfo]',
    '    @BusinessEntityID [int], @NationalIDNumber [nvarchar](15)',
    'WITH EXECUTE AS CALLER AS BEGIN',
    '    BEGIN TRY',
    '        UPDATE [HumanResources].[Employee]',
    '        SET [NationalIDNumber] = @NationalIDNumber',
    '        WHERE [BusinessEntityID] = @BusinessEntityID;',
    '    END TRY',
    '    BEGIN CATCH',
    '        EXECUTE [dbo].[uspLogError];',
    '    END CATCH;',
    'END;',
  ].join('\n');

  const nodesRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('Employee'), cell('U '), nullCell()],
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P '), cell(SP_BODY)],
  ];

  // Phase 2 deps — referencing_schema = HumanResources so both rows pass the schema filter
  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('HumanResources'), cell('Employee')],
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('dbo'), cell('uspLogError')],
  ];

  // Phase 1 allObjects — full catalog incl. dbo (dbo was not selected, but Phase 1 sees everything)
  const allObjCols = cols('schema_name', 'object_name', 'type_code');
  const allObjRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('Employee'), cell('U ')],
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P ')],
    [cell('dbo'), cell('uspLogError'), cell('P ')],
    [cell('dbo'), cell('ErrorLog'), cell('U ')],
  ];

  const emptyCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(emptyCols, []),
    dependencies: makeResult(depsCols, depsRows),
    allObjects: makeResult(allObjCols, allObjRows),
  };

  const model = buildModelFromDmv(results);

  const spId = '[humanresources].[uspupdateemployeepersonalinfo]';
  const empId = '[humanresources].[employee]';
  const logErrId = '[dbo].[usplogerror]';

  // Only HumanResources nodes rendered
  assertEq(model.nodes.length, 2, 'Only HumanResources nodes rendered (dbo excluded)');
  assert(!model.nodes.some(n => n.schema === 'dbo'), 'No dbo node in graph');

  // No graph edge to dbo — it is outside the filter
  assert(!model.edges.some(e => e.source === logErrId || e.target === logErrId),
    'No graph edge to [dbo].[uspLogError]');

  // Intra-schema write edge must exist
  assert(model.edges.some(e => e.source === spId && e.target === empId),
    'Intra-schema write edge SP → Employee exists');

  // Key: cross-schema exec must appear in neighborIndex.out with ⊘
  const spN = model.neighborIndex[spId];
  assert(spN !== undefined, 'neighborIndex entry exists for SP');
  assert(spN?.out.includes(logErrId),
    `SP.out includes [dbo].[uspLogError] (got: ${JSON.stringify(spN?.out)})`);

  // Reverse: dbo.uspLogError.in points back to SP
  const logErrN = model.neighborIndex[logErrId];
  assert(logErrN !== undefined, 'neighborIndex entry exists for [dbo].[uspLogError]');
  assert(logErrN?.in.includes(spId),
    `[dbo].[uspLogError].in includes SP (got: ${JSON.stringify(logErrN?.in)})`);

  // catalog must contain dbo objects for display name resolution
  const logErrC = model.catalog[logErrId];
  assert(logErrC !== undefined, 'catalog contains [dbo].[uspLogError]');
  assertEq(logErrC?.schema, 'dbo', 'catalog[dbo.uspLogError].schema');
  assertEq(logErrC?.name, 'uspLogError', 'catalog[dbo.uspLogError].name');
  assertEq(logErrC?.type, 'procedure', 'catalog[dbo.uspLogError].type');
}

// ─── Test: Cross-schema dep in Unresolved when allObjects absent ─────────────

function testCrossSchemaUnresolvedWhenNoAllObjects() {
  console.log('\n── DMV: Cross-schema dep → Unresolved when allObjects absent ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P '),
      cell('CREATE PROCEDURE [HumanResources].[uspUpdateEmployeePersonalInfo] AS BEGIN EXECUTE [dbo].[uspLogError]; END')],
  ];

  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('dbo'), cell('uspLogError')],
  ];

  // allObjects intentionally absent — simulates Phase 1 not having all-objects query
  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);
  const spId = '[humanresources].[uspupdateemployeepersonalinfo]';

  // Metadata dep must surface in Unresolved — never silently dropped
  const detail = model.parseStats?.spDetails.find(d => d.name.toLowerCase() === 'humanresources.uspupdateemployeepersonalinfo');
  assert(detail !== undefined, 'spDetails entry found for SP');
  const hasUnresolved = detail?.unrelated.some(r => r.toLowerCase().includes('usplogerror'));
  assert(hasUnresolved === true,
    `spDetails.unrelated contains uspLogError (got: ${JSON.stringify(detail?.unrelated)})`);

  // No neighborIndex entry for dbo.uspLogError (cannot create one without catalog)
  const logErrId = '[dbo].[usplogerror]';
  assert(model.neighborIndex[logErrId] === undefined,
    'No neighborIndex entry for unknown dbo.uspLogError when allObjects absent');
}

// ─── Test: External Table (ET) nodes ─────────────────────────────────────────

function testExternalTableNodes() {
  console.log('\n── DMV Extractor: External Table (ET) Nodes ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    // Regular table
    [cell('dbo'), cell('LocalOrders'), cell('U '), nullCell()],
    // External table — type_code 'ET' (char(2) padded)
    [cell('ext'), cell('ExternalSales'), cell('ET'), nullCell()],
    // SP that reads from external table
    [cell('dbo'), cell('uspLoadSales'), cell('P '),
      cell('CREATE PROCEDURE [dbo].[uspLoadSales] AS\nINSERT INTO [dbo].[LocalOrders]\nSELECT * FROM [ext].[ExternalSales]')],
  ];

  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('dbo'), cell('uspLoadSales'), cell('dbo'), cell('LocalOrders')],
    [cell('dbo'), cell('uspLoadSales'), cell('ext'), cell('ExternalSales')],
  ];

  const emptyCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(emptyCols, []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);

  // Node count and types
  assertEq(model.nodes.length, 3, 'Should have 3 nodes (1 table, 1 external, 1 SP)');
  const extNodes = model.nodes.filter(n => n.type === 'external');
  assertEq(extNodes.length, 1, 'Should have 1 external node');

  // External node properties
  const extNode = extNodes[0];
  assert(extNode !== undefined, 'External node exists');
  assertEq(extNode?.schema, 'ext', 'External node has correct schema');
  assertEq(extNode?.name, 'ExternalSales', 'External node has correct name (original casing)');
  assertEq(extNode?.id, '[ext].[externalsales]', 'External node ID is lowercase-normalized');
  assertEq(extNode?.externalType, 'et', 'External node has externalType=et');
  assert(extNode?.bodyScript === undefined || extNode?.bodyScript === null,
    'External node has no bodyScript (ET has no SQL body)');

  // Schema info includes external type count
  const extSchema = model.schemas.find(s => s.name === 'ext');
  assert(extSchema !== undefined, 'ext schema present in schemas');
  assertEq(extSchema?.types?.external ?? 0, 1, 'ext schema counts 1 external node');

  // External node in catalog
  const extId = '[ext].[externalsales]';
  const catEntry = model.catalog[extId];
  assert(catEntry !== undefined, 'External node in catalog');
  assertEq(catEntry?.type, 'external', 'catalog entry type=external');

  // Edge: SP reads from external table (FROM clause → external is source/upstream)
  const readEdge = model.edges.find(e =>
    e.source === extId && e.target === '[dbo].[uspLoadsales]'.toLowerCase()
  );
  assert(readEdge !== undefined,
    `Read edge external → SP exists (edges: ${model.edges.map(e => `${e.source}→${e.target}`).join(', ')})`);

  // Edge: SP writes to local table
  const writeEdge = model.edges.find(e =>
    e.source === '[dbo].[uspLoadsales]'.toLowerCase() && e.target === '[dbo].[localorders]'
  );
  assert(writeEdge !== undefined, 'Write edge SP → LocalOrders exists');

  // NeighborIndex: external table has SP in its out neighbors
  const spId = '[dbo].[uspLoadsales]'.toLowerCase();
  const extNeighbors = model.neighborIndex[extId];
  assert(extNeighbors !== undefined, 'neighborIndex entry for external node');
  assert(extNeighbors?.out.includes(spId),
    `External node out-neighbors include SP (got: ${JSON.stringify(extNeighbors?.out)})`);
}

function testExternalTableWriteDirection() {
  console.log('\n── DMV Extractor: External Table Write Direction (CETAS) ──');

  // CETAS pattern: SP writes INTO external table (Synapse/Fabric CETAS)
  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('SourceData'), cell('U '), nullCell()],
    [cell('ext'), cell('ExportTarget'), cell('ET'), nullCell()],
    [cell('dbo'), cell('uspExportData'), cell('P '),
      cell('CREATE PROCEDURE [dbo].[uspExportData] AS\nINSERT INTO [ext].[ExportTarget]\nSELECT * FROM [dbo].[SourceData]')],
  ];

  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('dbo'), cell('uspExportData'), cell('dbo'), cell('SourceData')],
    [cell('dbo'), cell('uspExportData'), cell('ext'), cell('ExportTarget')],
  ];

  const emptyCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(emptyCols, []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);

  const extId = '[ext].[exporttarget]';
  const spId = '[dbo].[uspexportdata]';
  const srcId = '[dbo].[sourcedata]';

  // WRITE edge: SP → external target (INSERT INTO)
  const writeEdge = model.edges.find(e => e.source === spId && e.target === extId);
  assert(writeEdge !== undefined,
    `Write edge SP → ExportTarget exists (edges: ${model.edges.map(e => `${e.source}→${e.target}`).join(', ')})`);

  // READ edge: SourceData → SP
  const readEdge = model.edges.find(e => e.source === srcId && e.target === spId);
  assert(readEdge !== undefined, 'Read edge SourceData → SP exists');
}

// ─── Constraint Tests ────────────────────────────────────────────────────────

function buildConstraintsResult(): SimpleExecuteResult {
  const constraintCols = cols(
    'schema_name', 'table_name', 'constraint_type', 'constraint_name',
    'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete',
  );
  const rows: DbCellValue[][] = [
    // FK: Orders.CustomerId → Customers.Id
    [cell('dbo'), cell('Orders'), cell('FK'), cell('FK_Orders_Customers'),
      cell('CustomerId'), cell('1'), cell('dbo'), cell('Customers'), cell('Id'), cell('NO ACTION')],
    // FK: Orders.ProductId → Products.Id
    [cell('dbo'), cell('Orders'), cell('FK'), cell('FK_Orders_Products'),
      cell('ProductId'), cell('1'), cell('dbo'), cell('Products'), cell('Id'), cell('CASCADE')],
    // UQ: Customers.Name
    [cell('dbo'), cell('Customers'), cell('UQ'), cell('UQ_Customers_Name'),
      cell('Name'), cell('1'), nullCell(), nullCell(), nullCell(), nullCell()],
    // CK: Products.Id (column-level)
    [cell('dbo'), cell('Products'), cell('CK'), cell('CK_Products_Id'),
      cell('Id'), nullCell(), nullCell(), nullCell(), nullCell(), nullCell()],
  ];
  return makeResult(constraintCols, rows);
}

function testConstraintMapsEnrichColumns() {
  console.log('\n── DMV Extractor: constraint enrichment ──');

  const baseResults = buildSyntheticResults();
  const resultsWithConstraints: DmvResults = {
    ...baseResults,
    constraints: buildConstraintsResult(),
  };
  const model = buildModelFromDmv(resultsWithConstraints);

  // Customers.Name should have UQ flag
  const customersNode = model.nodes.find(n => n.name === 'Customers');
  assert(customersNode !== undefined, 'Customers node found');
  assert(customersNode?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'Customers has UQ flag on column');
  // Customers has no FKs → fks should be empty array
  assert(customersNode?.fks !== undefined && customersNode.fks.length === 0, 'Customers has empty fks array (no FKs)');

  // Orders should have FK data on node
  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  assert(ordersNode !== undefined, 'Orders node found');
  assert((ordersNode?.fks?.length ?? 0) > 0, 'Orders has FK constraints');
  assert(ordersNode!.fks!.some(fk => fk.name === 'FK_Orders_Customers'), 'Orders has FK_Orders_Customers');
  assert(ordersNode!.fks!.some(fk => fk.name === 'FK_Orders_Products'), 'Orders has FK_Orders_Products');
  assert(ordersNode!.fks!.some(fk => fk.onDelete === 'CASCADE'), 'Orders FK has CASCADE on delete');
  assert(ordersNode!.fks!.some(fk => fk.refTable === 'Customers'), 'Orders FK references Customers');

  // Products.Id should have CK flag
  const productsNode = model.nodes.find(n => n.name === 'Products');
  assert(productsNode !== undefined, 'Products node found');
  assert(productsNode?.columns?.some(c => c.check !== undefined && c.check !== ''), 'Products has CK flag on column');
}

function testConstraintsMissingResultGraceful() {
  console.log('\n── DMV Extractor: no constraints result (dacpac-path compat) ──');

  const results = buildSyntheticResults();  // no constraints field
  const model = buildModelFromDmv(results);

  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  assert(ordersNode !== undefined, 'Orders node found without constraints');
  assert(ordersNode?.fks === undefined || ordersNode.fks.length === 0, 'No FKs when constraints absent');
  assert(!ordersNode?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'No UQ flags when constraints absent');

  // Columns still present
  assert(ordersNode?.columns?.some(c => c.name === 'OrderId'), 'Columns still present without constraints');
}

function testValidateQueryResultConstraints() {
  console.log('\n── DMV Extractor: validateQueryResult — constraints ──');

  const constraintCols = cols(
    'schema_name', 'table_name', 'constraint_type', 'constraint_name',
    'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete',
  );
  const result = makeResult(constraintCols, []);
  const missing = validateQueryResult('constraints', result);
  assertEq(missing.length, 0, 'No missing columns for valid constraints result');

  const incomplete = makeResult(cols('schema_name', 'table_name'), []);
  const missingCols = validateQueryResult('constraints', incomplete);
  assert(missingCols.length > 0, 'Missing columns detected for incomplete constraints result');
}

// ─── Test: Cross-DB Dependencies via referenced_database ─────────────────────

function testCrossDbDepsFromDmv() {
  console.log('\n── DMV Extractor: Cross-DB Dependencies (referenced_database) ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('Sales'), cell('U '), nullCell()],
    [cell('dbo'), cell('spLoadFromArchive'), cell('P '),
      cell('CREATE PROCEDURE [dbo].[spLoadFromArchive] AS\nINSERT INTO [dbo].[Sales]\nSELECT * FROM [ArchiveDB].[dbo].[ArchivedSales]')],
  ];

  // 5-column deps — includes referenced_database
  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name', 'referenced_database');
  const depsRows: DbCellValue[][] = [
    // Local dep: SP → Sales (no database)
    [cell('dbo'), cell('spLoadFromArchive'), cell('dbo'), cell('Sales'), nullCell()],
    // Cross-DB dep: SP → ArchiveDB.dbo.ArchivedSales
    [cell('dbo'), cell('spLoadFromArchive'), cell('dbo'), cell('ArchivedSales'), cell('ArchiveDB')],
  ];

  const emptyCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(emptyCols, []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);

  // Cross-DB virtual node should be created
  const crossDbNode = model.nodes.find(n => n.externalType === 'db');
  assert(crossDbNode !== undefined, 'CrossDB-DMV: virtual db node created from referenced_database');
  // DMV metadata path lowercases all parts (modelBuilder.ts L705)
  assertEq(crossDbNode?.externalDatabase?.toLowerCase(), 'archivedb', 'CrossDB-DMV: externalDatabase set correctly');
  assertEq(crossDbNode?.schema, '', 'CrossDB-DMV: virtual node has empty schema');
  assert(crossDbNode!.name.toLowerCase().includes('archivedsales'), 'CrossDB-DMV: virtual node name includes object name');

  // Edge: SP → cross-DB node (cross-DB is a source in the SP body, so cross-DB → SP)
  const crossDbEdge = model.edges.find(e =>
    e.target === '[dbo].[sploadfromarchive]' && e.source === crossDbNode!.id
  );
  assert(crossDbEdge !== undefined,
    `CrossDB-DMV: cross-DB → SP edge exists (edges: ${model.edges.map(e => `${e.source}→${e.target}`).join(', ')})`);

  // Local edge still works: SP writes to Sales
  const localEdge = model.edges.find(e =>
    e.source === '[dbo].[sploadfromarchive]' && e.target === '[dbo].[sales]'
  );
  assert(localEdge !== undefined, 'CrossDB-DMV: local SP → Sales write edge exists');

  // Total: 2 real + 1 virtual = 3 nodes
  assertEq(model.nodes.length, 3, 'CrossDB-DMV: 2 real + 1 virtual = 3 nodes');
}

function testCrossDbSameDbSuppression() {
  console.log('\n── DMV Extractor: Cross-DB same-DB suppression via currentDatabase ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('Sales'), cell('U '), nullCell()],
    [cell('dbo'), cell('ArchivedSales'), cell('U '), nullCell()],
    [cell('dbo'), cell('spLoad'), cell('P '),
      cell('CREATE PROCEDURE [dbo].[spLoad] AS SELECT * FROM [dbo].[ArchivedSales]')],
  ];

  // Cross-DB dep where database = currentDatabase → should resolve locally
  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name', 'referenced_database');
  const depsRows: DbCellValue[][] = [
    [cell('dbo'), cell('spLoad'), cell('dbo'), cell('ArchivedSales'), cell('MyDB')],
    [cell('dbo'), cell('spLoad'), cell('dbo'), cell('Sales'), nullCell()],
  ];

  const emptyCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(emptyCols, []),
    dependencies: makeResult(depsCols, depsRows),
  };

  // Pass currentDatabase = 'MyDB' — same as referenced_database
  const model = buildModelFromDmv(results, 'MyDB');
  const crossDbNode = model.nodes.find(n => n.externalType === 'db');
  assert(crossDbNode === undefined, 'CrossDB-SameDB: no virtual node when referenced_database = currentDatabase');
  assertEq(model.nodes.length, 3, 'CrossDB-SameDB: only 3 real nodes');
}

function testETInAllObjectsCatalog() {
  console.log('\n── DMV Extractor: ET in allObjects catalog ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('ext'), cell('S3Data'), cell('ET'), nullCell()],
  ];

  const allObjCols = cols('schema_name', 'object_name', 'type_code');
  const allObjRows: DbCellValue[][] = [
    [cell('ext'), cell('S3Data'), cell('ET')],
    [cell('dbo'), cell('Orders'), cell('U ')],
  ];

  const emptyCols = cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed');

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(emptyCols, []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []),
    allObjects: makeResult(allObjCols, allObjRows),
  };

  const model = buildModelFromDmv(results);
  assertEq(model.nodes.length, 1, 'ET-AllObj: 1 rendered node');
  assertEq(model.nodes[0].type, 'external', 'ET-AllObj: type=external');
  assertEq(model.nodes[0].externalType, 'et', 'ET-AllObj: externalType=et');

  // Catalog from allObjects should map ET + regular table
  const etCat = model.catalog['[ext].[s3data]'];
  assert(etCat !== undefined, 'ET-AllObj: catalog entry for ET from allObjects');
  assertEq(etCat?.type, 'external', 'ET-AllObj: catalog type=external');

  const ordersCat = model.catalog['[dbo].[orders]'];
  assert(ordersCat !== undefined, 'ET-AllObj: catalog entry for dbo.Orders from allObjects');
}

// ─── Run ────────────────────────────────────────────────────────────────────

testBuildModelFromDmv();
testEmptyDatabase();
testValidateQueryResult();
testFormatColumnType();
testDuplicateNodes();
testSelfReferenceExcluded();
testFallbackBodyDirection();
testCrossSchemaNeighborIndex();
testCrossSchemaUnresolvedWhenNoAllObjects();
testExternalTableNodes();
testExternalTableWriteDirection();
testCrossDbDepsFromDmv();
testCrossDbSameDbSuppression();
testETInAllObjectsCatalog();
testConstraintMapsEnrichColumns();
testConstraintsMissingResultGraceful();
testValidateQueryResultConstraints();

// ─── expandSchemaPlaceholder ──────────────────────────────────────────────────

function testExpandSchemaPlaceholder() {
  console.log('\n── expandSchemaPlaceholder ──');

  // Basic expansion
  const sql = `SELECT * FROM sys.objects o\nINNER JOIN sys.schemas s ON o.schema_id = s.schema_id\nWHERE s.name IN ({{SCHEMAS}})`;
  const expanded = expandSchemaPlaceholder(sql, ['dbo', 'Sales']);
  assert(expanded.includes("s.name IN ('dbo', 'Sales')"), 'Basic: schema list expanded');
  assert(!expanded.includes('{{SCHEMAS}}'), 'Basic: no placeholder remnants');

  // Multiple placeholders (dependencies-style OR)
  const depsSql = `SELECT * FROM sys.sql_expression_dependencies d\nWHERE (s1.name IN ({{SCHEMAS}}) OR d.referenced_schema_name IN ({{SCHEMAS}}))`;
  const expandedDeps = expandSchemaPlaceholder(depsSql, ['dbo']);
  assert(expandedDeps.includes("s1.name IN ('dbo')"), 'Multi: first placeholder expanded');
  assert(expandedDeps.includes("d.referenced_schema_name IN ('dbo')"), 'Multi: second placeholder expanded');
  assert(!expandedDeps.includes('{{SCHEMAS}}'), 'Multi: no placeholder remnants');

  // No placeholder — returns SQL unchanged
  const noPlaceholder = `SELECT * FROM sys.objects`;
  const unchanged = expandSchemaPlaceholder(noPlaceholder, ['dbo']);
  assert(unchanged === noPlaceholder, 'No placeholder: SQL unchanged');

  // SQL injection: single quote in schema name
  const injected = expandSchemaPlaceholder(sql, ["O'Brien"]);
  assert(injected.includes("'O''Brien'"), 'SQL injection: single quote escaped');

  // Empty schema list
  const empty = expandSchemaPlaceholder(sql, []);
  assert(empty.includes('s.name IN ()'), 'Empty: produces IN ()');
}

function testValidateSchemaPlaceholder() {
  console.log('\n── validateSchemaPlaceholder ──');

  // Phase 2 without placeholder → warning
  const warn = validateSchemaPlaceholder('test-query', 'SELECT 1', 2);
  assert(warn !== undefined, 'Phase 2 without placeholder: returns warning');
  assert(warn!.includes('test-query'), 'Warning includes query name');

  // Phase 2 with placeholder → no warning
  const ok = validateSchemaPlaceholder('test-query', 'WHERE s.name IN ({{SCHEMAS}})', 2);
  assert(ok === undefined, 'Phase 2 with placeholder: no warning');

  // Phase 1 without placeholder → no warning (expected)
  const phase1 = validateSchemaPlaceholder('schema-preview', 'SELECT 1', 1);
  assert(phase1 === undefined, 'Phase 1 without placeholder: no warning');
}

function testYamlQueriesHavePlaceholder() {
  console.log('\n── YAML queries: Phase 2 placeholder validation ──');

  // Load the ACTUAL dmvQueries.yaml and validate all Phase 2 queries have {{SCHEMAS}}
  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };

  const phase2 = config.queries.filter(q => (q.phase ?? 2) !== 1);
  assert(phase2.length >= 4, `At least 4 Phase 2 queries (got ${phase2.length})`);

  for (const q of phase2) {
    assert(q.sql.includes('{{SCHEMAS}}'), `YAML Phase 2 query '${q.name}' has {{SCHEMAS}} placeholder`);

    // Expand and verify no remnants
    const expanded = expandSchemaPlaceholder(q.sql, ['dbo', 'Sales']);
    assert(!expanded.includes('{{SCHEMAS}}'), `YAML '${q.name}': no placeholder remnants after expansion`);
  }

  // Phase 1 queries should NOT have placeholder
  const phase1 = config.queries.filter(q => q.phase === 1);
  assert(phase1.length >= 2, `At least 2 Phase 1 queries (got ${phase1.length})`);
  for (const q of phase1) {
    assert(!q.sql.includes('{{SCHEMAS}}'), `YAML Phase 1 query '${q.name}' has no placeholder`);
  }
}

function testExpandedSqlStructure() {
  console.log('\n── Expanded SQL structural validation ──');

  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };
  const phase2 = config.queries.filter(q => (q.phase ?? 2) !== 1);

  for (const q of phase2) {
    const expanded = expandSchemaPlaceholder(q.sql, ['dbo', 'Sales']);

    // No literal {{ or }} remnants (catches partial expansion bugs)
    assert(!expanded.includes('{{'), `'${q.name}': no {{ remnants`);
    assert(!expanded.includes('}}'), `'${q.name}': no }} remnants`);

    // Balanced parentheses
    let depth = 0;
    let balanced = true;
    for (const ch of expanded) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth < 0) { balanced = false; break; }
    }
    assert(balanced && depth === 0, `'${q.name}': balanced parentheses (depth=${depth})`);

    // CTE queries must start with WITH and end with a SELECT
    if (/^\s*WITH\s+/i.test(q.sql)) {
      assert(/^\s*WITH\s+/i.test(expanded), `'${q.name}': CTE structure preserved after expansion`);
      assert(/\bSELECT\b/i.test(expanded), `'${q.name}': CTE has final SELECT`);
    }
  }
}

testExpandSchemaPlaceholder();
testValidateSchemaPlaceholder();
testYamlQueriesHavePlaceholder();
testExpandedSqlStructure();

printSummary('DMV Extractor');
