/**
 * Virtual external nodes built by `modelBuilder` from SQL bodies: OPENROWSET and
 * COPY INTO / BULK INSERT file references, three-part cross-database references, and
 * the CETAS external-table target.
 *
 * @remarks
 * Split out of graphBuilder.test.ts, where these lived despite exercising `buildModel`.
 * The suppression rules matter most: a T-SQL CLR method call such as
 * `EMP_cte.OrganizationNode.GetAncestor(...)` is textually identical to
 * `[db].[schema].[object]`, and admitting one invents a database that does not exist.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

type BuildObject = Parameters<typeof buildModel>[0][number];

const procedure = (fullName: string, bodyScript: string): BuildObject =>
  ({ fullName, type: 'procedure' as const, bodyScript }) as BuildObject;
const table = (fullName: string): BuildObject => ({ fullName, type: 'table' as const }) as BuildObject;

// ─── OPENROWSET file references ───────────────────────────────────────────────

describe('external file references — OPENROWSET', () => {
  const url = 'https://storage.blob.core.windows.net/data/sales_2024.parquet';
  const model = () => buildModel(
    [
      procedure('[dbo].[spLoadSales]', `
        CREATE PROCEDURE [dbo].[spLoadSales] AS
        INSERT INTO dbo.Sales
        SELECT * FROM OPENROWSET(BULK '${url}', FORMAT = 'PARQUET') AS src
        UNION ALL
        SELECT * FROM Staging.dbo.Orders
      `),
      table('[dbo].[Sales]'),
    ],
    [{ sourceName: '[dbo].[spLoadSales]', targetName: '[dbo].[Sales]' }],
  );

  it('creates a file node carrying the full URL and the last segment as its name', () => {
    const fileNode = model().nodes.find(node => node.externalType === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.externalUrl).toBe(url);
    expect(fileNode!.name).toBe('sales_2024.parquet');
  });

  it('gives the file node an empty schema and the external id prefix', () => {
    const fileNode = model().nodes.find(node => node.externalType === 'file')!;
    expect(fileNode.schema).toBe('');
    expect(fileNode.id.startsWith('[__ext__].')).toBe(true);
  });

  it('points the file node at the procedure that reads it', () => {
    const built = model();
    const fileNode = built.nodes.find(node => node.externalType === 'file')!;
    expect(built.edges).toContainEqual(
      expect.objectContaining({ source: fileNode.id, target: '[dbo].[sploadsales]' }),
    );
  });

  it('registers both virtual nodes in the catalog with their kind', () => {
    const built = model();
    const fileNode = built.nodes.find(node => node.externalType === 'file')!;
    const dbNode = built.nodes.find(node => node.externalType === 'db')!;
    expect(built.catalog[fileNode.id]?.externalType).toBe('file');
    expect(built.catalog[dbNode.id]?.externalType).toBe('db');
  });

  it('creates one node for a URL referenced by two procedures, with an edge to each', () => {
    const shared = 'https://storage.blob.core.windows.net/data/shared.csv';
    const built = buildModel([
      procedure('[dbo].[spA]', `CREATE PROCEDURE [dbo].[spA] AS SELECT * FROM OPENROWSET(BULK '${shared}', FORMAT = 'CSV') AS r`),
      procedure('[dbo].[spB]', `CREATE PROCEDURE [dbo].[spB] AS SELECT * FROM OPENROWSET(BULK '${shared}', FORMAT = 'CSV') AS r`),
    ], []);

    const fileNodes = built.nodes.filter(node => node.externalType === 'file');
    expect(fileNodes).toHaveLength(1);
    expect(built.edges.filter(edge => edge.source === fileNodes[0].id)).toHaveLength(2);
  });
});

// ─── COPY INTO and BULK INSERT ────────────────────────────────────────────────

describe('external file references — COPY INTO and BULK INSERT', () => {
  const built = () => buildModel([
    procedure('[dbo].[spCopy]', `
      CREATE PROCEDURE [dbo].[spCopy] AS
      COPY INTO dbo.FactSales
      FROM 'https://datalake.dfs.core.windows.net/raw/fact_sales/*.parquet'
      WITH (FILE_TYPE = 'PARQUET')
    `),
    procedure('[dbo].[spBulk]', `
      CREATE PROCEDURE [dbo].[spBulk] AS
      BULK INSERT dbo.DimProduct
      FROM '\\\\fileserver\\share\\products.csv'
      WITH (FIELDTERMINATOR = ',')
    `),
    table('[dbo].[FactSales]'),
    table('[dbo].[DimProduct]'),
  ], []);

  it('creates one file node per external source', () => {
    expect(built().nodes.filter(node => node.externalType === 'file')).toHaveLength(2);
  });

  it.each([
    ['COPY INTO', 'fact_sales'],
    ['BULK INSERT', 'products.csv'],
  ])('creates the %s file node', (_label, marker) => {
    const files = built().nodes.filter(node => node.externalType === 'file');
    expect(files.some(node => node.externalUrl?.includes(marker))).toBe(true);
  });
});

// ─── Cross-database references ────────────────────────────────────────────────

describe('cross-database references', () => {
  it('creates a db node holding the database name and schema-qualified object', () => {
    const built = buildModel(
      [
        procedure('[dbo].[spLoadSales]', `
          CREATE PROCEDURE [dbo].[spLoadSales] AS SELECT * FROM Staging.dbo.Orders
        `),
      ],
      [],
    );
    const crossDb = built.nodes.find(node => node.externalType === 'db');
    expect(crossDb).toBeDefined();
    expect(crossDb!.schema).toBe('');
    expect(crossDb!.externalDatabase).toBe('staging');
    expect(crossDb!.name).toBe('dbo.orders');
  });

  it('points a written cross-database target outward from the procedure', () => {
    const built = buildModel(
      [
        table('[dbo].[LocalData]'),
        procedure('[dbo].[spArchive]', `
          CREATE PROCEDURE [dbo].[spArchive] AS
          INSERT INTO ArchiveDB.dbo.ArchivedSales
          SELECT * FROM [dbo].[LocalData]
        `),
      ],
      [{ sourceName: '[dbo].[spArchive]', targetName: '[dbo].[LocalData]' }],
    );
    const crossDb = built.nodes.find(node => node.externalType === 'db')!;

    expect(built.edges).toContainEqual(
      expect.objectContaining({ source: '[dbo].[sparchive]', target: crossDb.id }),
    );
    expect(built.edges).toContainEqual(
      expect.objectContaining({ source: '[dbo].[localdata]', target: '[dbo].[sparchive]' }),
    );
  });

  const sameDbObjects = () => [
    procedure('[dbo].[spLoad]', 'CREATE PROCEDURE [dbo].[spLoad] AS SELECT * FROM MyDB.dbo.Sales'),
    table('[dbo].[Sales]'),
  ];
  const sameDbDeps = [{ sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' }];

  it('resolves a same-database reference locally when the current database is known (DMV path)', () => {
    const built = buildModel(sameDbObjects(), sameDbDeps, undefined, 'MyDB');
    expect(built.nodes.find(node => node.externalType === 'db')).toBeUndefined();
  });

  it('resolves a same-database reference locally when the local object exists (dacpac path)', () => {
    const built = buildModel(sameDbObjects(), sameDbDeps);
    expect(built.nodes.find(node => node.externalType === 'db')).toBeUndefined();
  });
});

// ─── CETAS ────────────────────────────────────────────────────────────────────

describe('CETAS external-table target', () => {
  it('links the procedure to the external table it writes', () => {
    const built = buildModel(
      [
        procedure('[dbo].[spExport]', `
          CREATE PROCEDURE [dbo].[spExport] AS
          CREATE EXTERNAL TABLE ext.SalesExport
          WITH (LOCATION = '/export/sales/', DATA_SOURCE = MyDataSource)
          AS SELECT * FROM dbo.Sales
        `),
        table('[dbo].[Sales]'),
        { fullName: '[ext].[SalesExport]', type: 'external' as const, externalType: 'et' as const } as BuildObject,
      ],
      [{ sourceName: '[dbo].[spExport]', targetName: '[dbo].[Sales]' }],
    );

    expect(built.nodes.map(node => node.id)).toEqual(
      expect.arrayContaining(['[dbo].[spexport]', '[ext].[salesexport]']),
    );
    expect(built.edges).toContainEqual(
      expect.objectContaining({ source: '[dbo].[spexport]', target: '[ext].[salesexport]' }),
    );
  });
});

// ─── Mixed references and budget ──────────────────────────────────────────────

describe('mixed local, file and cross-database references', () => {
  const built = () => buildModel(
    [
      table('[dbo].[FactSales]'),
      table('[dim].[Product]'),
      procedure('[dbo].[spETL]', `CREATE PROCEDURE [dbo].[spETL] AS
        INSERT INTO [dbo].[FactSales]
        SELECT p.*, r.* FROM [dim].[Product] p
        CROSS JOIN OPENROWSET(BULK 'https://lake/raw.parquet', FORMAT='PARQUET') AS r
        UNION ALL
        SELECT * FROM Staging.dbo.Orders`),
    ],
    [
      { sourceName: '[dbo].[spETL]', targetName: '[dbo].[FactSales]' },
      { sourceName: '[dbo].[spETL]', targetName: '[dim].[Product]' },
    ],
  );

  it('keeps the local write and read edges', () => {
    expect(built().edges).toContainEqual(
      expect.objectContaining({ source: '[dbo].[spetl]', target: '[dbo].[factsales]' }),
    );
    expect(built().edges).toContainEqual(
      expect.objectContaining({ source: '[dim].[product]', target: '[dbo].[spetl]' }),
    );
  });

  it.each(['file', 'db'] as const)('creates the %s virtual node with an edge into the procedure', (kind) => {
    const model = built();
    const virtual = model.nodes.find(node => node.externalType === kind);
    expect(virtual).toBeDefined();
    expect(model.edges).toContainEqual(
      expect.objectContaining({ source: virtual!.id, target: '[dbo].[spetl]' }),
    );
  });

  it('adds exactly the two virtual nodes to the three real ones', () => {
    expect(built().nodes).toHaveLength(5);
  });
});

describe('virtual-node suppression', () => {
  const externalObjects = () => [
    table('[dbo].[Sales]'),
    procedure('[dbo].[spLoad]', `CREATE PROCEDURE [dbo].[spLoad] AS
      SELECT * FROM OPENROWSET(BULK 'https://lake/data.parquet', FORMAT='PARQUET') AS r
      UNION ALL SELECT * FROM OtherDB.dbo.Remote`),
  ];
  const externalDeps = [{ sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' }];

  it('creates none when externalRefsEnabled is false', () => {
    const built = buildModel(externalObjects(), externalDeps, undefined, undefined, false);
    expect(built.nodes.filter(node => node.externalType === 'file' || node.externalType === 'db')).toEqual([]);
    expect(built.nodes).toHaveLength(2);
  });

  it('creates none when maxNodes leaves no budget beyond the real nodes', () => {
    const built = buildModel(
      [table('[dbo].[Sales]'), table('[dbo].[Products]'), externalObjects()[1]],
      [{ sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' }],
      undefined, undefined, true, 3,
    );
    expect(built.nodes.filter(node => node.externalType === 'file' || node.externalType === 'db')).toEqual([]);
    expect(built.nodes).toHaveLength(3);
  });
});

// ─── CLR method suppression ───────────────────────────────────────────────────

describe('CLR method suppression', () => {
  // A dependency reported as [EMP_cte].[OrganizationNode].[GetAncestor] is a HierarchyID
  // method call, not [database].[schema].[object]. Admitting it invents a database.
  it.each([
    ['HierarchyID GetAncestor', '[EMP_cte].[OrganizationNode].[GetAncestor]'],
    ['HierarchyID ToString', '[EMP_cte].[OrganizationNode].[ToString]'],
    ['HierarchyID GetLevel', '[EMP_cte].[OrganizationNode].[GetLevel]'],
    ['XML nodes', '[jc].[Resume].[nodes]'],
    ['XML value', '[ref].[col].[value]'],
    ['Geometry STDistance', '[loc].[point].[STDistance]'],
  ])('creates no cross-database node for a DMV-reported %s call', (_label, targetName) => {
    const built = buildModel(
      [procedure('[dbo].[spTest]', 'CREATE PROCEDURE [dbo].[spTest] AS SELECT 1')],
      [{ sourceName: '[dbo].[spTest]', targetName }],
    );
    expect(built.nodes.find(node => node.externalType === 'db')).toBeUndefined();
  });

  it('creates no cross-database node for CLR method calls captured from a SQL body', () => {
    const built = buildModel(
      [
        procedure('[dbo].[spHierarchy]', `
          CREATE PROCEDURE [dbo].[spHierarchy] AS
          SELECT EMP_cte.OrganizationNode.GetAncestor(1),
                 EMP_cte.OrganizationNode.ToString(),
                 jc.Resume.nodes('/n:n/@id', 'varchar(max)'),
                 loc.point.STDistance(geography::Point(0,0,4326))
          FROM dbo.Employees
        `),
        table('[dbo].[Employees]'),
      ],
      [{ sourceName: '[dbo].[spHierarchy]', targetName: '[dbo].[Employees]' }],
    );
    expect(built.nodes.filter(node => node.externalType === 'db')).toEqual([]);
  });

  it('still creates a node for a genuine cross-database INSERT — the filter is name-based', () => {
    const built = buildModel(
      [
        procedure('[dbo].[spArchive]', `
          CREATE PROCEDURE [dbo].[spArchive] AS
          INSERT INTO ArchiveDB.dbo.ArchivedSales
          SELECT * FROM dbo.Source
        `),
        table('[dbo].[Source]'),
      ],
      [{ sourceName: '[dbo].[spArchive]', targetName: '[dbo].[Source]' }],
    );
    const dbNodes = built.nodes.filter(node => node.externalType === 'db');
    expect(dbNodes).toHaveLength(1);
    expect(dbNodes[0].externalDatabase).toBe('archivedb');
  });

  it('still creates a node for a genuine bracketed three-part reference', () => {
    const built = buildModel(
      [procedure('[dbo].[spCrossDb]', 'CREATE PROCEDURE [dbo].[spCrossDb] AS SELECT * FROM [OtherDB].[dbo].[FactSales]')],
      [],
    );
    const dbNodes = built.nodes.filter(node => node.externalType === 'db');
    expect(dbNodes).toHaveLength(1);
    expect(dbNodes[0].externalDatabase).toBe('otherdb');
  });
});
