/** DMV Extractor test — uses synthetic DMV data to verify model building. */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { buildModelFromDmv, validateQueryResult } from '../../../src/engine/dmvExtractor';
import { formatColumnType } from '../../../src/engine/types';
import type { DmvResults } from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult, DbCellValue, IDbColumn } from '../../../src/types/database';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../../../src/utils/sql';
import { isPhase2Query, type DmvQuery } from '../../../src/engine/connectionManager';
import { loadParseRules, rootPath } from '../helpers/testUtils';

describe('DMV Extractor', () => {
  loadParseRules();


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


const nodeFields = ['schema_name', 'object_name', 'type_code', 'body_script'];
const columnFields = ['schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'];
const dependencyFields = ['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'];
function rawResult(fields: string[], rows: (string | null)[][]): SimpleExecuteResult {
  return makeResult(cols(...fields), rows.map(row => row.map(value => value === null ? nullCell() : cell(value))));
}

function buildSyntheticResults(): DmvResults {
  const nodesCols = cols(...nodeFields);
  const nodesRows: DbCellValue[][] = [
    [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
    [cell('dbo'), cell('Orders'), cell('U '), nullCell()],
    [cell('dbo'), cell('Products'), cell('U '), nullCell()],
    [cell('dbo'), cell('vActiveCustomers'), cell('V '), cell('CREATE VIEW [dbo].[vActiveCustomers] AS\nSELECT * FROM [dbo].[Customers] WHERE Active = 1')],
    [cell('sales'), cell('uspGetOrdersByCustomer'), cell('P '), cell('CREATE PROCEDURE [sales].[uspGetOrdersByCustomer]\nAS\nSELECT o.* FROM [dbo].[Orders] o\nINNER JOIN [dbo].[Customers] c ON o.CustomerId = c.Id')],
    [cell('sales'), cell('uspCreateOrder'), cell('P '), cell('CREATE PROCEDURE [sales].[uspCreateOrder]\nAS\nINSERT INTO [dbo].[Orders] (CustomerId, ProductId)\nSELECT c.Id, p.Id FROM [dbo].[Customers] c\nCROSS JOIN [dbo].[Products] p')],
  ];

  const columnsCols = cols(...columnFields);
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

  const depsCols = cols(...dependencyFields);
  const depsRows: DbCellValue[][] = [
    [cell('dbo'), cell('vActiveCustomers'), cell('dbo'), cell('Customers')],
    [cell('sales'), cell('uspGetOrdersByCustomer'), cell('dbo'), cell('Orders')],
    [cell('sales'), cell('uspGetOrdersByCustomer'), cell('dbo'), cell('Customers')],
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


function testBuildModelFromDmv() {
  const results = buildSyntheticResults();
  const model = buildModelFromDmv(results);

  expect(model.nodes.length, 'Should have 6 nodes').toBe(6);
  const tables = model.nodes.filter(n => n.type === 'table');
  const views = model.nodes.filter(n => n.type === 'view');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  expect(tables.length, 'Should have 3 tables').toBe(3);
  expect(views.length, 'Should have 1 view').toBe(1);
  expect(procs.length, 'Should have 2 procedures').toBe(2);

  expect(model.schemas.length, 'Should have 2 schemas').toBe(2);
  const dboSchema = model.schemas.find(s => s.name === 'dbo');
  const salesSchema = model.schemas.find(s => s.name === 'sales');
  expect(dboSchema !== undefined, 'dbo schema found').toBe(true);
  expect(salesSchema !== undefined, 'sales schema found').toBe(true);
  expect(dboSchema!.nodeCount, 'dbo has 4 nodes').toBe(4);
  expect(salesSchema!.nodeCount, 'sales has 2 nodes').toBe(2);

  const customerNode = model.nodes.find(n => n.name === 'Customers');
  expect(customerNode?.id, 'Customer ID normalized to lowercase').toBe('[dbo].[customers]');
  expect(customerNode?.schema, 'Customer schema preserved in catalog-original casing').toBe('dbo');

  expect(Object.keys(model.catalog).length >= model.nodes.length, 'Catalog has at least one entry per node').toBe(true);
  expect(Object.keys(model.neighborIndex).length > 0, 'NeighborIndex populated').toBe(true);

  const viewId = '[dbo].[vactivecustomers]';
  expect(model.neighborIndex[viewId]?.in.includes('[dbo].[customers]'), 'neighborIndex: Customers → vActiveCustomers').toBe(true);
  expect(model.catalog['[dbo].[customers]']?.schema === 'dbo', 'catalog: Customers schema is dbo').toBe(true);

  expect(model.edges.length > 0, `Has ${model.edges.length} edges`).toBe(true);

  const viewEdge = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[dbo].[vactivecustomers]'
  );
  expect(viewEdge !== undefined, 'View has inbound edge from Customers').toBe(true);

  const spReadOrders = model.edges.find(e =>
    e.source === '[dbo].[orders]' && e.target === '[sales].[uspgetordersbycustomer]'
  );
  expect(spReadOrders !== undefined, 'SP uspGetOrdersByCustomer reads Orders').toBe(true);

  const spReadCustomers = model.edges.find(e =>
    e.source === '[dbo].[customers]' && e.target === '[sales].[uspgetordersbycustomer]'
  );
  expect(spReadCustomers !== undefined, 'SP uspGetOrdersByCustomer reads Customers').toBe(true);

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

  expect(model.parseStats !== undefined, 'Parse stats present').toBe(true);
  expect(model.parseStats!.spDetails.length, '2 SPs in parse details').toBe(2);

  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  expect(!!ordersNode?.columns?.some(c => c.name === 'OrderId'), 'Orders table has OrderId column').toBe(true);
  expect(!!ordersNode?.columns?.some(c => c.type.includes('int')), 'Orders table has int type column').toBe(true);

  expect(model.warnings === undefined, 'No warnings for valid data').toBe(true);

  const emptyResults: DmvResults = {
    nodes: makeResult(cols(...nodeFields), []),
    columns: makeResult(cols(...columnFields), []),
    dependencies: makeResult(cols(...dependencyFields), []),
  };
  const emptyModel = buildModelFromDmv(emptyResults);
  expect(emptyModel.nodes.length, 'Empty DB has 0 nodes').toBe(0);
  expect(emptyModel.edges.length, 'Empty DB has 0 edges').toBe(0);
  expect(emptyModel.warnings !== undefined && emptyModel.warnings.length > 0, 'Empty DB produces warning').toBe(true);

  const nodeCols = cols(...nodeFields);
  const dupResults: DmvResults = {
    nodes: makeResult(nodeCols, [
      [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
      [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
    ]),
    columns: makeResult(cols(...columnFields), []),
    dependencies: makeResult(cols(...dependencyFields), []),
  };
  expect(buildModelFromDmv(dupResults).nodes.length, 'Duplicate nodes are deduplicated').toBe(1);

  const selfRefResults: DmvResults = {
    nodes: makeResult(nodeCols, [[cell('dbo'), cell('MyTable'), cell('U '), nullCell()]]),
    columns: makeResult(cols(...columnFields), []),
    dependencies: makeResult(cols(...dependencyFields),
      [[cell('dbo'), cell('MyTable'), cell('dbo'), cell('MyTable')]]),
  };
  expect(buildModelFromDmv(selfRefResults).edges.length, 'Self-references produce no edges').toBe(0);
}

function testValidateQueryResult() {

  const validCases: [string, string[]][] = [
    ['nodes', ['schema_name', 'object_name', 'type_code', 'body_script']],
    ['dependencies', ['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name']],
    ['constraints', ['schema_name', 'table_name', 'constraint_type', 'constraint_name', 'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete']],
    ['platform-info', ['engine_edition', 'major_version', 'edition']],
  ];
  for (const [name, colNames] of validCases) {
    expect(validateQueryResult(name, makeResult(cols(...colNames), [])).length, `Valid ${name}: no missing`).toBe(0);
  }

  const missing = validateQueryResult('nodes', makeResult(cols('schema_name', 'object_name'), []));
  expect(missing.length, 'Invalid nodes: 2 missing').toBe(2);
  expect(
    validateQueryResult('platform-info', makeResult(cols('engine_edition'), [])).length,
    'Invalid platform-info: 2 missing',
  ).toBe(2);

  expect(validateQueryResult('nodes', makeResult(cols('Schema_Name', 'Object_Name', 'Type_Code', 'Body_Script'), [])).length, 'Case-insensitive').toBe(0);

  expect(validateQueryResult('unknown', makeResult(cols(), [])).length, 'Unknown query: no missing').toBe(0);
}

function testFormatColumnType() {

  const cases: [string, string, string, string, string][] = [
    ['int',       '4',   '10', '0', 'int'],
    ['bigint',    '8',   '19', '0', 'bigint'],
    ['bit',       '1',   '1',  '0', 'bit'],
    ['datetime',  '8',   '23', '3', 'datetime'],
    ['varchar',   '50',  '0',  '0', 'varchar(50)'],
    ['varchar',   '-1',  '0',  '0', 'varchar(max)'],
    ['nvarchar',  '200', '0',  '0', 'nvarchar(100)'],  // bytes ÷ 2
    ['nvarchar',  '-1',  '0',  '0', 'nvarchar(max)'],
    ['nchar',     '20',  '0',  '0', 'nchar(10)'],      // bytes ÷ 2
    ['varbinary', '-1',  '0',  '0', 'varbinary(max)'],
    ['decimal',   '9',   '18', '2', 'decimal(18,2)'],
    ['numeric',   '9',   '10', '0', 'numeric(10,0)'],
  ];
  for (const [type, len, prec, scale, expected] of cases) {
    expect(formatColumnType(type, len, prec, scale), expected).toBe(expected);
  }
}

function testCrossSchemaUnresolved() {

  const nodesCols = cols(...nodeFields);
  const nodesRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P '),
      cell('CREATE PROCEDURE [HumanResources].[uspUpdateEmployeePersonalInfo] AS BEGIN EXECUTE [dbo].[uspLogError]; END')],
  ];

  const depsCols = cols(...dependencyFields);
  const depsRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('dbo'), cell('uspLogError')],
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols(...columnFields), []),
    dependencies: makeResult(depsCols, depsRows),
  };

  const model = buildModelFromDmv(results);

  const detail = model.parseStats?.spDetails.find(d => d.name.toLowerCase() === 'humanresources.uspupdateemployeepersonalinfo');
  expect(detail !== undefined, 'spDetails entry found for SP').toBe(true);
  const hasUnresolved = detail?.unrelated.some(r => r.toLowerCase().includes('usplogerror'));
  expect(hasUnresolved === true,
    `spDetails.unrelated contains uspLogError (got: ${JSON.stringify(detail?.unrelated)})`).toBe(true);

  const logErrId = '[dbo].[usplogerror]';
  expect(model.neighborIndex[logErrId] === undefined,
    'No neighborIndex entry for unknown dbo.uspLogError').toBe(true);
}


function testCrossSchemaKnownViaCatalog() {

  const nodesCols = cols(...nodeFields);
  const nodesRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P '),
      cell('CREATE PROCEDURE [HumanResources].[uspUpdateEmployeePersonalInfo] AS BEGIN EXECUTE [dbo].[uspLogError]; END')],
  ];

  const depsCols = cols(...dependencyFields);
  const depsRows: DbCellValue[][] = [
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('dbo'), cell('uspLogError')],
  ];

  const allObjectsCols = cols('schema_name', 'object_name', 'type_code');
  const allObjectsRows: DbCellValue[][] = [
    [cell('dbo'), cell('uspLogError'), cell('P ')],
    [cell('HumanResources'), cell('uspUpdateEmployeePersonalInfo'), cell('P ')],
  ];

  const results: DmvResults = {
    nodes: makeResult(nodesCols, nodesRows),
    columns: makeResult(cols(...columnFields), []),
    dependencies: makeResult(depsCols, depsRows),
    allObjects: makeResult(allObjectsCols, allObjectsRows),
  };

  const model = buildModelFromDmv(results);

  const spId = '[humanresources].[uspupdateemployeepersonalinfo]';
  const logErrId = '[dbo].[usplogerror]';

  const detail = model.parseStats?.spDetails.find(d => d.name.toLowerCase() === 'humanresources.uspupdateemployeepersonalinfo');
  expect(detail !== undefined, 'spDetails entry found for SP').toBe(true);
  expect(detail!.unrelated.every(r => !r.toLowerCase().includes('usplogerror')),
    `spDetails.unrelated must NOT contain uspLogError (got: ${JSON.stringify(detail?.unrelated)})`).toBe(true);

  const logErrNeighbors = model.neighborIndex[logErrId];
  expect(logErrNeighbors !== undefined, 'neighborIndex entry exists for known dbo.uspLogError').toBe(true);
  const linked = [...(logErrNeighbors?.in ?? []), ...(logErrNeighbors?.out ?? [])];
  expect(linked.includes(spId),
    `dbo.uspLogError is linked to the SP in the neighbor index (got: ${JSON.stringify(logErrNeighbors)})`).toBe(true);
}


it.each([
  {
    name: 'creates external table nodes', table: 'LocalOrders', external: 'ExternalSales', procedure: 'uspLoadSales',
    sql: 'CREATE PROCEDURE [dbo].[uspLoadSales] AS\nINSERT INTO [dbo].[LocalOrders]\nSELECT * FROM [ext].[ExternalSales]',
    externalId: '[ext].[externalsales]', procedureId: '[dbo].[usploadsales]', direction: 'out' as const,
    edges: [['[ext].[externalsales]', '[dbo].[usploadsales]'], ['[dbo].[usploadsales]', '[dbo].[localorders]']],
  },
  {
    name: 'preserves external table write direction', table: 'SourceData', external: 'ExportTarget', procedure: 'uspExportData',
    sql: 'CREATE PROCEDURE [dbo].[uspExportData] AS\nINSERT INTO [ext].[ExportTarget]\nSELECT * FROM [dbo].[SourceData]',
    externalId: '[ext].[exporttarget]', procedureId: '[dbo].[uspexportdata]', direction: 'in' as const,
    edges: [['[dbo].[uspexportdata]', '[ext].[exporttarget]'], ['[dbo].[sourcedata]', '[dbo].[uspexportdata]']],
  },
])('$name', ({ table, external, procedure, sql, externalId, procedureId, direction, edges }) => {
  const model = buildModelFromDmv({
    nodes: rawResult(nodeFields, [['dbo', table, 'U ', null], ['ext', external, 'ET', null], ['dbo', procedure, 'P ', sql]]),
    columns: rawResult(columnFields, []),
    dependencies: rawResult(dependencyFields, [['dbo', procedure, 'dbo', table], ['dbo', procedure, 'ext', external]]),
  });
  expect(model.nodes).toHaveLength(3);
  const externalNodes = model.nodes.filter(n => n.type === 'external');
  expect(externalNodes).toHaveLength(1);
  const externalNode = externalNodes[0];
  expect(externalNode).toMatchObject({ schema: 'ext', name: external, id: externalId, externalType: 'et' });
  expect(externalNode.bodyScript == null, 'External table has no SQL body').toBe(true);
  expect(model.schemas.find(schema => schema.name === 'ext')?.types?.external).toBe(1);
  expect(model.catalog[externalId]?.type).toBe('external');
  for (const [source, target] of edges) {
    expect(model.edges, `${source} → ${target}`).toEqual(expect.arrayContaining([expect.objectContaining({ source, target })]));
  }
  expect(model.neighborIndex[externalId]?.[direction]).toContain(procedureId);
});


function buildConstraintsResult(): SimpleExecuteResult {
  const constraintCols = cols(
    'schema_name', 'table_name', 'constraint_type', 'constraint_name',
    'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete',
  );
  const rows: DbCellValue[][] = [
    [cell('dbo'), cell('Orders'), cell('FK'), cell('FK_Orders_Customers'),
      cell('CustomerId'), cell('1'), cell('dbo'), cell('Customers'), cell('Id'), cell('NO ACTION')],
    [cell('dbo'), cell('Orders'), cell('FK'), cell('FK_Orders_Products'),
      cell('ProductId'), cell('1'), cell('dbo'), cell('Products'), cell('Id'), cell('CASCADE')],
    [cell('dbo'), cell('Customers'), cell('UQ'), cell('UQ_Customers_Name'),
      cell('Name'), cell('1'), nullCell(), nullCell(), nullCell(), nullCell()],
    [cell('dbo'), cell('Products'), cell('CK'), cell('CK_Products_Id'),
      cell('Id'), nullCell(), nullCell(), nullCell(), nullCell(), nullCell()],
  ];
  return makeResult(constraintCols, rows);
}

function testConstraintMapsEnrichColumns() {

  const baseResults = buildSyntheticResults();
  const resultsWithConstraints: DmvResults = {
    ...baseResults,
    constraints: buildConstraintsResult(),
  };
  const model = buildModelFromDmv(resultsWithConstraints);

  const customersNode = model.nodes.find(n => n.name === 'Customers');
  expect(customersNode !== undefined, 'Customers node found').toBe(true);
  expect(!!customersNode?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'Customers has UQ flag on column').toBe(true);
  expect(customersNode?.fks !== undefined && customersNode.fks.length === 0, 'Customers has empty fks array (no FKs)').toBe(true);

  const ordersNode = model.nodes.find(n => n.name === 'Orders');
  expect(ordersNode !== undefined, 'Orders node found').toBe(true);
  expect((ordersNode?.fks?.length ?? 0) > 0, 'Orders has FK constraints').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.name === 'FK_Orders_Customers'), 'Orders has FK_Orders_Customers').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.name === 'FK_Orders_Products'), 'Orders has FK_Orders_Products').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.onDelete === 'CASCADE'), 'Orders FK has CASCADE on delete').toBe(true);
  expect(ordersNode!.fks!.some(fk => fk.refTable === 'Customers'), 'Orders FK references Customers').toBe(true);

  const productsNode = model.nodes.find(n => n.name === 'Products');
  expect(productsNode !== undefined, 'Products node found').toBe(true);
  expect(!!productsNode?.columns?.some(c => c.check !== undefined && c.check !== ''), 'Products has CK flag on column').toBe(true);

  const noConstraintResults = buildSyntheticResults();  // no constraints field
  const noConstraintModel = buildModelFromDmv(noConstraintResults);
  const ordersNoConst = noConstraintModel.nodes.find(n => n.name === 'Orders');
  expect(ordersNoConst !== undefined, 'Orders node found without constraints').toBe(true);
  expect(ordersNoConst?.fks === undefined || ordersNoConst.fks.length === 0, 'No FKs when constraints absent').toBe(true);
  expect(!ordersNoConst?.columns?.some(c => c.unique !== undefined && c.unique !== ''), 'No UQ flags when constraints absent').toBe(true);
  expect(!!ordersNoConst?.columns?.some(c => c.name === 'OrderId'), 'Columns still present without constraints').toBe(true);
}


it('maps referenced_database rows to three-part dependencies resolved against the current database', () => {
  const model = buildModelFromDmv({
    nodes: rawResult(nodeFields, [['dbo', 'Sales', 'U ', null], ['dbo', 'spLoad', 'P ', 'CREATE PROCEDURE [dbo].[spLoad] AS SELECT 1']]),
    columns: rawResult(columnFields, []),
    dependencies: rawResult([...dependencyFields, 'referenced_database'], [['dbo', 'spLoad', 'dbo', 'ArchivedSales', 'ArchiveDB'], ['dbo', 'spLoad', 'dbo', 'Sales', 'MyDB']]),
  }, 'MyDB');
  expect(model.nodes.filter(n => n.externalType === 'db').map(n => n.id)).toEqual(['[archivedb].[dbo].[archivedsales]']);
  expect(model.edges.map(e => `${e.source} -> ${e.target}`).sort()).toEqual(['[archivedb].[dbo].[archivedsales] -> [dbo].[spload]', '[dbo].[sales] -> [dbo].[spload]']);
});

it('builds a model from DMV results', testBuildModelFromDmv);
it('validates query results against their required columns', testValidateQueryResult);
it('formats column types', testFormatColumnType);
it('leaves an unresolved cross-schema reference unresolved', testCrossSchemaUnresolved);
it('resolves a cross-schema reference known to the catalog', testCrossSchemaKnownViaCatalog);
it('enriches columns from constraint maps', testConstraintMapsEnrichColumns);


function testExpandSchemaPlaceholder() {

  const sql = `SELECT * FROM sys.objects o\nINNER JOIN sys.schemas s ON o.schema_id = s.schema_id\nWHERE s.name IN ({{SCHEMAS}})`;
  const expanded = expandSchemaPlaceholder(sql, ['dbo', 'Sales']);
  expect(expanded.includes("s.name IN (N'dbo', N'Sales')"), 'Basic: schema list expanded as Unicode literals').toBe(true);
  expect(!expanded.includes('{{SCHEMAS}}'), 'Basic: no placeholder remnants').toBe(true);

  const depsSql = `SELECT * FROM sys.sql_expression_dependencies d\nWHERE (s1.name IN ({{SCHEMAS}}) OR d.referenced_schema_name IN ({{SCHEMAS}}))`;
  const expandedDeps = expandSchemaPlaceholder(depsSql, ['dbo']);
  expect(expandedDeps.includes("s1.name IN (N'dbo')"), 'Multi: first placeholder expanded').toBe(true);
  expect(expandedDeps.includes("d.referenced_schema_name IN (N'dbo')"), 'Multi: second placeholder expanded').toBe(true);
  expect(!expandedDeps.includes('{{SCHEMAS}}'), 'Multi: no placeholder remnants').toBe(true);

  const noPlaceholder = `SELECT * FROM sys.objects`;
  const unchanged = expandSchemaPlaceholder(noPlaceholder, ['dbo']);
  expect(unchanged === noPlaceholder, 'No placeholder: SQL unchanged').toBe(true);

  const injected = expandSchemaPlaceholder(sql, ["O'Brien"]);
  expect(injected.includes("N'O''Brien'"), 'SQL injection: single quote escaped').toBe(true);

  const unicode = expandSchemaPlaceholder(sql, ['Ärger日本']);
  expect(unicode.includes("N'Ärger日本'"), 'Unicode: a non-ASCII schema name keeps its characters (N literal)').toBe(true);

  const empty = expandSchemaPlaceholder(sql, []);
  expect(empty.includes('s.name IN ()'), 'Empty: produces IN ()').toBe(true);

  expect(validateSchemaPlaceholder('q', 'SELECT 1', 2) !== undefined, 'Phase 2 no placeholder → warning').toBe(true);
  expect(validateSchemaPlaceholder('q', 'WHERE IN ({{SCHEMAS}})', 2) === undefined, 'Phase 2 with placeholder → ok').toBe(true);
  expect(validateSchemaPlaceholder('q', 'SELECT 1', 1) === undefined, 'Phase 1 no placeholder → ok').toBe(true);
}

function testYamlQueriesHavePlaceholder() {

  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };

  const phase2 = config.queries.filter(q => (q.phase ?? 2) !== 1);
  expect(phase2.length >= 4, `At least 4 Phase 2 queries (got ${phase2.length})`).toBe(true);

  for (const q of phase2) {
    expect(q.sql.includes('{{SCHEMAS}}'), `YAML Phase 2 query '${q.name}' has {{SCHEMAS}} placeholder`).toBe(true);

    const expanded = expandSchemaPlaceholder(q.sql, ['dbo', 'Sales']);
    expect(!expanded.includes('{{SCHEMAS}}'), `YAML '${q.name}': no placeholder remnants after expansion`).toBe(true);
  }

  const phase1 = config.queries.filter(q => q.phase === 1);
  expect(phase1.length >= 2, `At least 2 Phase 1 queries (got ${phase1.length})`).toBe(true);
  for (const q of phase1) {
    expect(!q.sql.includes('{{SCHEMAS}}'), `YAML Phase 1 query '${q.name}' has no placeholder`).toBe(true);
  }
}

function testPhase2QueryPredicate() {

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

  expect(isPhase2Query({ name: 'custom', description: '', sql: '' }),
    'Untagged query defaults to Phase 2').toBe(true);
  expect(!isPhase2Query({ name: 'custom', description: '', sql: '', phase: 1 }),
    'phase: 1 query is excluded').toBe(true);

  expect(sweep.length + 1,
    'Progress total = sweep size + 1 platform step').toBe(config.queries.length - excluded.length + 1);
}

function testExpandedSqlStructure() {

  const yamlContent = readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8');
  const config = yaml.load(yamlContent) as { queries: Array<{ name: string; sql: string; phase?: number }> };
  const phase2 = config.queries.filter(q => (q.phase ?? 2) !== 1);

  for (const q of phase2) {
    const expanded = expandSchemaPlaceholder(q.sql, ['dbo', 'Sales']);

    expect(!expanded.includes('{{'), `'${q.name}': no {{ remnants`).toBe(true);
    expect(!expanded.includes('}}'), `'${q.name}': no }} remnants`).toBe(true);

    let depth = 0;
    let balanced = true;
    for (const ch of expanded) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth < 0) { balanced = false; break; }
    }
    expect(balanced && depth === 0, `'${q.name}': balanced parentheses (depth=${depth})`).toBe(true);

    if (/^\s*WITH\s+/i.test(q.sql)) {
      expect(/^\s*WITH\s+/i.test(expanded), `'${q.name}': CTE structure preserved after expansion`).toBe(true);
      expect(/\bSELECT\b/i.test(expanded), `'${q.name}': CTE has final SELECT`).toBe(true);
    }
  }
}


function makePlatformInfo(engineEdition: number, majorVersion: number, edition: string): SimpleExecuteResult {
  return makeResult(
    cols('engine_edition', 'major_version', 'edition'),
    [[cell(String(engineEdition)), cell(String(majorVersion)), cell(edition)]],
  );
}

function testDbPlatformFromDmv() {

  const emptyNodes = makeResult(cols(...nodeFields), []);
  const emptyCols = makeResult(cols(...columnFields), []);
  const emptyDeps = makeResult(cols(...dependencyFields), []);

  function modelWithPlatform(platformInfo: SimpleExecuteResult) {
    return buildModelFromDmv({ nodes: emptyNodes, columns: emptyCols, dependencies: emptyDeps, platformInfo });
  }

  expect(modelWithPlatform(makePlatformInfo(5,  0, '')).dbPlatform,        'EngineEdition 5 → Azure SQL Database').toBe('Azure SQL Database');
  expect(modelWithPlatform(makePlatformInfo(6,  0, '')).dbPlatform,     'EngineEdition 6 → Synapse Dedicated Pool').toBe('Synapse Dedicated Pool');
  expect(modelWithPlatform(makePlatformInfo(8,  0, '')).dbPlatform, 'EngineEdition 8 → Azure SQL Managed Instance').toBe('Azure SQL Managed Instance');
  expect(modelWithPlatform(makePlatformInfo(9,  0, '')).dbPlatform,              'EngineEdition 9 → Azure SQL Edge').toBe('Azure SQL Edge');
  expect(modelWithPlatform(makePlatformInfo(11, 0, '')).dbPlatform,      'EngineEdition 11 → Fabric Data Warehouse').toBe('Fabric Data Warehouse');
  expect(modelWithPlatform(makePlatformInfo(12, 0, '')).dbPlatform,     'EngineEdition 12 → SQL Database in Fabric').toBe('SQL Database in Fabric');

  const onPremCases: [number, string][] = [
    [17, 'SQL Server 2025'],
    [13, 'SQL Server 2016'],
    [8,  'SQL Server 2000'],
  ];
  for (const [major, expected] of onPremCases) {
    const model = modelWithPlatform(makePlatformInfo(3, major, 'Enterprise Edition'));
    expect(model.dbPlatform, `EngineEdition 3, major ${major} → ${expected}`).toBe(expected);
  }

  const unknownMajor = modelWithPlatform(makePlatformInfo(3, 99, 'Developer Edition'));
  expect(unknownMajor.dbPlatform,
    'Unknown major version → edition string fallback').toBe('Developer Edition');

  const unknownAll = modelWithPlatform(makePlatformInfo(3, 99, ''));
  expect(unknownAll.dbPlatform,
    'Unknown edition + unknown major → explicit unknown platform').toBe('Unknown database platform');

  const noPlatform = buildModelFromDmv({ nodes: emptyNodes, columns: emptyCols, dependencies: emptyDeps });
  expect(noPlatform.dbPlatform, 'No platform metadata → explicit unknown').toBe('Unknown database platform');

  expect(noPlatform.source, 'DMV model without platform metadata: source = database').toBe('database');

  const emptyRows = makeResult(cols('engine_edition', 'major_version', 'edition'), []);
  const noRows = modelWithPlatform(emptyRows);
  expect(noRows.dbPlatform, 'Empty platformInfo rows → explicit unknown').toBe('Unknown database platform');


}


it.each([
  {
    table: 'OrderDetail', hasPkField: true,
    rows: [
      ['1', 'OrderId', 'int', '4', '10', '0', '0', '0', '0', '1'],
      ['2', 'LineId', 'int', '4', '10', '0', '0', '0', '0', '2'],
      ['3', 'Name', 'nvarchar', '200', '0', '0', '1', '0', '0', null],
    ],
    expected: [['OrderId', 1], ['LineId', 2], ['Name', undefined]],
  },
  {
    table: 'Product', hasPkField: true,
    rows: [
      ['1', 'Id', 'int', '4', '10', '0', '0', '1', '0', '1'],
      ['2', 'Name', 'nvarchar', '200', '0', '0', '1', '0', '0', null],
    ],
    expected: [['Id', 1], ['Name', undefined]],
  },
  {
    table: 'Legacy', hasPkField: false,
    rows: [['1', 'Id', 'int', '4', '10', '0', '0', '1', '0']],
    expected: [['Id', undefined]],
  },
])('maps primary-key ordinals for $table (pk_ordinal field: $hasPkField)', ({ table, hasPkField, rows, expected }) => {
  const model = buildModelFromDmv({
    nodes: rawResult(nodeFields, [['dbo', table, 'U ', null]]),
    columns: rawResult(hasPkField ? [...columnFields, 'pk_ordinal'] : columnFields, rows.map(row => ['dbo', table, ...row])),
    dependencies: rawResult(dependencyFields, []),
  });
  const tableNode = model.nodes.find(node => node.name === table);
  expect(tableNode, `${table} table exists`).toBeDefined();
  for (const [name, pkOrdinal] of expected) {
    const column = tableNode!.columns?.find(column => column.name === name);
    expect(column, `${table}.${name} exists`).toBeDefined();
    expect(column!.pkOrdinal, `${table}.${name} primary-key ordinal`).toBe(pkOrdinal);
  }
});

  it('keeps "]" in object, schema, column and dependency names', () => {
    const results: DmvResults = {
      nodes: makeResult(cols(...nodeFields), [
        [cell('we]ird'), cell('t]x'), cell('U '), nullCell()],
        [cell('dbo'), cell('vSrc'), cell('V '), cell('SELECT 1')],
      ]),
      columns: makeResult(cols(...columnFields), [
        [cell('we]ird'), cell('t]x'), cell('1'), cell('c]1'), cell('int'), cell('4'), cell('10'), cell('0'), cell('1'), cell('0'), cell('0')],
      ]),
      dependencies: makeResult(cols(...dependencyFields), [
        [cell('dbo'), cell('vSrc'), cell('we]ird'), cell('t]x')],
      ]),
    };
    const model = buildModelFromDmv(results);
    const table = model.nodes.find(n => n.type === 'table');
    expect(table?.schema).toBe('we]ird');
    expect(table?.name).toBe('t]x');
    expect(table?.id).toBe('[we]]ird].[t]]x]');
    expect(table?.columns?.map(c => c.name)).toEqual(['c]1']);
    expect(model.schemas.map(s => s.name)).toContain('we]ird');
    expect(model.edges.map(e => `${e.source} -> ${e.target}`)).toContain('[we]]ird].[t]]x] -> [dbo].[vsrc]');
  });

  it('the columns query names a CLR type through its user type', () => {
    const config = yaml.load(readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8')) as { queries: Array<{ name: string; sql: string }> };
    const sql = config.queries.find(q => q.name === 'columns')!.sql;
    expect(sql).toContain('COALESCE(TYPE_NAME(c.system_type_id), TYPE_NAME(c.user_type_id)) AS type_name');
    expect(sql).toMatch(/GROUP BY[^]*COALESCE\(TYPE_NAME\(c\.system_type_id\), TYPE_NAME\(c\.user_type_id\)\)/);
  });

  it('the dependencies query returns object references only, no type or schema-collection rows', () => {
    const config = yaml.load(readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf-8')) as { queries: Array<{ name: string; sql: string }> };
    const sql = config.queries.find(q => q.name === 'dependencies')!.sql;
    expect(sql).toMatch(/WHERE[^]*AND d\.referenced_class = 1/);
  });

  it('expands schema placeholders', testExpandSchemaPlaceholder);
  it('keeps placeholders in configured queries', testYamlQueriesHavePlaceholder);
  it('classifies phase-two queries', testPhase2QueryPredicate);
  it('preserves expanded SQL structure', testExpandedSqlStructure);
  it('maps database platforms from DMV results', testDbPlatformFromDmv);
});

describe('empty metadata catalog', () => {
  it('the schema preview warning names VIEW DEFINITION, the permission a login needs to see objects', async () => {
    const { buildSchemaPreview } = await import('../../../src/engine/dmvExtractor');
    const empty: SimpleExecuteResult = {
      rowCount: 0,
      columnInfo: ['schema_name', 'type_code', 'object_count'].map((columnName) => ({ columnName }) as IDbColumn),
      rows: [],
    };
    expect(buildSchemaPreview(empty).warnings).toEqual([expect.stringMatching(/No user objects found.*VIEW DEFINITION/)]);
  });
});
