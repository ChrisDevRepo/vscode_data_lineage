/**
 * Syntactic edge cases for the SQL body parser that need multi-line bodies,
 * external-file references or a generated body; single statements are rows in
 * tests/cases/parser/exact-edges.yaml. Every expectation is the complete list, written by
 * hand from the SQL: a missing name and an invented name both fail.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  extractExternalRefs,
  parseSqlBody,
} from '../../../src/engine/sqlBodyParser';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => {
  loadParseRules();
});

/** The five capture lists, so one `toEqual` pins the complete parse. */
const captures = (sql: string) => {
  const r = parseSqlBody(sql);
  return {
    sources: r.sources,
    targets: r.targets,
    execCalls: r.execCalls,
    crossDbSources: r.crossDbSources,
    crossDbTargets: r.crossDbTargets,
  };
};
const none = {
  sources: [],
  targets: [],
  execCalls: [],
  crossDbSources: [],
  crossDbTargets: [],
};

describe('extraction boundaries', () => {
  it.each([
    ['an empty body', ''],
    ['a whitespace-only body', '   \n\t  '],
  ])('returns no dependencies for %s', (_label, sql) => {
    expect(captures(sql)).toEqual(none);
  });
});

describe('cross-database references', () => {
  it('captures both cross-database joins and the local target, not the procedure header', () => {
    expect(
      captures(`
        CREATE PROCEDURE [dbo].[spConsolidate] AS
        INSERT INTO dbo.ConsolidatedSales
        SELECT s.*, p.ProductName
        FROM SalesDB.dbo.FactSales s
        INNER JOIN ProductDB.catalog.DimProduct p ON s.ProductKey = p.ProductKey
      `),
    ).toEqual({
      ...none,
      targets: ['[dbo].[consolidatedsales]'],
      crossDbSources: ['salesdb.dbo.factsales', 'productdb.catalog.dimproduct'],
    });
  });
});

describe('CLR method calls are not cross-database references', () => {
  it('XML value() and nodes() methods produce no cross-database source', () => {
    // `xmlcol.nodes(...)` has the shape of a schema-qualified TVF, so it is kept as a
    // two-part local reference, as the parse rules document.
    const parsed = captures(`
      SELECT x.n.value('text()[1]', 'nvarchar(100)') AS Val
      FROM dbo.XmlTable CROSS APPLY xmlcol.nodes('/root/item') x(n)`);
    expect(parsed.crossDbSources).toEqual([]);
    expect(parsed.crossDbTargets).toEqual([]);
    expect(parsed.targets).toEqual([]);
    expect(parsed.sources).toEqual(['[dbo].[xmltable]', '[xmlcol].[nodes]']);
  });

  it('still captures a cross-database table-valued function reached through CROSS APPLY', () => {
    expect(
      captures(`
      SELECT * FROM dbo.FactSales s
      CROSS APPLY OtherDB.dbo.fn_tvf(s.key) t
    `),
    ).toEqual({
      ...none,
      sources: ['[dbo].[factsales]'],
      crossDbSources: ['otherdb.dbo.fn_tvf'],
    });
  });
});

describe('extractExternalRefs', () => {
  it.each([
    {
      name: 'COPY INTO ... FROM',
      sql: `
        COPY INTO dbo.TargetTable FROM 'https://storage.blob.core.windows.net/data/input.csv'
        WITH (FILE_TYPE = 'CSV')
      `,
      refs: [
        {
          url: 'https://storage.blob.core.windows.net/data/input.csv',
          kind: 'copy_from',
        },
      ],
    },
    {
      name: 'BULK INSERT ... FROM',
      sql: `
        BULK INSERT dbo.TargetTable FROM 'C:\\Data\\import.csv'
        WITH (FIELDTERMINATOR = ',')
      `,
      refs: [{ url: 'C:\\Data\\import.csv', kind: 'bulk_from' }],
    },
    {
      name: 'an OPENROWSET with a wildcard path',
      sql: `
        SELECT r.filepath(1) AS [Year], r.filepath(2) AS [Month], *
        FROM OPENROWSET(
          BULK 'https://myaccount.dfs.core.windows.net/curated/fact_sales/year=*/month=*/*.parquet',
          FORMAT = 'DELTA'
        ) WITH (
          SalesKey INT, OrderDate DATE, Amount DECIMAL(18,2)
        ) AS r
      `,
      refs: [
        {
          url: 'https://myaccount.dfs.core.windows.net/curated/fact_sales/year=*/month=*/*.parquet',
          kind: 'openrowset',
        },
      ],
    },
    {
      name: 'COPY INTO carrying a SAS credential keeps the path and drops the secret',
      sql: `
        COPY INTO dbo.FactSales
        FROM 'https://mydatalake.blob.core.windows.net/staging/sales/*.parquet'
        WITH (
          FILE_TYPE = 'PARQUET',
          CREDENTIAL = (IDENTITY = 'Shared Access Signature', SECRET = 'sv=2020-08-04&ss=b')
        )
      `,
      refs: [
        {
          url: 'https://mydatalake.blob.core.windows.net/staging/sales/*.parquet',
          kind: 'copy_from',
        },
      ],
    },
    {
      name: 'BULK INSERT from a UNC path',
      sql: `
        BULK INSERT dbo.ImportedData
        FROM '\\\\fileserver\\data\\export_20240101.csv'
        WITH (FIELDTERMINATOR = '|', ROWTERMINATOR = '\\n', FIRSTROW = 2)
      `,
      refs: [
        { url: '\\\\fileserver\\data\\export_20240101.csv', kind: 'bulk_from' },
      ],
    },
    {
      name: 'ordinary SQL with no external reference',
      sql: 'SELECT * FROM dbo.Orders',
      refs: [],
    },
  ])('$name', ({ sql, refs }) => {
    expect(extractExternalRefs(sql)).toEqual(refs);
  });

  it.each([
    [
      'bracketed',
      "[OPENROWSET(BULK '/phantom-open')]",
      "[COPY INTO dbo.T FROM '/phantom-copy']",
      "[BULK INSERT dbo.T FROM '/phantom-bulk']",
    ],
    [
      'double-quoted',
      '"OPENROWSET(BULK \'/phantom-open\')"',
      '"COPY INTO dbo.T FROM \'/phantom-copy\'"',
      '"BULK INSERT dbo.T FROM \'/phantom-bulk\'"',
    ],
  ])(
    'ignores external syntax inside %s identifiers while retaining real quoted paths',
    (_name, openIdentifier, copyIdentifier, bulkIdentifier) => {
      const sql = `
      SELECT ${openIdentifier}, ${copyIdentifier}, ${bulkIdentifier} FROM dbo.Real;
      SELECT * FROM OPENROWSET(BULK 'https://real.example/a/*b--c.csv', SINGLE_CLOB) AS r;
      COPY INTO dbo.Target FROM 'https://real.example/copy.csv';
      BULK INSERT dbo.Target FROM 'C:\\Data\\bulk.csv';
    `;

      expect(extractExternalRefs(sql)).toEqual([
        { url: 'https://real.example/a/*b--c.csv', kind: 'openrowset' },
        { url: 'https://real.example/copy.csv', kind: 'copy_from' },
        { url: 'C:\\Data\\bulk.csv', kind: 'bulk_from' },
      ]);
    },
  );

  it('finds both an external file and a cross-database reference in one body', () => {
    const body = `
      CREATE PROCEDURE [etl].[spLoadMixed] AS
      INSERT INTO dbo.Staging
      SELECT * FROM OPENROWSET(BULK 'https://lake.dfs.core.windows.net/raw/data.parquet', FORMAT='PARQUET') AS src
      UNION ALL
      SELECT * FROM ArchiveDB.dbo.HistoricalData
    `;
    expect(extractExternalRefs(body)).toEqual([
      {
        url: 'https://lake.dfs.core.windows.net/raw/data.parquet',
        kind: 'openrowset',
      },
    ]);
    expect(captures(body)).toEqual({
      ...none,
      targets: ['[dbo].[staging]'],
      crossDbSources: ['archivedb.dbo.historicaldata'],
    });
  });
});

describe('OPENXML', () => {
  it('OPENXML and its preparedocument handle produce no source, target, or exec call', () => {
    expect(
      captures(`
      EXEC sp_xml_preparedocument @hdoc OUTPUT, @xml
      SELECT * FROM OPENXML(@hdoc, '/root/row', 2) WITH (id INT, name NVARCHAR(50))
    `),
    ).toEqual(none);
  });
});

describe('complete dependency extraction', () => {
  it('collects every reference in a body with more than ten thousand matches', () => {
    const selects = Array.from(
      { length: 10_001 },
      (_, i) => `SELECT * FROM [dbo].[T${i}]`,
    ).join('\n');
    const parsed = parseSqlBody(selects);
    expect(parsed.sources).toEqual(
      Array.from({ length: 10_001 }, (_, i) => `[dbo].[t${i}]`),
    );
    expect(parsed.targets).toEqual([]);
  });
});
