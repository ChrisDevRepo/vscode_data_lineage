/** DMV Extractor test — uses synthetic DMV data to verify model building. */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  buildModelFromDmv,
  validateQueryResult,
} from '../../../src/engine/dmvExtractor';
import { formatColumnType } from '../../../src/engine/types';
import type { DmvResults } from '../../../src/engine/dmvExtractor';
import type {
  SimpleExecuteResult,
  DbCellValue,
  IDbColumn,
} from '../../../src/types/database';
import {
  expandSchemaPlaceholder,
  validateSchemaPlaceholder,
} from '../../../src/utils/sql';
import {
  isPhase2Query,
  type DmvQuery,
} from '../../../src/engine/connectionManager';
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
    return names.map((n) => ({
      columnName: n,
      dataType: 'string',
      dataTypeName: 'varchar',
    }));
  }
  function makeResult(
    columns: IDbColumn[],
    rows: DbCellValue[][],
  ): SimpleExecuteResult {
    return { rowCount: rows.length, columnInfo: columns, rows };
  }

  const nodeFields = ['schema_name', 'object_name', 'type_code', 'body_script'];
  const columnFields = [
    'schema_name',
    'table_name',
    'ordinal',
    'column_name',
    'type_name',
    'max_length',
    'precision',
    'scale',
    'is_nullable',
    'is_identity',
    'is_computed',
  ];
  const dependencyFields = [
    'referencing_schema',
    'referencing_name',
    'referenced_schema',
    'referenced_name',
  ];

  function buildSyntheticResults(): DmvResults {
    const nodesCols = cols(...nodeFields);
    const nodesRows: DbCellValue[][] = [
      [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
      [cell('dbo'), cell('Orders'), cell('U '), nullCell()],
      [cell('dbo'), cell('Products'), cell('U '), nullCell()],
      [
        cell('dbo'),
        cell('vActiveCustomers'),
        cell('V '),
        cell(
          'CREATE VIEW [dbo].[vActiveCustomers] AS\nSELECT * FROM [dbo].[Customers] WHERE Active = 1',
        ),
      ],
      [
        cell('sales'),
        cell('uspGetOrdersByCustomer'),
        cell('P '),
        cell(
          'CREATE PROCEDURE [sales].[uspGetOrdersByCustomer]\nAS\nSELECT o.* FROM [dbo].[Orders] o\nINNER JOIN [dbo].[Customers] c ON o.CustomerId = c.Id',
        ),
      ],
      [
        cell('sales'),
        cell('uspCreateOrder'),
        cell('P '),
        cell(
          'CREATE PROCEDURE [sales].[uspCreateOrder]\nAS\nINSERT INTO [dbo].[Orders] (CustomerId, ProductId)\nSELECT c.Id, p.Id FROM [dbo].[Customers] c\nCROSS JOIN [dbo].[Products] p',
        ),
      ],
    ];

    const columnsCols = cols(...columnFields);
    const columnsRows: DbCellValue[][] = [
      [
        cell('dbo'),
        cell('Customers'),
        cell('1'),
        cell('Id'),
        cell('int'),
        cell('4'),
        cell('10'),
        cell('0'),
        cell('0'),
        cell('1'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Customers'),
        cell('2'),
        cell('Name'),
        cell('nvarchar'),
        cell('200'),
        cell('0'),
        cell('0'),
        cell('1'),
        cell('0'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Customers'),
        cell('3'),
        cell('Active'),
        cell('bit'),
        cell('1'),
        cell('1'),
        cell('0'),
        cell('0'),
        cell('0'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Orders'),
        cell('1'),
        cell('OrderId'),
        cell('int'),
        cell('4'),
        cell('10'),
        cell('0'),
        cell('0'),
        cell('1'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Orders'),
        cell('2'),
        cell('CustomerId'),
        cell('int'),
        cell('4'),
        cell('10'),
        cell('0'),
        cell('0'),
        cell('0'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Orders'),
        cell('3'),
        cell('ProductId'),
        cell('int'),
        cell('4'),
        cell('10'),
        cell('0'),
        cell('0'),
        cell('0'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Products'),
        cell('1'),
        cell('Id'),
        cell('int'),
        cell('4'),
        cell('10'),
        cell('0'),
        cell('0'),
        cell('1'),
        cell('0'),
      ],
      [
        cell('dbo'),
        cell('Products'),
        cell('2'),
        cell('Name'),
        cell('nvarchar'),
        cell('510'),
        cell('0'),
        cell('0'),
        cell('0'),
        cell('0'),
        cell('0'),
      ],
    ];

    const depsCols = cols(...dependencyFields);
    const depsRows: DbCellValue[][] = [
      [cell('dbo'), cell('vActiveCustomers'), cell('dbo'), cell('Customers')],
      [
        cell('sales'),
        cell('uspGetOrdersByCustomer'),
        cell('dbo'),
        cell('Orders'),
      ],
      [
        cell('sales'),
        cell('uspGetOrdersByCustomer'),
        cell('dbo'),
        cell('Customers'),
      ],
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
    const tables = model.nodes.filter((n) => n.type === 'table');
    const views = model.nodes.filter((n) => n.type === 'view');
    const procs = model.nodes.filter((n) => n.type === 'procedure');
    expect(tables.length, 'Should have 3 tables').toBe(3);
    expect(views.length, 'Should have 1 view').toBe(1);
    expect(procs.length, 'Should have 2 procedures').toBe(2);

    expect(model.schemas.length, 'Should have 2 schemas').toBe(2);
    const dboSchema = model.schemas.find((s) => s.name === 'dbo');
    const salesSchema = model.schemas.find((s) => s.name === 'sales');
    expect(dboSchema !== undefined, 'dbo schema found').toBe(true);
    expect(salesSchema !== undefined, 'sales schema found').toBe(true);
    expect(dboSchema!.nodeCount, 'dbo has 4 nodes').toBe(4);
    expect(salesSchema!.nodeCount, 'sales has 2 nodes').toBe(2);

    const customerNode = model.nodes.find((n) => n.name === 'Customers');
    expect(customerNode?.id, 'Customer ID normalized to lowercase').toBe(
      '[dbo].[customers]',
    );
    expect(
      customerNode?.schema,
      'Customer schema preserved in catalog-original casing',
    ).toBe('dbo');

    expect(
      Object.keys(model.catalog).length >= model.nodes.length,
      'Catalog has at least one entry per node',
    ).toBe(true);
    const viewId = '[dbo].[vactivecustomers]';
    expect(
      model.neighborIndex[viewId]?.in,
      'neighborIndex: Customers → vActiveCustomers',
    ).toEqual(['[dbo].[customers]']);
    expect(
      model.catalog['[dbo].[customers]']?.schema === 'dbo',
      'catalog: Customers schema is dbo',
    ).toBe(true);

    // Hand-derived from the bodies: the view reads Customers, the getter reads
    // Orders and Customers, the creator writes Orders and reads Customers and Products.
    expect(
      model.edges.map((e) => `${e.source} -> ${e.target}`).sort(),
      'exact lineage edges',
    ).toEqual(
      [
        '[dbo].[customers] -> [dbo].[vactivecustomers]',
        '[dbo].[orders] -> [sales].[uspgetordersbycustomer]',
        '[dbo].[customers] -> [sales].[uspgetordersbycustomer]',
        '[sales].[uspcreateorder] -> [dbo].[orders]',
        '[dbo].[customers] -> [sales].[uspcreateorder]',
        '[dbo].[products] -> [sales].[uspcreateorder]',
      ].sort(),
    );

    expect(model.parseStats?.spDetails.length, '2 SPs in parse details').toBe(
      2,
    );

    const ordersNode = model.nodes.find((n) => n.name === 'Orders');
    expect(
      ordersNode?.columns?.map((c) => [c.name, c.type]),
      'Orders columns in ordinal order',
    ).toEqual([
      ['OrderId', 'int'],
      ['CustomerId', 'int'],
      ['ProductId', 'int'],
    ]);

    expect(model.warnings, 'No warnings for valid data').toBeUndefined();

    const emptyResults: DmvResults = {
      nodes: makeResult(cols(...nodeFields), []),
      columns: makeResult(cols(...columnFields), []),
      dependencies: makeResult(cols(...dependencyFields), []),
    };
    const emptyModel = buildModelFromDmv(emptyResults);
    expect(emptyModel.nodes.length, 'Empty DB has 0 nodes').toBe(0);
    expect(emptyModel.edges.length, 'Empty DB has 0 edges').toBe(0);
    expect(
      emptyModel.warnings !== undefined && emptyModel.warnings.length > 0,
      'Empty DB produces warning',
    ).toBe(true);

    const nodeCols = cols(...nodeFields);
    const dupResults: DmvResults = {
      nodes: makeResult(nodeCols, [
        [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
        [cell('dbo'), cell('Customers'), cell('U '), nullCell()],
      ]),
      columns: makeResult(cols(...columnFields), []),
      dependencies: makeResult(cols(...dependencyFields), []),
    };
    expect(
      buildModelFromDmv(dupResults).nodes.length,
      'Duplicate nodes are deduplicated',
    ).toBe(1);

    const selfRefResults: DmvResults = {
      nodes: makeResult(nodeCols, [
        [cell('dbo'), cell('MyTable'), cell('U '), nullCell()],
      ]),
      columns: makeResult(cols(...columnFields), []),
      dependencies: makeResult(cols(...dependencyFields), [
        [cell('dbo'), cell('MyTable'), cell('dbo'), cell('MyTable')],
      ]),
    };
    expect(
      buildModelFromDmv(selfRefResults).edges.length,
      'Self-references produce no edges',
    ).toBe(0);
  }

  function testValidateQueryResult() {
    const validCases: [string, string[]][] = [
      ['nodes', ['schema_name', 'object_name', 'type_code', 'body_script']],
      [
        'dependencies',
        [
          'referencing_schema',
          'referencing_name',
          'referenced_schema',
          'referenced_name',
        ],
      ],
      [
        'constraints',
        [
          'schema_name',
          'table_name',
          'constraint_type',
          'constraint_name',
          'column_name',
          'column_ordinal',
          'ref_schema',
          'ref_table',
          'ref_column',
          'on_delete',
        ],
      ],
      ['platform-info', ['engine_edition', 'major_version', 'edition']],
    ];
    for (const [name, colNames] of validCases) {
      expect(
        validateQueryResult(name, makeResult(cols(...colNames), [])).length,
        `Valid ${name}: no missing`,
      ).toBe(0);
    }

    const missing = validateQueryResult(
      'nodes',
      makeResult(cols('schema_name', 'object_name'), []),
    );
    expect(missing.length, 'Invalid nodes: 2 missing').toBe(2);
    expect(
      validateQueryResult(
        'platform-info',
        makeResult(cols('engine_edition'), []),
      ).length,
      'Invalid platform-info: 2 missing',
    ).toBe(2);

    expect(
      validateQueryResult(
        'nodes',
        makeResult(
          cols('Schema_Name', 'Object_Name', 'Type_Code', 'Body_Script'),
          [],
        ),
      ).length,
      'Case-insensitive',
    ).toBe(0);

    expect(
      validateQueryResult('unknown', makeResult(cols(), [])).length,
      'Unknown query: no missing',
    ).toBe(0);
  }

  function buildConstraintsResult(): SimpleExecuteResult {
    const constraintCols = cols(
      'schema_name',
      'table_name',
      'constraint_type',
      'constraint_name',
      'column_name',
      'column_ordinal',
      'ref_schema',
      'ref_table',
      'ref_column',
      'on_delete',
    );
    const rows: DbCellValue[][] = [
      [
        cell('dbo'),
        cell('Orders'),
        cell('FK'),
        cell('FK_Orders_Customers'),
        cell('CustomerId'),
        cell('1'),
        cell('dbo'),
        cell('Customers'),
        cell('Id'),
        cell('NO ACTION'),
      ],
      [
        cell('dbo'),
        cell('Orders'),
        cell('FK'),
        cell('FK_Orders_Products'),
        cell('ProductId'),
        cell('1'),
        cell('dbo'),
        cell('Products'),
        cell('Id'),
        cell('CASCADE'),
      ],
      [
        cell('dbo'),
        cell('Customers'),
        cell('UQ'),
        cell('UQ_Customers_Name'),
        cell('Name'),
        cell('1'),
        nullCell(),
        nullCell(),
        nullCell(),
        nullCell(),
      ],
      [
        cell('dbo'),
        cell('Products'),
        cell('CK'),
        cell('CK_Products_Id'),
        cell('Id'),
        nullCell(),
        nullCell(),
        nullCell(),
        nullCell(),
        nullCell(),
      ],
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

    const customersNode = model.nodes.find((n) => n.name === 'Customers');
    expect(
      customersNode?.columns
        ?.filter((c) => c.unique)
        .map((c) => [c.name, c.unique]),
      'Customers UQ flag from the UQ row',
    ).toEqual([['Name', 'UQ_Customers_Name']]);
    expect(customersNode?.fks, 'Customers has an empty fks array').toEqual([]);

    const ordersNode = model.nodes.find((n) => n.name === 'Orders');
    expect(ordersNode?.fks, 'Orders FKs exactly as the two FK rows').toEqual([
      {
        name: 'FK_Orders_Customers',
        columns: ['CustomerId'],
        refSchema: 'dbo',
        refTable: 'Customers',
        refColumns: ['Id'],
        onDelete: 'NO ACTION',
      },
      {
        name: 'FK_Orders_Products',
        columns: ['ProductId'],
        refSchema: 'dbo',
        refTable: 'Products',
        refColumns: ['Id'],
        onDelete: 'CASCADE',
      },
    ]);

    const productsNode = model.nodes.find((n) => n.name === 'Products');
    expect(
      productsNode?.columns
        ?.filter((c) => c.check)
        .map((c) => [c.name, c.check]),
      'Products CK flag from the CK row',
    ).toEqual([['Id', 'CK_Products_Id']]);

    const noConstraintModel = buildModelFromDmv(buildSyntheticResults());
    const ordersNoConst = noConstraintModel.nodes.find(
      (n) => n.name === 'Orders',
    );
    expect(ordersNoConst?.fks ?? [], 'No FKs when constraints absent').toEqual(
      [],
    );
    expect(
      ordersNoConst?.columns?.filter((c) => c.unique || c.check),
      'No UQ or CK flags when constraints absent',
    ).toEqual([]);
    expect(
      ordersNoConst?.columns?.map((c) => c.name),
      'Columns still present without constraints',
    ).toEqual(['OrderId', 'CustomerId', 'ProductId']);
  }

  it('builds a model from DMV results', testBuildModelFromDmv);
  it(
    'validates query results against their required columns',
    testValidateQueryResult,
  );
  // A DMV max_length is a byte count that nvarchar/nchar halve to characters; a dacpac
  // TypeSpecifier.Length (lengthInChars) is already a character count and is never halved.
  it.each([
    ['int', '4', '10', '0', false, 'int'],
    ['bigint', '8', '19', '0', false, 'bigint'],
    ['bit', '1', '1', '0', false, 'bit'],
    ['datetime', '8', '23', '3', false, 'datetime'],
    ['varchar', '50', '0', '0', false, 'varchar(50)'],
    ['varchar', '-1', '0', '0', false, 'varchar(max)'],
    ['nvarchar', '200', '0', '0', false, 'nvarchar(100)'],
    ['nvarchar', '-1', '0', '0', false, 'nvarchar(max)'],
    ['nchar', '20', '0', '0', false, 'nchar(10)'],
    ['varbinary', '-1', '0', '0', false, 'varbinary(max)'],
    ['decimal', '9', '18', '2', false, 'decimal(18,2)'],
    ['numeric', '9', '10', '0', false, 'numeric(10,0)'],
    ['nvarchar', '100', '', '', true, 'nvarchar(100)'],
    ['nchar', '10', '', '', true, 'nchar(10)'],
    ['nvarchar', '-1', '', '', true, 'nvarchar(max)'],
    ['varchar', '100', '', '', true, 'varchar(100)'],
  ] as const)(
    'formats %s length %s precision %s scale %s (length in characters: %s) as %s',
    (type, length, precision, scale, lengthInChars, expected) => {
      expect(
        formatColumnType(type, length, precision, scale, lengthInChars),
      ).toBe(expected);
    },
  );
  it('enriches columns from constraint maps', testConstraintMapsEnrichColumns);

  function testPhase2QueryPredicate() {
    const yamlContent = readFileSync(
      rootPath('assets/dmvQueries.yaml'),
      'utf-8',
    );
    const config = yaml.load(yamlContent) as {
      queries: Array<{ name: string; sql: string; phase?: number }>;
    };

    const sweep = config.queries.filter((q) => isPhase2Query(q as DmvQuery));
    const excluded = config.queries
      .filter((q) => !isPhase2Query(q as DmvQuery))
      .map((q) => q.name);

    expect(sweep.map((query) => query.name).sort()).toEqual([
      'columns',
      'constraints',
      'dependencies',
      'nodes',
    ]);
    expect(excluded.sort()).toEqual([
      'all-objects',
      'platform-info',
      'schema-preview',
    ]);

    expect(
      isPhase2Query({ name: 'custom', description: '', sql: '' }),
      'Untagged query defaults to Phase 2',
    ).toBe(true);
    expect(
      !isPhase2Query({ name: 'custom', description: '', sql: '', phase: 1 }),
      'phase: 1 query is excluded',
    ).toBe(true);
  }

  function makePlatformInfo(
    engineEdition: number,
    majorVersion: number,
    edition: string,
  ): SimpleExecuteResult {
    return makeResult(cols('engine_edition', 'major_version', 'edition'), [
      [cell(String(engineEdition)), cell(String(majorVersion)), cell(edition)],
    ]);
  }

  function testDbPlatformFromDmv() {
    const emptyNodes = makeResult(cols(...nodeFields), []);
    const emptyCols = makeResult(cols(...columnFields), []);
    const emptyDeps = makeResult(cols(...dependencyFields), []);

    function modelWithPlatform(platformInfo: SimpleExecuteResult) {
      return buildModelFromDmv({
        nodes: emptyNodes,
        columns: emptyCols,
        dependencies: emptyDeps,
        platformInfo,
      });
    }

    expect(
      modelWithPlatform(makePlatformInfo(5, 0, '')).dbPlatform,
      'EngineEdition 5 → Azure SQL Database',
    ).toBe('Azure SQL Database');
    expect(
      modelWithPlatform(makePlatformInfo(6, 0, '')).dbPlatform,
      'EngineEdition 6 → Synapse Dedicated Pool',
    ).toBe('Synapse Dedicated Pool');
    expect(
      modelWithPlatform(makePlatformInfo(8, 0, '')).dbPlatform,
      'EngineEdition 8 → Azure SQL Managed Instance',
    ).toBe('Azure SQL Managed Instance');
    expect(
      modelWithPlatform(makePlatformInfo(9, 0, '')).dbPlatform,
      'EngineEdition 9 → Azure SQL Edge',
    ).toBe('Azure SQL Edge');
    expect(
      modelWithPlatform(makePlatformInfo(11, 0, '')).dbPlatform,
      'EngineEdition 11 → Fabric Data Warehouse',
    ).toBe('Fabric Data Warehouse');
    expect(
      modelWithPlatform(makePlatformInfo(12, 0, '')).dbPlatform,
      'EngineEdition 12 → SQL Database in Fabric',
    ).toBe('SQL Database in Fabric');

    const onPremCases: [number, string][] = [
      [17, 'SQL Server 2025'],
      [13, 'SQL Server 2016'],
      [8, 'SQL Server 2000'],
    ];
    for (const [major, expected] of onPremCases) {
      const model = modelWithPlatform(
        makePlatformInfo(3, major, 'Enterprise Edition'),
      );
      expect(
        model.dbPlatform,
        `EngineEdition 3, major ${major} → ${expected}`,
      ).toBe(expected);
    }

    const unknownMajor = modelWithPlatform(
      makePlatformInfo(3, 99, 'Developer Edition'),
    );
    expect(
      unknownMajor.dbPlatform,
      'Unknown major version → edition string fallback',
    ).toBe('Developer Edition');

    const unknownAll = modelWithPlatform(makePlatformInfo(3, 99, ''));
    expect(
      unknownAll.dbPlatform,
      'Unknown edition + unknown major → explicit unknown platform',
    ).toBe('Unknown database platform');

    const noPlatform = buildModelFromDmv({
      nodes: emptyNodes,
      columns: emptyCols,
      dependencies: emptyDeps,
    });
    expect(
      noPlatform.dbPlatform,
      'No platform metadata → explicit unknown',
    ).toBe('Unknown database platform');

    expect(
      noPlatform.source,
      'DMV model without platform metadata: source = database',
    ).toBe('database');

    const emptyRows = makeResult(
      cols('engine_edition', 'major_version', 'edition'),
      [],
    );
    const noRows = modelWithPlatform(emptyRows);
    expect(
      noRows.dbPlatform,
      'Empty platformInfo rows → explicit unknown',
    ).toBe('Unknown database platform');
  }

  it('expands every schema placeholder and leaves SQL without one unchanged', () => {
    expect(
      expandSchemaPlaceholder(
        'WHERE (s1.name IN ({{SCHEMAS}}) OR d.referenced_schema_name IN ({{SCHEMAS}}))',
        ['dbo'],
      ),
    ).toBe(
      "WHERE (s1.name IN (N'dbo') OR d.referenced_schema_name IN (N'dbo'))",
    );
    expect(expandSchemaPlaceholder('SELECT * FROM sys.objects', ['dbo'])).toBe(
      'SELECT * FROM sys.objects',
    );
  });

  it('warns only for a phase-two query without the schema placeholder', () => {
    expect(validateSchemaPlaceholder('q', 'SELECT 1', 2)).toContain(
      "Phase 2 query 'q'",
    );
    expect(
      validateSchemaPlaceholder('q', 'WHERE IN ({{SCHEMAS}})', 2),
    ).toBeUndefined();
    expect(validateSchemaPlaceholder('q', 'SELECT 1', 1)).toBeUndefined();
  });
  it('classifies phase-two queries', testPhase2QueryPredicate);
  it('maps database platforms from DMV results', testDbPlatformFromDmv);
});

describe('empty metadata catalog', () => {
  it('the schema preview warning names VIEW DEFINITION, the permission a login needs to see objects', async () => {
    const { buildSchemaPreview } = await import(
      '../../../src/engine/dmvExtractor'
    );
    const empty: SimpleExecuteResult = {
      rowCount: 0,
      columnInfo: ['schema_name', 'type_code', 'object_count'].map(
        (columnName) => ({ columnName }) as IDbColumn,
      ),
      rows: [],
    };
    expect(buildSchemaPreview(empty).warnings).toEqual([
      expect.stringMatching(/No user objects found.*VIEW DEFINITION/),
    ]);
  });
});
