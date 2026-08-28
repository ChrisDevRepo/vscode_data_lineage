/**
 * DMV Extractor test — uses synthetic DMV data to verify model building.
 */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { buildModelFromDmv, mapServerInfoPlatform, validateQueryResult } from '../../../src/engine/dmvExtractor';
import { formatColumnType } from '../../../src/engine/types';
import type { DmvResults } from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult, DbCellValue, IDbColumn, IServerInfo } from '../../../src/types/mssql';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../../../src/utils/sql';
import { isPhase2Query, type DmvQuery } from '../../../src/engine/connectionManager';
import { loadParseRules, rootPath } from '../helpers/testUtils';

describe('DMV Extractor', () => {
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
  expect(model.nodes.length, 'Should have 6 nodes').toBe(6);
  const tables = model.nodes.filter(n => n.type === 'table');
  const views = model.nodes.filter(n => n.type === 'view');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  expect(tables.length, 'Should have 3 tables').toBe(3);
  expect(views.length, 'Should have 1 view').toBe(1);
  expect(procs.length, 'Should have 2 procedures').toBe(2);

  // Schema computation
  expect(model.schemas.length, 'Should have 2 schemas').toBe(2);
  const dboSchema = model.schemas.find(s => s.name === 'dbo');
  const salesSchema = model.schemas.find(s => s.name === 'sales');
  expect(dboSchema !== undefined, 'dbo schema found').toBe(true);
  expect(salesSchema !== undefined, 'sales schema found').toBe(true);
  expect(dboSchema!.nodeCount, 'dbo has 4 nodes').toBe(4);
  expect(salesSchema!.nodeCount, 'sales has 2 nodes').toBe(2);

  // Node IDs are normalized
  const customerNode = model.nodes.find(n => n.name === 'Customers');
  expect(customerNode?.id, 'Customer ID normalized to lowercase').toBe('[dbo].[customers]');
  expect(customerNode?.schema, 'Customer schema preserved in catalog-original casing').toBe('dbo');

  // Catalog and neighborIndex are present and populated
  expect(Object.keys(model.catalog).length >= model.nodes.length, 'Catalog has at least one entry per node').toBe(true);
  expect(Object.keys(model.neighborIndex).length > 0, 'NeighborIndex populated').toBe(true);

  // neighborIndex: vActiveCustomers should have Customers as inbound neighbor
  const viewId = '[dbo].[vactivecustomers]';
  expect(model.neighborIndex[viewId]?.in.includes('[dbo].[customers]'), 'neighborIndex: Customers → vActiveCustomers').toBe(true);
  // catalog: Customers entry should have original casing
  expect(model.catalog['[dbo].[customers]']?.schema === 'dbo', 'catalog: Customers schema is dbo').toBe(true);

  // Edges
  expect(model.edges.length > 0, `Has ${model.edges.length} edges`).toBe(true);

  // View edge (from DMV deps — not regex parsed): Customers → vActiveCustomers
  const viewEdge = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[dbo].[vactivecustomers]'
  );
  expect(viewEdge !== undefined, 'View has inbound edge from Customers').toBe(true);

  // SP edges (regex-parsed): uspGetOrdersByCustomer reads Orders and Customers
  const spReadOrders = model.edges.find(e =>
    e.source === '[dbo].[orders]' && e.target === '[sales].[uspgetordersbycustomer]'
  );
  expect(spReadOrders !== undefined, 'SP uspGetOrdersByCustomer reads Orders').toBe(true);

  const spReadCustomers = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[sales].[uspgetordersbycustomer]'
  );
  expect(spReadCustomers !== undefined, 'SP uspGetOrdersByCustomer reads Customers').toBe(true);

  // SP edges (regex-parsed): uspCreateOrder writes to Orders, reads Customers + Products
  const spWriteOrders = model.edges.find(e =>
    e.source === '[sales].[uspcreateorder]' && e.target === '[dbo].[orders]'
  );
  expect(spWriteOrders !== undefined, 'SP uspCreateOrder writes to Orders').toBe(true);

  const spReadCustomers2 = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[sales].[uspcreateorder]'
  );
  expect(spReadCustomers2 !== undefined, 'SP uspCreateOrder reads Customers').toBe(true);

  const spReadProducts = model.edges.find(e =>
    e.source === '[dbo].[products]' && e.target === '[sales].[uspcreateorder]'
  );
  expect(spReadProducts !== undefined, 'SP uspCreateOrder reads Products').toBe(true);

  // Parse stats
  expect(model.parseStats !== undefined, 'Parse stats present').toBe(true);
  expect(model.parseStats!.spDetails.length, '2 SPs in parse details').toBe(2);

  // Table columns available on node
  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  expect(!!ordersNode?.columns?.some(c => c.name === 'OrderId'), 'Orders table has OrderId column').toBe(true);
  expect(!!ordersNode?.columns?.some(c => c.type.includes('int')), 'Orders table has int type column').toBe(true);

  // No warnings for valid data
  expect(model.warnings === undefined, 'No warnings for valid data').toBe(true);

  // ── Empty database ──
  const emptyResults: DmvResults = {
    nodes: makeResult(cols('schema_name', 'object_name', 'type_code', 'body_script'), []),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'), []),
  };
  const emptyModel = buildModelFromDmv(emptyResults);
  expect(emptyModel.nodes.length, 'Empty DB has 0 nodes').toBe(0);
  expect(emptyModel.edges.length, 'Empty DB has 0 edges').toBe(0);
  expect(emptyModel.warnings !== undefined && emptyModel.warnings.length > 0, 'Empty DB produces warning').toBe(true);

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
  expect(buildModelFromDmv(dupResults).nodes.length, 'Duplicate nodes are deduplicated').toBe(1);

  // ── Self-reference exclusion ──
  const selfRefResults: DmvResults = {
    nodes: makeResult(nodeCols, [[cell('dbo'), cell('MyTable'), cell('U '), nullCell()]]),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'),
      [[cell('dbo'), cell('MyTable'), cell('dbo'), cell('MyTable')]]),
  };
  expect(buildModelFromDmv(selfRefResults).edges.length, 'Self-references produce no edges').toBe(0);
}

function testValidateQueryResult() {
  console.log('\n── DMV Extractor: Column Validation ──');

  // Valid results for each query type
  const validCases: [string, string[]][] = [
    ['nodes', ['schema_name', 'object_name', 'type_code', 'body_script']],
    ['dependencies', ['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name']],
    ['constraints', ['schema_name', 'table_name', 'constraint_type', 'constraint_name', 'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete']],
    ['platform-info', ['engine_edition', 'major_version', 'edition']],
  ];
  for (const [name, colNames] of validCases) {
    expect(validateQueryResult(name, makeResult(cols(...colNames), [])).length, `Valid ${name}: no missing`).toBe(0);
  }

  // Missing columns detected
  const missing = validateQueryResult('nodes', makeResult(cols('schema_name', 'object_name'), []));
  expect(missing.length, 'Invalid nodes: 2 missing').toBe(2);
  expect(
    validateQueryResult('platform-info', makeResult(cols('engine_edition'), [])).length,
    'Invalid platform-info: 2 missing',
  ).toBe(2);

  // Case insensitive
  expect(validateQueryResult('nodes', makeResult(cols('Schema_Name', 'Object_Name', 'Type_Code', 'Body_Script'), [])).length, 'Case-insensitive').toBe(0);

  // Unknown query → no missing
  expect(validateQueryResult('unknown', makeResult(cols(), [])).length, 'Unknown query: no missing').toBe(0);
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
    expect(formatColumnType(type, len, prec, scale), expected).toBe(expected);
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
  expect(writeEdge !== undefined, 'Fallback: unqualified UPDATE → WRITE edge (SP → table)').toBe(true);

  const readEdge = model.edges.find(e =>
    e.source === '[dbo].[readsource]' && e.target === '[dbo].[testfallbacksp]'
  );
  expect(readEdge !== undefined, 'Fallback: unqualified FROM → READ edge (table → SP)').toBe(true);
}

// ─── Test: Cross-schema dependency remains explicit when outside selection ──

function testCrossSchemaUnresolved() {
  console.log('\n── DMV: Cross-schema dependency → unresolved detail ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P '),
      cell('CREATE PROCEDURE [HumanResources].[uspUpdateEmployeePersonalInfo] AS BEGIN EXECUTE [dbo].[uspLogError]; END')],
  ];

  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('dbo'), cell('uspLogError')],
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);

  // Metadata dep must surface in Unresolved — never silently dropped
  const detail = model.parseStats?.spDetails.find(d => d.name.toLowerCase() === 'humanresources.uspupdateemployeepersonalinfo');
  expect(detail !== undefined, 'spDetails entry found for SP').toBe(true);
  const hasUnresolved = detail?.unrelated.some(r => r.toLowerCase().includes('usplogerror'));
  expect(hasUnresolved === true,
    `spDetails.unrelated contains uspLogError (got: ${JSON.stringify(detail?.unrelated)})`).toBe(true);

  // No neighborIndex entry is fabricated for an object outside the selected result set.
  const logErrId = '[dbo].[usplogerror]';
  expect(model.neighborIndex[logErrId] === undefined,
    'No neighborIndex entry for unknown dbo.uspLogError').toBe(true);
}

// ─── Test: Cross-schema dependency classified via the all-objects catalog ───

function testCrossSchemaKnownViaCatalog() {
  console.log('\n── DMV: Cross-schema dependency → known neighbor via catalog ──');

  const nodesCols = cols('schema_name', 'object_name', 'type_code', 'body_script');
  const nodesRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P '),
      cell('CREATE PROCEDURE [HumanResources].[uspUpdateEmployeePersonalInfo] AS BEGIN EXECUTE [dbo].[uspLogError]; END')],
  ];

  const depsCols = cols('referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name');
  const depsRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('dbo'), cell('uspLogError')],
  ];

  // Same fixture as testCrossSchemaUnresolved, plus the full-catalog result that lists the
  // referenced object living in the unselected 'dbo' schema.
  const allObjectsCols = cols('schema_name', 'object_name', 'type_code');
  const allObjectsRows: DbCellValue[][] = [
    [cell('dbo'), cell('uspLogError'), cell('P ')],
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P ')],
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols('schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'), []),
    dependencies: makeResult(depsCols, depsRows),
    allObjects: makeResult(allObjectsCols, allObjectsRows),
  };

  const model = buildModelFromDmv(results);

  const spId = '[humanresources].[uspupdateemployeepersonalinfo]';
  const logErrId = '[dbo].[usplogerror]';

  // With the catalog the reference is classified "cross-schema known" — not unresolved.
  const detail = model.parseStats?.spDetails.find(d => d.name.toLowerCase() === 'humanresources.uspupdateemployeepersonalinfo');
  expect(detail !== undefined, 'spDetails entry found for SP').toBe(true);
  expect(detail!.unrelated.every(r => !r.toLowerCase().includes('usplogerror')),
    `spDetails.unrelated must NOT contain uspLogError (got: ${JSON.stringify(detail?.unrelated)})`).toBe(true);

  // The known cross-schema object surfaces as a neighbor pair in the index.
  const logErrNeighbors = model.neighborIndex[logErrId];
  expect(logErrNeighbors !== undefined, 'neighborIndex entry exists for known dbo.uspLogError').toBe(true);
  const linked = [...(logErrNeighbors?.in ?? []), ...(logErrNeighbors?.out ?? [])];
  expect(linked.includes(spId),
    `dbo.uspLogError is linked to the SP in the neighbor index (got: ${JSON.stringify(logErrNeighbors)})`).toBe(true);
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
  expect(model.nodes.length, 'Should have 3 nodes (1 table, 1 external, 1 SP)').toBe(3);
  const extNodes = model.nodes.filter(n => n.type === 'external');
  expect(extNodes.length, 'Should have 1 external node').toBe(1);

  // External node properties
  const extNode = extNodes[0];
  expect(extNode !== undefined, 'External node exists').toBe(true);
  expect(extNode?.schema, 'External node has correct schema').toBe('ext');
  expect(extNode?.name, 'External node has correct name (original casing)').toBe('ExternalSales');
  expect(extNode?.id, 'External node ID is lowercase-normalized').toBe('[ext].[externalsales]');
  expect(extNode?.externalType, 'External node has externalType=et').toBe('et');
  expect(extNode?.bodyScript === undefined || extNode?.bodyScript === null,
    'External node has no bodyScript (ET has no SQL body)').toBe(true);

  // Schema info includes external type count
  const extSchema = model.schemas.find(s => s.name === 'ext');
  expect(extSchema !== undefined, 'ext schema present in schemas').toBe(true);
  expect(extSchema?.types?.external ?? 0, 'ext schema counts 1 external node').toBe(1);

  // External node in catalog
  const extId = '[ext].[externalsales]';
  const catEntry = model.catalog[extId];
  expect(catEntry !== undefined, 'External node in catalog').toBe(true);
  expect(catEntry?.type, 'catalog entry type=external').toBe('external');

  // Edge: SP reads from external table (FROM clause → external is source/upstream)
  const readEdge = model.edges.find(e =>
    e.source === extId && e.target === '[dbo].[uspLoadsales]'.toLowerCase()
  );
  expect(readEdge !== undefined,
    `Read edge external → SP exists (edges: ${model.edges.map(e => `${e.source}→${e.target}`).join(', ')})`).toBe(true);

  // Edge: SP writes to local table
  const writeEdge = model.edges.find(e =>
    e.source === '[dbo].[uspLoadsales]'.toLowerCase() && e.target === '[dbo].[localorders]'
  );
  expect(writeEdge !== undefined, 'Write edge SP → LocalOrders exists').toBe(true);

  // NeighborIndex: external table has SP in its out neighbors
  const spId = '[dbo].[uspLoadsales]'.toLowerCase();
  const extNeighbors = model.neighborIndex[extId];
  expect(extNeighbors !== undefined, 'neighborIndex entry for external node').toBe(true);
  expect(extNeighbors?.out.includes(spId),
    `External node out-neighbors include SP (got: ${JSON.stringify(extNeighbors?.out)})`).toBe(true);
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
  expect(writeEdge !== undefined,
    `Write edge SP → ExportTarget exists (edges: ${model.edges.map(e => `${e.source}→${e.target}`).join(', ')})`).toBe(true);

  // READ edge: SourceData → SP
  const readEdge = model.edges.find(e => e.source === srcId && e.target === spId);
  expect(readEdge !== undefined, 'Read edge SourceData → SP exists').toBe(true);
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
  expect(customersNode !== undefined, 'Customers node found').toBe(true);
  expect(!!customersNode?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'Customers has UQ flag on column').toBe(true);
  // Customers has no FKs → fks should be empty array
  expect(customersNode?.fks !== undefined && customersNode.fks.length === 0, 'Customers has empty fks array (no FKs)').toBe(true);

  // Orders should have FK data on node
  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  expect(ordersNode !== undefined, 'Orders node found').toBe(true);
  expect((ordersNode?.fks?.length ?? 0) > 0, 'Orders has FK constraints').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.name === 'FK_Orders_Customers'), 'Orders has FK_Orders_Customers').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.name === 'FK_Orders_Products'), 'Orders has FK_Orders_Products').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.onDelete === 'CASCADE'), 'Orders FK has CASCADE on delete').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.refTable === 'Customers'), 'Orders FK references Customers').toBe(true);

  // Products.Id should have CK flag
  const productsNode = model.nodes.find(n => n.name === 'Products');
  expect(productsNode !== undefined, 'Products node found').toBe(true);
  expect(!!productsNode?.columns?.some(c => c.check !== undefined && c.check !== ''), 'Products has CK flag on column').toBe(true);

  // ── No constraints result (dacpac-path compat) ──
  const noConstraintResults = buildSyntheticResults();  // no constraints field
  const noConstraintModel = buildModelFromDmv(noConstraintResults);
  const ordersNoConst = noConstraintModel.nodes.find(n => n.name === 'Orders');
  expect(ordersNoConst !== undefined, 'Orders node found without constraints').toBe(true);
  expect(ordersNoConst?.fks === undefined || ordersNoConst.fks.length === 0, 'No FKs when constraints absent').toBe(true);
  expect(!ordersNoConst?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'No UQ flags when constraints absent').toBe(true);
  expect(!!ordersNoConst?.columns?.some(c => c.name === 'OrderId'), 'Columns still present without constraints').toBe(true);
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
  expect(crossDbNode !== undefined, 'CrossDB-DMV: virtual db node created from referenced_database').toBe(true);
  // DMV metadata path lowercases all parts (modelBuilder.ts L705)
  expect(crossDbNode?.externalDatabase?.toLowerCase(), 'CrossDB-DMV: externalDatabase set correctly').toBe('archivedb');
  expect(crossDbNode?.schema, 'CrossDB-DMV: virtual node has empty schema').toBe('');
  expect(crossDbNode!.name.toLowerCase().includes('archivedsales'), 'CrossDB-DMV: virtual node name includes object name').toBe(true);

  // Edge: SP → cross-DB node (cross-DB is a source in the SP body, so cross-DB → SP)
  const crossDbEdge = model.edges.find(e =>
    e.target === '[dbo].[sploadfromarchive]' && e.source === crossDbNode!.id
  );
  expect(crossDbEdge !== undefined,
    `CrossDB-DMV: cross-DB → SP edge exists (edges: ${model.edges.map(e => `${e.source}→${e.target}`).join(', ')})`).toBe(true);

  // Local edge still works: SP writes to Sales
  const localEdge = model.edges.find(e =>
    e.source === '[dbo].[sploadfromarchive]' && e.target === '[dbo].[sales]'
  );
  expect(localEdge !== undefined, 'CrossDB-DMV: local SP → Sales write edge exists').toBe(true);

  // Total: 2 real + 1 virtual = 3 nodes
  expect(model.nodes.length, 'CrossDB-DMV: 2 real + 1 virtual = 3 nodes').toBe(3);
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
  expect(crossDbNode === undefined, 'CrossDB-SameDB: no virtual node when referenced_database = currentDatabase').toBe(true);
  expect(model.nodes.length, 'CrossDB-SameDB: only 3 real nodes').toBe(3);
}

// These eleven ran here as bare calls in the `describe` body — during collection, not as
// tests. Their assertions executed but were attributed to no test, so the reporter said
// "6 tests" for a file holding seventeen, and a failure surfaced as a collection error
// naming no case. Each is now its own `it`.
it('builds a model from DMV results', testBuildModelFromDmv);
it('validates query results against their required columns', testValidateQueryResult);
it('formats column types', testFormatColumnType);
it('falls back to body-derived edge direction', testFallbackBodyDirection);
it('leaves an unresolved cross-schema reference unresolved', testCrossSchemaUnresolved);
it('resolves a cross-schema reference known to the catalog', testCrossSchemaKnownViaCatalog);
it('creates external table nodes', testExternalTableNodes);
it('preserves external table write direction', testExternalTableWriteDirection);
it('derives cross-database dependencies from DMV rows', testCrossDbDepsFromDmv);
it('suppresses a cross-database reference to the current database', testCrossDbSameDbSuppression);
it('enriches columns from constraint maps', testConstraintMapsEnrichColumns);

// ─── expandSchemaPlaceholder ──────────────────────────────────────────────────

function testExpandSchemaPlaceholder() {
  console.log('\n── expandSchemaPlaceholder ──');

  // Basic expansion
  const sql = `SELECT * FROM sys.objects o\nINNER JOIN sys.schemas s ON o.schema_id = s.schema_id\nWHERE s.name IN ({{SCHEMAS}})`;
  const expanded = expandSchemaPlaceholder(sql, ['dbo', 'Sales']);
  expect(expanded.includes("s.name IN ('dbo', 'Sales')"), 'Basic: schema list expanded').toBe(true);
  expect(!expanded.includes('{{SCHEMAS}}'), 'Basic: no placeholder remnants').toBe(true);

  // Multiple placeholders (dependencies-style OR)
  const depsSql = `SELECT * FROM sys.sql_expression_dependencies d\nWHERE (s1.name IN ({{SCHEMAS}}) OR d.referenced_schema_name IN ({{SCHEMAS}}))`;
  const expandedDeps = expandSchemaPlaceholder(depsSql, ['dbo']);
  expect(expandedDeps.includes("s1.name IN ('dbo')"), 'Multi: first placeholder expanded').toBe(true);
  expect(expandedDeps.includes("d.referenced_schema_name IN ('dbo')"), 'Multi: second placeholder expanded').toBe(true);
  expect(!expandedDeps.includes('{{SCHEMAS}}'), 'Multi: no placeholder remnants').toBe(true);

  // No placeholder — returns SQL unchanged
  const noPlaceholder = `SELECT * FROM sys.objects`;
  const unchanged = expandSchemaPlaceholder(noPlaceholder, ['dbo']);
  expect(unchanged === noPlaceholder, 'No placeholder: SQL unchanged').toBe(true);

  // SQL injection: single quote in schema name
  const injected = expandSchemaPlaceholder(sql, ["O'Brien"]);
  expect(injected.includes("'O''Brien'"), 'SQL injection: single quote escaped').toBe(true);

  // Empty schema list
  const empty = expandSchemaPlaceholder(sql, []);
  expect(empty.includes('s.name IN ()'), 'Empty: produces IN ()').toBe(true);

  // validateSchemaPlaceholder: Phase 2 without placeholder → warning; Phase 1 → no warning
  expect(validateSchemaPlaceholder('q', 'SELECT 1', 2) !== undefined, 'Phase 2 no placeholder → warning').toBe(true);
  expect(validateSchemaPlaceholder('q', 'WHERE IN ({{SCHEMAS}})', 2) === undefined, 'Phase 2 with placeholder → ok').toBe(true);
  expect(validateSchemaPlaceholder('q', 'SELECT 1', 1) === undefined, 'Phase 1 no placeholder → ok').toBe(true);
}

function testYamlQueriesHavePlaceholder() {
  console.log('\n── YAML queries: Phase 2 placeholder validation ──');

  // Load the ACTUAL dmvQueries.yaml and validate all Phase 2 queries have {{SCHEMAS}}
  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };

  const phase2 = config.queries.filter(q => (q.phase ?? 2) !== 1);
  expect(phase2.length >= 4, `At least 4 Phase 2 queries (got ${phase2.length})`).toBe(true);

  for (const q of phase2) {
    expect(q.sql.includes('{{SCHEMAS}}'), `YAML Phase 2 query '${q.name}' has {{SCHEMAS}} placeholder`).toBe(true);

    // Expand and verify no remnants
    const expanded = expandSchemaPlaceholder(q.sql, ['dbo', 'Sales']);
    expect(!expanded.includes('{{SCHEMAS}}'), `YAML '${q.name}': no placeholder remnants after expansion`).toBe(true);
  }

  // Phase 1 queries should NOT have placeholder
  const phase1 = config.queries.filter(q => q.phase === 1);
  expect(phase1.length >= 2, `At least 2 Phase 1 queries (got ${phase1.length})`).toBe(true);
  for (const q of phase1) {
    expect(!q.sql.includes('{{SCHEMAS}}'), `YAML Phase 1 query '${q.name}' has no placeholder`).toBe(true);
  }
}

function testPhase2QueryPredicate() {
  console.log('\n── isPhase2Query: sweep membership and progress step count ──');

  // The bridge sizes its progress counter from this predicate and the sweep selects work with
  // it. If the two ever diverge, the counter over- or under-reports and the platform step
  // would be numbered against the wrong total.
  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };

  const sweep = config.queries.filter(q => isPhase2Query(q as DmvQuery));
  const excluded = config.queries.filter(q => !isPhase2Query(q as DmvQuery)).map(q => q.name);

  expect(!sweep.some(q => q.name === 'platform-info'),
    'platform-info is excluded from the Phase 2 sweep despite running at Phase 2 time').toBe(true);
  expect(!sweep.some(q => q.name === 'schema-preview'),
    'schema-preview is excluded from the Phase 2 sweep').toBe(true);
  expect(excluded.includes('platform-info') && excluded.includes('schema-preview'),
    `Excluded set is exactly the phase-1-tagged queries (got: ${JSON.stringify(excluded)})`).toBe(true);

  for (const name of ['nodes', 'columns', 'dependencies']) {
    expect(sweep.some(q => q.name === name), `Required query '${name}' is in the sweep`).toBe(true);
  }

  // A query with no explicit phase defaults into the sweep.
  expect(isPhase2Query({ name: 'custom', description: '', sql: '' }),
    'Untagged query defaults to Phase 2').toBe(true);
  expect(!isPhase2Query({ name: 'custom', description: '', sql: '', phase: 1 }),
    'phase: 1 query is excluded').toBe(true);

  // The bridge reports sweep length + 1 to account for the platform-detection step.
  expect(sweep.length + 1,
    'Progress total = sweep size + 1 platform step').toBe(config.queries.length - excluded.length + 1);
}

function testExpandedSqlStructure() {
  console.log('\n── Expanded SQL structural validation ──');

  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };
  const phase2 = config.queries.filter(q => (q.phase ?? 2) !== 1);

  for (const q of phase2) {
    const expanded = expandSchemaPlaceholder(q.sql, ['dbo', 'Sales']);

    // No literal {{ or }} remnants (catches partial expansion bugs)
    expect(!expanded.includes('{{'), `'${q.name}': no {{ remnants`).toBe(true);
    expect(!expanded.includes('}}'), `'${q.name}': no }} remnants`).toBe(true);

    // Balanced parentheses
    let depth = 0;
    let balanced = true;
    for (const ch of expanded) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth < 0) { balanced = false; break; }
    }
    expect(balanced && depth === 0, `'${q.name}': balanced parentheses (depth=${depth})`).toBe(true);

    // CTE queries must start with WITH and end with a SELECT
    if (/^\s*WITH\s+/i.test(q.sql)) {
      expect(/^\s*WITH\s+/i.test(expanded), `'${q.name}': CTE structure preserved after expansion`).toBe(true);
      expect(/\bSELECT\b/i.test(expanded), `'${q.name}': CTE has final SELECT`).toBe(true);
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
  expect(modelWithPlatform(makePlatformInfo(5,  0, '')).dbPlatform,        'EngineEdition 5 → Azure SQL Database').toBe('Azure SQL Database');
  expect(modelWithPlatform(makePlatformInfo(6,  0, '')).dbPlatform,     'EngineEdition 6 → Synapse Dedicated Pool').toBe('Synapse Dedicated Pool');
  expect(modelWithPlatform(makePlatformInfo(8,  0, '')).dbPlatform, 'EngineEdition 8 → Azure SQL Managed Instance').toBe('Azure SQL Managed Instance');
  expect(modelWithPlatform(makePlatformInfo(9,  0, '')).dbPlatform,              'EngineEdition 9 → Azure SQL Edge').toBe('Azure SQL Edge');
  expect(modelWithPlatform(makePlatformInfo(11, 0, '')).dbPlatform,      'EngineEdition 11 → Fabric Data Warehouse').toBe('Fabric Data Warehouse');
  expect(modelWithPlatform(makePlatformInfo(12, 0, '')).dbPlatform,     'EngineEdition 12 → SQL Database in Fabric').toBe('SQL Database in Fabric');

  // On-prem editions: representative versions (earliest, middle, latest)
  const onPremCases: [number, string][] = [
    [17, 'SQL Server 2025'],
    [13, 'SQL Server 2016'],
    [8,  'SQL Server 2000'],
  ];
  for (const [major, expected] of onPremCases) {
    const model = modelWithPlatform(makePlatformInfo(3, major, 'Enterprise Edition'));
    expect(model.dbPlatform, `EngineEdition 3, major ${major} → ${expected}`).toBe(expected);
  }

  // Unknown major version → fall back to edition string
  const unknownMajor = modelWithPlatform(makePlatformInfo(3, 99, 'Developer Edition'));
  expect(unknownMajor.dbPlatform,
    'Unknown major version → edition string fallback').toBe('Developer Edition');

  // Unknown edition AND unknown major → explicit unknown, never an invented SQL Server label
  const unknownAll = modelWithPlatform(makePlatformInfo(3, 99, ''));
  expect(unknownAll.dbPlatform,
    'Unknown edition + unknown major → explicit unknown platform').toBe('Unknown database platform');

  // No platform metadata → explicit unknown
  const noPlatform = buildModelFromDmv({ nodes: emptyNodes, columns: emptyCols, dependencies: emptyDeps });
  expect(noPlatform.dbPlatform, 'No platform metadata → explicit unknown').toBe('Unknown database platform');

  // Provenance is stamped by the lane, independent of whether a platform resolved.
  expect(noPlatform.source, 'DMV model without platform metadata: source = database').toBe('database');

  // Empty rows in platformInfo → explicit unknown
  const emptyRows = makeResult(cols('engine_edition', 'major_version', 'edition'), []);
  const noRows = modelWithPlatform(emptyRows);
  expect(noRows.dbPlatform, 'Empty platformInfo rows → explicit unknown').toBe('Unknown database platform');

  const serverInfo: IServerInfo = {
    serverMajorVersion: 16,
    serverMinorVersion: 0,
    serverVersion: '16.0.1000.6',
    engineEditionId: 3,
    isCloud: false,
    serverEdition: 'Developer Edition',
  };
  expect(mapServerInfoPlatform(serverInfo),
    'MSSQL server metadata uses the same platform mapping').toBe('SQL Server 2022');
  const serverFallback = buildModelFromDmv({
    nodes: emptyNodes,
    columns: emptyCols,
    dependencies: emptyDeps,
    serverPlatform: 'Fabric Data Warehouse',
  });
  expect(serverFallback.dbPlatform,
    'MSSQL server metadata is carried into the database model').toBe('Fabric Data Warehouse');
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
  expect(table !== undefined, 'OrderDetail table found').toBe(true);

  const orderId = table!.columns?.find(c => c.name === 'OrderId');
  expect(orderId !== undefined, 'OrderId column found').toBe(true);
  expect(orderId!.pkOrdinal, 'OrderId: pkOrdinal = 1').toBe(1);

  const lineId = table!.columns?.find(c => c.name === 'LineId');
  expect(lineId !== undefined, 'LineId column found').toBe(true);
  expect(lineId!.pkOrdinal, 'LineId: pkOrdinal = 2').toBe(2);

  const name = table!.columns?.find(c => c.name === 'Name');
  expect(name !== undefined, 'Name column found').toBe(true);
  expect(name!.pkOrdinal === undefined, 'Name: no pkOrdinal (not a PK column)').toBe(true);

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
  expect(productId?.pkOrdinal, 'Single PK: Id.pkOrdinal = 1').toBe(1);
  expect(product?.columns?.find(c => c.name === 'Name')?.pkOrdinal === undefined,
    'Single PK: Name column has no pkOrdinal').toBe(true);

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
  expect(legacyId !== undefined, 'Legacy: Id column found').toBe(true);
  expect(legacyId!.pkOrdinal === undefined, 'Legacy (no pk_ordinal col): pkOrdinal absent — no crash').toBe(true);
}

  it('expands schema placeholders', testExpandSchemaPlaceholder);
  it('keeps placeholders in configured queries', testYamlQueriesHavePlaceholder);
  it('classifies phase-two queries', testPhase2QueryPredicate);
  it('preserves expanded SQL structure', testExpandedSqlStructure);
  it('maps database platforms from DMV results', testDbPlatformFromDmv);
  it('maps primary-key ordinals from DMV results', testPkOrdinalFromDmv);
});
