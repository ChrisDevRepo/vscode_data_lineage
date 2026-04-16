/**
 * DMV Extractor test — uses synthetic DMV data to verify model building.
 * Execute with: npx tsx test/dmvExtractor.test.ts
 */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { buildModelFromDmv, validateQueryResult } from '../../src/engine/dmvExtractor';
import { formatColumnType } from '../../src/engine/types';
import type { DmvResults } from '../../src/engine/dmvExtractor';
import type { SimpleExecuteResult, DbCellValue, IDbColumn } from '../../src/types/mssql';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../../src/utils/sql';
import { assert, assertEq, loadParseRules, rootPath, printSummary } from './helpers/testUtils';

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

  // ── Empty database ──
  const emptyResults: DmvResults = {
    nodes: makeResult(cols('schema_name', 'object_name', 'type_code', 'body_script'), []),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []),
  };
  const emptyModel = buildModelFromDmv(emptyResults);
  assertEq(emptyModel.nodes.length, 0, 'Empty DB has 0 nodes');
  assertEq(emptyModel.edges.length, 0, 'Empty DB has 0 edges');
  assert(emptyModel.warnings !== undefined && emptyModel.warnings.length > 0, 'Empty DB produces warning');

  // ── Duplicate node handling ──
  const nodeCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const dupResults: DmvResults = {
    nodes: makeResult(nodeCols, [
      [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
      [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
    ]),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []),
  };
  assertEq(buildModelFromDmv(dupResults).nodes.length, 1, 'Duplicate nodes are deduplicated');

  // ── Self-reference exclusion ──
  const selfRefResults: DmvResults = {
    nodes: makeResult(nodeCols, [[cell('dbo'), cell('MyTable'), cell('U '), nullCell()]]),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'),
      [[cell('dbo'), cell('MyTable'), cell('dbo'), cell('MyTable')]]),
  };
  assertEq(buildModelFromDmv(selfRefResults).edges.length, 0, 'Self-references produce no edges');
}

function testValidateQueryResult() {
  console.log('\n── DMV Extractor: Column Validation ──');

  // Valid results for each query type
  const validCases: [string, string[]][] = [
    ['nodes', ['schema_name', 'object_name', 'type_code', 'body_script']],
    ['dependencies', ['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name']],
    ['constraints', ['schema_name', 'table_name', 'constraint_type', 'constraint_name', 'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete']],
  ];
  for (const [name, colNames] of validCases) {
    assertEq(validateQueryResult(name, makeResult(cols(...colNames), [])).length, 0, `Valid ${name}: no missing`);
  }

  // Missing columns detected
  const missing = validateQueryResult('nodes', makeResult(cols('schema_name', 'object_name'), []));
  assertEq(missing.length, 2, 'Invalid nodes: 2 missing');

  // Case insensitive
  assertEq(validateQueryResult('nodes', makeResult(cols('Schema_Name', 'Object_Name', 'Type_Code', 'Body_Script'), [])).length, 0, 'Case-insensitive');

  // Unknown query → no missing
  assertEq(validateQueryResult('unknown', makeResult(cols(), [])).length, 0, 'Unknown query: no missing');
}

function testFormatColumnType() {
  console.log('\n── DMV Extractor: formatColumnType ──');

  // [typeName, maxLen, precision, scale, expected]
  const cases: [string, string, string, string, string][] = [
    // Simple types (no size)
    ['int',       '4',   '10', '0', 'int'],
    ['bigint',    '8',   '19', '0', 'bigint'],
    ['bit',       '1',   '1',  '0', 'bit'],
    ['datetime',  '8',   '23', '3', 'datetime'],
    // String types with max_length
    ['varchar',   '50',  '0',  '0', 'varchar(50)'],
    ['varchar',   '-1',  '0',  '0', 'varchar(max)'],
    ['nvarchar',  '200', '0',  '0', 'nvarchar(100)'],  // bytes ÷ 2
    ['nvarchar',  '-1',  '0',  '0', 'nvarchar(max)'],
    ['nchar',     '20',  '0',  '0', 'nchar(10)'],      // bytes ÷ 2
    // Binary
    ['varbinary', '-1',  '0',  '0', 'varbinary(max)'],
    // Decimal/numeric
    ['decimal',   '9',   '18', '2', 'decimal(18,2)'],
    ['numeric',   '9',   '10', '0', 'numeric(10,0)'],
  ];
  for (const [type, len, prec, scale, expected] of cases) {
    assertEq(formatColumnType(type, len, prec, scale), expected, expected);
  }
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

  // ── No constraints result (dacpac-path compat) ──
  const noConstraintResults = buildSyntheticResults();  // no constraints field
  const noConstraintModel = buildModelFromDmv(noConstraintResults);
  const ordersNoConst = noConstraintModel.nodes.find(n => n.name === 'Orders');
  assert(ordersNoConst !== undefined, 'Orders node found without constraints');
  assert(ordersNoConst?.fks === undefined || ordersNoConst.fks.length === 0, 'No FKs when constraints absent');
  assert(!ordersNoConst?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'No UQ flags when constraints absent');
  assert(ordersNoConst?.columns?.some(c => c.name === 'OrderId'), 'Columns still present without constraints');
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
testValidateQueryResult();
testFormatColumnType();
testFallbackBodyDirection();
testCrossSchemaNeighborIndex();
testCrossSchemaUnresolvedWhenNoAllObjects();
testExternalTableNodes();
testExternalTableWriteDirection();
testCrossDbDepsFromDmv();
testCrossDbSameDbSuppression();
testETInAllObjectsCatalog();
testConstraintMapsEnrichColumns();

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

  // validateSchemaPlaceholder: Phase 2 without placeholder → warning; Phase 1 → no warning
  assert(validateSchemaPlaceholder('q', 'SELECT 1', 2) !== undefined, 'Phase 2 no placeholder → warning');
  assert(validateSchemaPlaceholder('q', 'WHERE IN ({{SCHEMAS}})', 2) === undefined, 'Phase 2 with placeholder → ok');
  assert(validateSchemaPlaceholder('q', 'SELECT 1', 1) === undefined, 'Phase 1 no placeholder → ok');
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

// ─── Bridge: mapEnginePlatform via buildModelFromDmv ─────────────────────────

function makePlatformInfo(engineEdition: number, majorVersion: number, edition: string): SimpleExecuteResult {
  return makeResult(
    cols('engine_edition', 'major_version', 'edition'),
    [[cell(String(engineEdition)), cell(String(majorVersion)), cell(edition)]],
  );
}

function testDbPlatformFromDmv() {
  console.log('\n── DMV Bridge: dbPlatform via mapEnginePlatform ──');

  const emptyNodes = makeResult(cols('schema_name', 'object_name', 'type_code', 'body_script'), []);
  const emptyCols = makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []);
  const emptyDeps = makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []);

  function modelWithPlatform(platformInfo: SimpleExecuteResult) {
    return buildModelFromDmv({ nodes: emptyNodes, columns: emptyCols, dependencies: emptyDeps, platformInfo });
  }

  // Cloud editions
  assertEq(modelWithPlatform(makePlatformInfo(5,  0, '')).dbPlatform, 'Azure SQL Database',        'EngineEdition 5 → Azure SQL Database');
  assertEq(modelWithPlatform(makePlatformInfo(6,  0, '')).dbPlatform, 'Synapse Dedicated Pool',     'EngineEdition 6 → Synapse Dedicated Pool');
  assertEq(modelWithPlatform(makePlatformInfo(8,  0, '')).dbPlatform, 'Azure SQL Managed Instance', 'EngineEdition 8 → Azure SQL Managed Instance');
  assertEq(modelWithPlatform(makePlatformInfo(9,  0, '')).dbPlatform, 'Azure SQL Edge',              'EngineEdition 9 → Azure SQL Edge');
  assertEq(modelWithPlatform(makePlatformInfo(11, 0, '')).dbPlatform, 'Fabric Data Warehouse',      'EngineEdition 11 → Fabric Data Warehouse');
  assertEq(modelWithPlatform(makePlatformInfo(12, 0, '')).dbPlatform, 'SQL Database in Fabric',     'EngineEdition 12 → SQL Database in Fabric');

  // On-prem editions: representative versions (earliest, middle, latest)
  const onPremCases: [number, string][] = [
    [17, 'SQL Server 2025'],
    [13, 'SQL Server 2016'],
    [8,  'SQL Server 2000'],
  ];
  for (const [major, expected] of onPremCases) {
    const model = modelWithPlatform(makePlatformInfo(3, major, 'Enterprise Edition'));
    assertEq(model.dbPlatform, expected, `EngineEdition 3, major ${major} → ${expected}`);
  }

  // Unknown major version → fall back to edition string
  const unknownMajor = modelWithPlatform(makePlatformInfo(3, 99, 'Developer Edition'));
  assertEq(unknownMajor.dbPlatform, 'Developer Edition',
    'Unknown major version → edition string fallback');

  // Unknown edition AND unknown major → dbPlatform = undefined (edition is empty)
  const unknownAll = modelWithPlatform(makePlatformInfo(3, 99, ''));
  assert(unknownAll.dbPlatform === undefined || unknownAll.dbPlatform === '',
    'Unknown edition + unknown major → dbPlatform absent');

  // No platformInfo → dbPlatform absent
  const noPlatform = buildModelFromDmv({ nodes: emptyNodes, columns: emptyCols, dependencies: emptyDeps });
  assert(noPlatform.dbPlatform === undefined, 'No platformInfo → dbPlatform undefined');

  // Empty rows in platformInfo → dbPlatform absent
  const emptyRows = makeResult(cols('engine_edition', 'major_version', 'edition'), []);
  const noRows = modelWithPlatform(emptyRows);
  assert(noRows.dbPlatform === undefined, 'Empty platformInfo rows → dbPlatform undefined');
}

// ─── Bridge: pkOrdinal from columns query ────────────────────────────────────

function testPkOrdinalFromDmv() {
  console.log('\n── DMV Bridge: pkOrdinal in ColumnDef ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('OrderDetail'), cell('U '), nullCell()],
  ];

  // columns with pk_ordinal column: composite PK on (OrderId, LineId), Name is non-PK
  const columnsCols = cols(
    'schema_name', 'table_name', 'ordinal', 'column_name',
    'type_name', 'max_length', 'precision', 'scale',
    'is_nullable', 'is_identity', 'is_computed', 'pk_ordinal',
  );
  const columnsRows: DbCellValue[][] = [
    [cell('dbo'), cell('OrderDetail'), cell('1'), cell('OrderId'),
      cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('0'), cell('0'), cell('1')],
    [cell('dbo'), cell('OrderDetail'), cell('2'), cell('LineId'),
      cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('0'), cell('0'), cell('2')],
    [cell('dbo'), cell('OrderDetail'), cell('3'), cell('Name'),
      cell('nvarchar'), cell('200'), cell('0'), cell('0'), cell('1'), cell('0'), cell('0'), nullCell()],
  ];

  const emptyDeps = makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []);

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(columnsCols, columnsRows),
    dependencies: emptyDeps,
  };

  const model = buildModelFromDmv(results);
  const table = model.nodes.find(n => n.name === 'OrderDetail');
  assert(table !== undefined, 'OrderDetail table found');

  const orderId = table!.columns?.find(c => c.name === 'OrderId');
  assert(orderId !== undefined, 'OrderId column found');
  assertEq(orderId!.pkOrdinal, 1, 'OrderId: pkOrdinal = 1');

  const lineId = table!.columns?.find(c => c.name === 'LineId');
  assert(lineId !== undefined, 'LineId column found');
  assertEq(lineId!.pkOrdinal, 2, 'LineId: pkOrdinal = 2');

  const name = table!.columns?.find(c => c.name === 'Name');
  assert(name !== undefined, 'Name column found');
  assert(name!.pkOrdinal === undefined, 'Name: no pkOrdinal (not a PK column)');

  // Single-column PK: pk_ordinal=1 only
  const singlePkCols = cols(
    'schema_name', 'table_name', 'ordinal', 'column_name',
    'type_name', 'max_length', 'precision', 'scale',
    'is_nullable', 'is_identity', 'is_computed', 'pk_ordinal',
  );
  const singlePkRows: DbCellValue[][] = [
    [cell('dbo'), cell('Product'), cell('1'), cell('Id'),
      cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('1'), cell('0'), cell('1')],
    [cell('dbo'), cell('Product'), cell('2'), cell('Name'),
      cell('nvarchar'), cell('200'), cell('0'), cell('0'), cell('1'), cell('0'), cell('0'), nullCell()],
  ];
  const singlePkNodeRows: DbCellValue[][] = [
    [cell('dbo'), cell('Product'), cell('U '), nullCell()],
  ];
  const singleResults: DmvResults = {
    nodes: makeResult(nodesCols, singlePkNodeRows),
    columns: makeResult(singlePkCols, singlePkRows),
    dependencies: emptyDeps,
  };
  const singleModel = buildModelFromDmv(singleResults);
  const product = singleModel.nodes.find(n => n.name === 'Product');
  const productId = product?.columns?.find(c => c.name === 'Id');
  assertEq(productId?.pkOrdinal, 1, 'Single PK: Id.pkOrdinal = 1');
  assert(product?.columns?.find(c => c.name === 'Name')?.pkOrdinal === undefined,
    'Single PK: Name column has no pkOrdinal');

  // No pk_ordinal column in result (older query version) → no pkOrdinal set, no crash
  const noPkCols = cols(
    'schema_name', 'table_name', 'ordinal', 'column_name',
    'type_name', 'max_length', 'precision', 'scale',
    'is_nullable', 'is_identity', 'is_computed',
    // pk_ordinal intentionally absent
  );
  const noPkRows: DbCellValue[][] = [
    [cell('dbo'), cell('Legacy'), cell('1'), cell('Id'),
      cell('int'), cell('4'), cell('10'), cell('0'), cell('0'), cell('1'), cell('0')],
  ];
  const legacyNodeRows: DbCellValue[][] = [
    [cell('dbo'), cell('Legacy'), cell('U '), nullCell()],
  ];
  const legacyResults: DmvResults = {
    nodes: makeResult(nodesCols, legacyNodeRows),
    columns: makeResult(noPkCols, noPkRows),
    dependencies: emptyDeps,
  };
  const legacyModel = buildModelFromDmv(legacyResults);
  const legacyId = legacyModel.nodes.find(n => n.name === 'Legacy')?.columns?.find(c => c.name === 'Id');
  assert(legacyId !== undefined, 'Legacy: Id column found');
  assert(legacyId!.pkOrdinal === undefined, 'Legacy (no pk_ordinal col): pkOrdinal absent — no crash');
}

testExpandSchemaPlaceholder();
testYamlQueriesHavePlaceholder();
testExpandedSqlStructure();
testDbPlatformFromDmv();
testPkOrdinalFromDmv();

printSummary('DMV Extractor');
