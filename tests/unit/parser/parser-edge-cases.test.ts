/** Comprehensive syntactic edge-case tests for the SQL body parser. */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  extractExternalRefs,
  parseSqlBody,
} from '../../../src/engine/sqlBodyParser';
import { hasName, loadParseRules } from '../helpers/testUtils';

beforeAll(() => {
  loadParseRules();
});

const mentions = (list: string[], needle: string) =>
  list.some((entry) => entry.toLowerCase().includes(needle.toLowerCase()));

/** One parser expectation. */
type ParseCase = {
  name: string;
  sql: string;
  noSources?: string[];
  /** Matched on the last name part (see `hasName`). */
  targets?: string[];
  noTargets?: string[];
  /** Compared verbatim against the lower-cased cross-database array. */
  crossDbSources?: string[];
};

function check(testCase: ParseCase): void {
  const result = parseSqlBody(testCase.sql);

  for (const name of testCase.noSources ?? []) {
    expect(mentions(result.sources, name), `${name} must not be a source`).toBe(
      false,
    );
  }
  for (const name of testCase.targets ?? []) {
    expect(hasName(result.targets, name), `target ${name}`).toBe(true);
  }
  for (const name of testCase.noTargets ?? []) {
    expect(mentions(result.targets, name), `${name} must not be a target`).toBe(
      false,
    );
  }
  for (const name of testCase.crossDbSources ?? []) {
    expect(result.crossDbSources.map((entry) => entry.toLowerCase())).toContain(
      name,
    );
  }
}

const table = (cases: ParseCase[]) => it.each(cases)('$name', check);

describe('procedure calls', () => {
  it('preserves a dot inside a bracketed procedure name as part of the identifier', () => {
    expect(
      parseSqlBody('EXEC [dbo].[spLoad_Case4.5]').execCalls.map((entry) =>
        entry.toLowerCase(),
      ),
    ).toContain('[dbo].[spload_case4.5]');
  });
});

describe('CTE exclusion', () => {
  it('excludes every CTE name when several are declared', () => {
    const result = parseSqlBody(
      'WITH A AS (SELECT 1), B AS (SELECT 2) SELECT * FROM A JOIN B ON 1=1 JOIN [dbo].[T1] ON 1=1',
    );
    expect(hasName(result.sources, 'T1')).toBe(true);
    expect(
      result.sources.filter((entry) =>
        ['a', 'b'].includes(entry.replace(/\[|\]/g, '').toLowerCase()),
      ),
    ).toEqual([]);
  });
});

describe('extraction boundaries', () => {
  it.each([
    ['an empty body', ''],
    ['a whitespace-only body', '   \n\t  '],
  ])('returns no dependencies for %s', (_label, sql) => {
    const result = parseSqlBody(sql);
    expect(result.sources).toEqual([]);
    expect(result.targets).toEqual([]);
    expect(result.execCalls).toEqual([]);
  });
});

describe('cross-database references', () => {
  table([
    {
      name: 'two cross-database joins are both captured',
      sql: `
        CREATE PROCEDURE [dbo].[spConsolidate] AS
        INSERT INTO dbo.ConsolidatedSales
        SELECT s.*, p.ProductName
        FROM SalesDB.dbo.FactSales s
        INNER JOIN ProductDB.catalog.DimProduct p ON s.ProductKey = p.ProductKey
      `,
      crossDbSources: ['salesdb.dbo.factsales', 'productdb.catalog.dimproduct'],
    },
  ]);
});

describe('CLR method calls are not cross-database references', () => {
  it.each([
    [
      'mixed-bracket GetAncestor',
      'INNER JOIN [EMP_cte] ON [EMP_cte].[OrganizationNode].GetAncestor(1) = e.OrganizationNode',
      ['getancestor'],
    ],
    [
      'XML nodes() and value()',
      `
      SELECT x.n.value('text()[1]', 'nvarchar(100)') AS Val
      FROM dbo.XmlTable CROSS APPLY xmlcol.nodes('/root/item') x(n)`,
      ['value', 'nodes'],
    ],
  ])('%s produces no cross-database source', (_label, sql, fragments) => {
    const { crossDbSources } = parseSqlBody(sql);
    for (const fragment of fragments as string[]) {
      expect(
        mentions(crossDbSources, fragment),
        `${fragment} must not be a cross-DB source`,
      ).toBe(false);
    }
  });

  it('still captures a cross-database table-valued function reached through CROSS APPLY', () => {
    const result = parseSqlBody(`
      SELECT * FROM dbo.FactSales s
      CROSS APPLY OtherDB.dbo.fn_tvf(s.key) t
    `);
    expect(mentions(result.crossDbSources, 'otherdb')).toBe(true);
    expect(mentions(result.crossDbSources, 'fn_tvf')).toBe(true);
  });
});

describe('extractExternalRefs', () => {
  const REFS: Array<{
    name: string;
    sql: string;
    count: number;
    kind?: string;
  }> = [
    {
      name: 'COPY INTO ... FROM',
      sql: `
        COPY INTO dbo.TargetTable FROM 'https://storage.blob.core.windows.net/data/input.csv'
        WITH (FILE_TYPE = 'CSV')
      `,
      count: 1,
      kind: 'copy_from',
    },
    {
      name: 'BULK INSERT ... FROM',
      sql: `
        BULK INSERT dbo.TargetTable FROM 'C:\\Data\\import.csv'
        WITH (FIELDTERMINATOR = ',')
      `,
      count: 1,
      kind: 'bulk_from',
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
      count: 1,
      kind: 'openrowset',
    },
    {
      name: 'COPY INTO carrying a SAS credential',
      sql: `
        COPY INTO dbo.FactSales
        FROM 'https://mydatalake.blob.core.windows.net/staging/sales/*.parquet'
        WITH (
          FILE_TYPE = 'PARQUET',
          CREDENTIAL = (IDENTITY = 'Shared Access Signature', SECRET = 'sv=2020-08-04&ss=b')
        )
      `,
      count: 1,
      kind: 'copy_from',
    },
    {
      name: 'BULK INSERT from a UNC path',
      sql: `
        BULK INSERT dbo.ImportedData
        FROM '\\\\fileserver\\data\\export_20240101.csv'
        WITH (FIELDTERMINATOR = '|', ROWTERMINATOR = '\\n', FIRSTROW = 2)
      `,
      count: 1,
      kind: 'bulk_from',
    },
    {
      name: 'ordinary SQL with no external reference',
      sql: 'SELECT * FROM dbo.Orders',
      count: 0,
    },
  ];

  it.each(REFS)('$name', ({ sql, count, kind }) => {
    const refs = extractExternalRefs(sql);
    expect(refs).toHaveLength(count);
    if (kind) expect(refs[0].kind).toBe(kind);
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
    expect(extractExternalRefs(body)).toHaveLength(1);
    expect(mentions(parseSqlBody(body).crossDbSources, 'archivedb')).toBe(true);
  });
});

describe('OPENXML', () => {
  it('OPENXML and its preparedocument handle produce no source, target, or exec call', () => {
    const result = parseSqlBody(`
      EXEC sp_xml_preparedocument @hdoc OUTPUT, @xml
      SELECT * FROM OPENXML(@hdoc, '/root/row', 2) WITH (id INT, name NVARCHAR(50))
    `);
    expect(result.sources).toEqual([]);
    expect(result.targets).toEqual([]);
    expect(result.execCalls).toEqual([]);
  });
});

describe('a bracketed identifier is not a string literal', () => {
  table([
    {
      name: 'a doubled bracket inside a bracketed name does not swallow the statement after it',
      sql: 'SELECT * FROM [dbo].[a]]b] /* FROM dbo.GhostTable */; INSERT INTO dbo.Dim SELECT 1;',
      targets: ['Dim'],
      noSources: ['GhostTable'],
    },
  ]);
});

describe('CTAS carries its distribution clause', () => {
  table([
    {
      name: 'a plain CREATE TABLE followed by an unrelated CTAS does not claim the first table',
      sql: 'CREATE TABLE dbo.Plain (id INT); CREATE TABLE dbo.Derived WITH (DISTRIBUTION = ROUND_ROBIN) AS SELECT id FROM dbo.Src;',
      targets: ['Derived'],
      noTargets: ['plain'],
    },
  ]);
});

describe('complete dependency extraction', () => {
  it('collects every reference in a body with more than ten thousand matches', () => {
    const selects = Array.from(
      { length: 10_001 },
      (_, i) => `SELECT * FROM [dbo].[T${i}]`,
    ).join('\n');
    const parsed = parseSqlBody(selects);
    expect(parsed.sources).toHaveLength(10_001);
    expect(parsed.sources.at(-1)).toBe('[dbo].[t10000]');
    expect(parsed.targets).toEqual([]);
  });
});
