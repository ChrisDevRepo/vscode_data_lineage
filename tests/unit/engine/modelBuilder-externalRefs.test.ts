/** Virtual external nodes built by `modelBuilder` from SQL bodies: OPENROWSET and COPY INTO / BULK INSERT file references, three-part cross-database references, and the CETAS external-table target. */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => {
  loadParseRules();
});

type BuildObject = Parameters<typeof buildModel>[0][number];

const procedure = (fullName: string, bodyScript: string): BuildObject =>
  ({ fullName, type: 'procedure' as const, bodyScript }) as BuildObject;
const table = (fullName: string): BuildObject =>
  ({ fullName, type: 'table' as const }) as BuildObject;

type Built = ReturnType<typeof buildModel>;

/** Names a node by what the SQL says: a file by its URL, a database reference by its database and object, a local object by its id. Virtual ids are hashes, so tests never spell them. */
const label = (built: Built, id: string): string => {
  const node = built.nodes.find((candidate) => candidate.id === id);
  if (node?.externalType === 'file') return `file ${node.externalUrl}`;
  if (node?.externalType === 'db')
    return `db ${node.externalDatabase}.${node.name}`;
  return id;
};

/** Every edge of the model as a sorted `source -> target` list of labels. */
const edgeList = (built: Built): string[] =>
  built.edges
    .map(
      (edge) => `${label(built, edge.source)} -> ${label(built, edge.target)}`,
    )
    .sort();

describe('external file references — OPENROWSET', () => {
  const url = 'https://storage.blob.core.windows.net/data/sales_2024.parquet';
  const model = () =>
    buildModel(
      [
        procedure(
          '[dbo].[spLoadSales]',
          `
        CREATE PROCEDURE [dbo].[spLoadSales] AS
        INSERT INTO dbo.Sales
        SELECT * FROM OPENROWSET(BULK '${url}', FORMAT = 'PARQUET') AS src
        UNION ALL
        SELECT * FROM Staging.dbo.Orders
      `,
        ),
        table('[dbo].[Sales]'),
      ],
      [{ sourceName: '[dbo].[spLoadSales]', targetName: '[dbo].[Sales]' }],
    );

  it('creates a file node with the full URL, the last segment as its name, no schema and the external id prefix', () => {
    const fileNode = model().nodes.find((node) => node.externalType === 'file');
    expect(fileNode).toMatchObject({
      externalUrl: url,
      name: 'sales_2024.parquet',
      schema: '',
    });
    expect(fileNode!.id).toMatch(/^\[__ext__\]\./);
  });
});

describe('external file references — COPY INTO and BULK INSERT', () => {
  const built = () =>
    buildModel(
      [
        procedure(
          '[dbo].[spCopy]',
          `
      CREATE PROCEDURE [dbo].[spCopy] AS
      COPY INTO dbo.FactSales
      FROM 'https://datalake.dfs.core.windows.net/raw/fact_sales/*.parquet'
      WITH (FILE_TYPE = 'PARQUET')
    `,
        ),
        procedure(
          '[dbo].[spBulk]',
          `
      CREATE PROCEDURE [dbo].[spBulk] AS
      BULK INSERT dbo.DimProduct
      FROM '\\\\fileserver\\share\\products.csv'
      WITH (FIELDTERMINATOR = ',')
    `,
        ),
        table('[dbo].[FactSales]'),
        table('[dbo].[DimProduct]'),
      ],
      [],
    );

  const copyUrl =
    'https://datalake.dfs.core.windows.net/raw/fact_sales/*.parquet';
  const bulkPath = '\\\\fileserver\\share\\products.csv';

  it('creates one file node per external source, keyed by its literal location', () => {
    expect(
      built()
        .nodes.filter((node) => node.externalType === 'file')
        .map((node) => node.externalUrl)
        .sort(),
    ).toEqual([copyUrl, bulkPath].sort());
  });
});

describe('cross-database references', () => {
  it('creates a db node holding the database name and schema-qualified object', () => {
    const built = buildModel(
      [
        procedure(
          '[dbo].[spLoadSales]',
          `
          CREATE PROCEDURE [dbo].[spLoadSales] AS SELECT * FROM Staging.dbo.Orders
        `,
        ),
      ],
      [],
    );
    const crossDb = built.nodes.find((node) => node.externalType === 'db');
    expect(crossDb?.schema).toBe('');
    expect(crossDb!.externalDatabase).toBe('staging');
    expect(crossDb!.name).toBe('dbo.orders');
  });
});

describe('CETAS external-table target', () => {
  it('links the procedure to the external table it writes', () => {
    const built = buildModel(
      [
        procedure(
          '[dbo].[spExport]',
          `
          CREATE PROCEDURE [dbo].[spExport] AS
          CREATE EXTERNAL TABLE ext.SalesExport
          WITH (LOCATION = '/export/sales/', DATA_SOURCE = MyDataSource)
          AS SELECT * FROM dbo.Sales
        `,
        ),
        table('[dbo].[Sales]'),
        {
          fullName: '[ext].[SalesExport]',
          type: 'external' as const,
          externalType: 'et' as const,
        } as BuildObject,
      ],
      [{ sourceName: '[dbo].[spExport]', targetName: '[dbo].[Sales]' }],
    );

    expect(built.nodes.map((node) => node.id).sort()).toEqual(
      ['[dbo].[sales]', '[dbo].[spexport]', '[ext].[salesexport]'].sort(),
    );
    expect(edgeList(built)).toEqual([
      '[dbo].[sales] -> [dbo].[spexport]',
      '[dbo].[spexport] -> [ext].[salesexport]',
    ]);
  });
});

describe('virtual-node suppression', () => {
  const externalObjects = () => [
    table('[dbo].[Sales]'),
    procedure(
      '[dbo].[spLoad]',
      `CREATE PROCEDURE [dbo].[spLoad] AS
      SELECT * FROM OPENROWSET(BULK 'https://lake/data.parquet', FORMAT='PARQUET') AS r
      UNION ALL SELECT * FROM OtherDB.dbo.Remote`,
    ),
  ];
  const externalDeps = [
    { sourceName: '[dbo].[spLoad]', targetName: '[dbo].[Sales]' },
  ];

  it('creates none when externalRefsEnabled is false', () => {
    const built = buildModel(
      externalObjects(),
      externalDeps,
      undefined,
      undefined,
      false,
    );
    expect(built.nodes.map((node) => node.id).sort()).toEqual([
      '[dbo].[sales]',
      '[dbo].[spload]',
    ]);
  });
});
