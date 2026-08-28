/**
 * Comprehensive syntactic edge-case tests for the SQL body parser.
 *
 * @remarks
 * Every case is its own test. These are independent claims about T-SQL — that a string
 * containing `--` is not a comment, that a CTE name is not a table, that a CLR method call
 * is not a cross-database reference — and one failing must not conceal the rest.
 *
 * Uniform cases go through the `CASES` tables below; a case needing a bespoke assertion
 * gets its own `it`. `-- EXPECT`-annotated .sql fixtures under tests/fixtures/sql/targeted/
 * cover the same parser through tsql-complex.test.ts and are the cheaper place to add a
 * new construct — prefer a fixture unless the assertion cannot be expressed there.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { extractExternalRefs, parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { hasName, loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

/** Exact match including schema, ignoring brackets and case. */
function hasExact(list: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some(entry => entry.replace(/\[|\]/g, '').toLowerCase() === lower);
}

const mentions = (list: string[], needle: string) =>
  list.some(entry => entry.toLowerCase().includes(needle.toLowerCase()));

/**
 * One parser expectation.
 *
 * @remarks
 * `no*` fields are case-insensitive substring checks, which is how the original
 * negatives were written: a false positive shows up as the fragment appearing anywhere
 * in the captured name.
 */
type ParseCase = {
  name: string;
  sql: string;
  /** Matched on the last name part (see `hasName`). */
  sources?: string[];
  /** Matched on the full `schema.object`. */
  exactSources?: string[];
  noSources?: string[];
  targets?: string[];
  noTargets?: string[];
  exec?: string[];
  noExec?: string[];
  /** Compared verbatim against the lower-cased cross-database arrays. */
  crossDbSources?: string[];
  crossDbTargets?: string[];
  sourceCount?: number;
};

function check(testCase: ParseCase): void {
  const result = parseSqlBody(testCase.sql);

  for (const name of testCase.sources ?? []) {
    expect(hasName(result.sources, name), `source ${name}`).toBe(true);
  }
  for (const name of testCase.exactSources ?? []) {
    expect(hasExact(result.sources, name), `exact source ${name}`).toBe(true);
  }
  for (const name of testCase.noSources ?? []) {
    expect(mentions(result.sources, name), `${name} must not be a source`).toBe(false);
  }
  for (const name of testCase.targets ?? []) {
    expect(hasName(result.targets, name), `target ${name}`).toBe(true);
  }
  for (const name of testCase.noTargets ?? []) {
    expect(mentions(result.targets, name), `${name} must not be a target`).toBe(false);
  }
  for (const name of testCase.exec ?? []) {
    expect(hasName(result.execCalls, name), `exec ${name}`).toBe(true);
  }
  for (const name of testCase.noExec ?? []) {
    expect(mentions(result.execCalls, name), `${name} must not be an exec call`).toBe(false);
  }
  for (const name of testCase.crossDbSources ?? []) {
    expect(result.crossDbSources.map(entry => entry.toLowerCase())).toContain(name);
  }
  for (const name of testCase.crossDbTargets ?? []) {
    expect(result.crossDbTargets.map(entry => entry.toLowerCase())).toContain(name);
  }
  if (testCase.sourceCount !== undefined) {
    expect(result.sources, 'source count').toHaveLength(testCase.sourceCount);
  }
}

const table = (cases: ParseCase[]) => it.each(cases)('$name', check);

// ─── 1. Preprocessing (clean_sql) ─────────────────────────────────────────────

describe('preprocessing — comments and strings', () => {
  table([
    {
      name: 'a string containing -- is not treated as a comment',
      sql: `SELECT * FROM [dbo].[T1] WHERE x = '-- not a comment' AND y = 1`,
      sources: ['T1'],
    },
    {
      name: 'a string containing /* */ is not treated as a comment',
      sql: `SELECT * FROM [dbo].[T1] WHERE x = '/* not a comment */' AND y = 1`,
      sources: ['T1'],
    },
    {
      name: 'a table named inside a block comment is not extracted',
      sql: `SELECT /* FROM [dbo].[Fake] */ * FROM [dbo].[Real]`,
      sources: ['Real'],
      noSources: ['Fake'],
    },
    {
      name: 'a table named after a trailing line comment is not extracted',
      sql: `SELECT * FROM [dbo].[T1] -- FROM [dbo].[Fake]`,
      sources: ['T1'],
      noSources: ['Fake'],
    },
    {
      name: 'a table named inside an N-prefixed string is not extracted',
      sql: `SELECT * FROM [dbo].[Real] WHERE Name = N'FROM [dbo].[Fake]' AND x = 1`,
      sources: ['Real'],
      noSources: ['Fake'],
    },
    {
      name: 'an empty string literal does not break extraction',
      sql: `SELECT * FROM [dbo].[T1] WHERE x = '' AND y = 1`,
      sources: ['T1'],
    },
    {
      name: 'a doubled quote inside a string does not break extraction',
      sql: `SELECT * FROM [dbo].[T1] WHERE x = 'it''s' AND y = 1`,
      sources: ['T1'],
    },
    {
      name: 'several string literals do not break extraction',
      sql: `SELECT * FROM [dbo].[T1] WHERE x = 'a' AND y = 'b' AND z = 1`,
      sources: ['T1'],
    },
  ]);
});

describe('preprocessing — bracketed identifiers', () => {
  table([
    { name: 'a bracketed name containing a dash', sql: 'SELECT * FROM [dbo].[my-table]', exactSources: ['dbo.my-table'] },
    { name: 'a bracketed name containing a space', sql: 'SELECT * FROM [dbo].[my table]', exactSources: ['dbo.my table'] },
    { name: 'a bracketed name containing --', sql: 'SELECT * FROM [dbo].[my--table]', exactSources: ['dbo.my--table'] },
  ]);
});

describe('preprocessing — nested block comments', () => {
  table([
    {
      name: 'a non-nested block comment is removed',
      sql: 'SELECT * FROM /* this is a comment */ [dbo].[Orders]',
      sources: ['Orders'],
    },
    {
      name: 'a nested block comment leaves no trailing text behind',
      sql: 'SELECT * FROM [dbo].[Orders] /* outer /* inner */ still here */ WHERE 1=1',
      sources: ['Orders'],
      noSources: ['still'],
    },
    {
      name: 'a block comment nested three deep is removed whole',
      sql: '/* depth /* two /* three */ two */ one */ INSERT INTO [dbo].[T] SELECT * FROM [dbo].[S]',
      targets: ['T'],
      sources: ['S'],
    },
  ]);
});

// ─── 2. Source extraction (FROM / JOIN) ───────────────────────────────────────

describe('source extraction', () => {
  table([
    { name: 'FROM with a bracketed two-part name', sql: 'SELECT * FROM [dbo].[Orders]', exactSources: ['dbo.Orders'] },
    { name: 'FROM with a non-dbo schema', sql: 'SELECT * FROM [Sales].[Orders]', exactSources: ['Sales.Orders'] },
    { name: 'FROM with a bare, unbracketed name', sql: 'SELECT * FROM dbo.Orders', exactSources: ['dbo.Orders'] },
    {
      name: 'INNER JOIN captures both sides',
      sql: 'SELECT * FROM [dbo].[A] INNER JOIN [dbo].[B] ON A.id = B.id',
      sources: ['A', 'B'],
    },
    {
      name: 'LEFT OUTER JOIN captures both sides',
      sql: 'SELECT * FROM [dbo].[A] LEFT OUTER JOIN [dbo].[B] ON 1=1',
      sources: ['A', 'B'],
    },
    {
      name: 'FULL OUTER JOIN captures both sides',
      sql: 'SELECT * FROM [dbo].[A] FULL OUTER JOIN [dbo].[B] ON 1=1',
      sources: ['A', 'B'],
    },
    {
      name: 'RIGHT JOIN captures the joined table',
      sql: 'SELECT * FROM [dbo].[A] RIGHT JOIN [dbo].[B] ON 1=1',
      sources: ['B'],
    },
    { name: 'CROSS JOIN captures both sides', sql: 'SELECT * FROM [dbo].[A] CROSS JOIN [dbo].[B]', sources: ['A', 'B'] },
    {
      name: 'a chain of JOINs captures every table',
      sql: 'SELECT * FROM [dbo].[A] JOIN [dbo].[B] ON 1=1 JOIN [dbo].[C] ON 1=1',
      sources: ['A', 'B', 'C'],
    },
    {
      name: 'CROSS APPLY captures the table and the applied function',
      sql: 'SELECT * FROM [dbo].[A] CROSS APPLY [dbo].[Func](A.id)',
      sources: ['A', 'Func'],
    },
    {
      name: 'OUTER APPLY captures the table and the applied function',
      sql: 'SELECT * FROM [dbo].[A] OUTER APPLY [dbo].[TVF](A.id)',
      sources: ['A', 'TVF'],
    },
    {
      name: 'MERGE USING captures the source side',
      sql: 'MERGE [dbo].[Target] USING [dbo].[Source] ON 1=1 WHEN MATCHED THEN DELETE;',
      sources: ['Source'],
    },
    {
      name: 'FROM separated by newlines',
      sql: 'SELECT *\n  FROM\n    [dbo].[Orders]',
      sources: ['Orders'],
    },
    {
      name: 'a mixed bracketed and bare name',
      sql: 'SELECT * FROM [dbo].Orders',
      sources: ['Orders'],
    },
    {
      name: 'a bracketed name that is a SQL keyword is still a table',
      sql: 'SELECT * FROM [dbo].[select]',
      exactSources: ['dbo.select'],
    },
    {
      name: 'a double-quoted identifier normalizes to bracket form',
      sql: 'SELECT * FROM "dbo"."Orders"',
      exactSources: ['dbo.Orders'],
    },
  ]);
});

// ─── 3. Target extraction ─────────────────────────────────────────────────────

describe('target extraction', () => {
  table([
    {
      name: 'INSERT INTO captures the target and the SELECT source',
      sql: 'INSERT INTO [dbo].[Target](col1) SELECT * FROM [dbo].[Source]',
      targets: ['Target'], sources: ['Source'],
    },
    {
      name: 'INSERT without INTO captures the target',
      sql: 'INSERT [dbo].[Target] SELECT * FROM [dbo].[Source]',
      targets: ['Target'], sources: ['Source'],
    },
    { name: 'UPDATE captures the target', sql: 'UPDATE [dbo].[Target] SET col = 1', targets: ['Target'] },
    {
      name: 'UPDATE ... FROM captures the target and the source',
      sql: 'UPDATE [dbo].[Target] SET col = s.val FROM [dbo].[Source] s',
      targets: ['Target'], sources: ['Source'],
    },
    {
      name: 'MERGE INTO captures the target and the USING source',
      sql: 'MERGE INTO [dbo].[Target] USING [dbo].[Source] ON 1=1 WHEN NOT MATCHED THEN INSERT(col) VALUES(1);',
      targets: ['Target'], sources: ['Source'],
    },
    {
      name: 'CTAS captures the new table as a target',
      sql: 'CREATE TABLE [dbo].[NewTable] AS SELECT * FROM [dbo].[Source]',
      targets: ['NewTable'], sources: ['Source'],
    },
    {
      name: 'SELECT INTO captures the new table as a target',
      sql: 'SELECT * INTO [dbo].[NewTable] FROM [dbo].[Source]',
      targets: ['NewTable'], sources: ['Source'],
    },
    {
      name: 'INSERT INTO with a column list keeps the UDF a source, not a target',
      sql: 'INSERT INTO [dbo].[T1](col1, col2) VALUES(1, dbo.udfCalc(x))',
      targets: ['T1'], exactSources: ['dbo.udfCalc'],
    },
    {
      name: 'COPY INTO captures the target',
      sql: `COPY INTO [staging].[RawData] FROM 'https://storage.blob.core.windows.net/container/file.parquet'`,
      targets: ['RawData'],
    },
    {
      name: 'COPY INTO with a WITH clause captures the target',
      sql: `COPY INTO [dbo].[FactSales]
        FROM 'abfss://container@account.dfs.core.windows.net/data/*.csv'
        WITH (FILE_TYPE = 'CSV', FIRSTROW = 2)`,
      targets: ['FactSales'],
    },
    {
      name: 'BULK INSERT captures the target',
      sql: `BULK INSERT [dbo].[ImportData] FROM '\\\\server\\share\\data.csv'`,
      targets: ['ImportData'],
    },
    {
      name: 'BULK INSERT with options captures the target',
      sql: `BULK INSERT [staging].[RawImport]
        FROM 'C:\\data\\export.csv'
        WITH (FIELDTERMINATOR = ',', ROWTERMINATOR = '\\n', FIRSTROW = 2)`,
      targets: ['RawImport'],
    },
    {
      name: 'INSERT separated by tabs captures both sides',
      sql: 'INSERT\tINTO\t[dbo].[Target]\tSELECT * FROM\t[dbo].[Source]',
      targets: ['Target'], sources: ['Source'],
    },
    {
      name: 'a table written and read in one UPDATE is both target and source',
      sql: 'UPDATE [dbo].[T1] SET col = s.val FROM [dbo].[T1] s WHERE s.id > 0',
      targets: ['T1'], sources: ['T1'],
    },
    {
      name: 'UPDATE through an alias resolves to the aliased table, which is also a source',
      sql: 'UPDATE t SET t.col = s.val FROM [dbo].[Target] t INNER JOIN [dbo].[Source] s ON t.id = s.id',
      targets: ['Target'], sources: ['Target', 'Source'],
    },
    {
      name: 'several statements in one body each contribute their own dependency',
      sql: `
        INSERT INTO [dbo].[A] SELECT * FROM [dbo].[B]
        UPDATE [dbo].[C] SET x = 1
        EXEC [dbo].[D]
      `,
      targets: ['A', 'C'], sources: ['B'], exec: ['D'],
    },
  ]);

  it('does not treat a column list as a UDF call that reads the target', () => {
    const result = parseSqlBody(`INSERT INTO [dbo].[Audit](msg, ts) VALUES('test', GETDATE())`);
    expect(hasName(result.targets, 'Audit')).toBe(true);
    expect(hasExact(result.sources, 'dbo.Audit')).toBe(false);
  });

  it('does not report the target of a column-list INSERT as a source', () => {
    const result = parseSqlBody('INSERT [staging].[Orders](id, amount) SELECT id, amt FROM [dbo].[Raw]');
    expect(hasName(result.targets, 'Orders')).toBe(true);
    expect(hasExact(result.sources, 'staging.Orders')).toBe(false);
    expect(hasName(result.sources, 'Raw')).toBe(true);
  });

  it('does not make DELETE FROM a target — it removes rows, writing no column data', () => {
    const result = parseSqlBody('DELETE FROM [dbo].[Target] WHERE Id = 1');
    expect(hasName(result.targets, 'Target')).toBe(false);
    // The FROM keyword still fires source extraction, so it remains a read reference.
    expect(hasName(result.sources, 'Target')).toBe(true);
  });
});

// ─── 4. EXEC calls ────────────────────────────────────────────────────────────

describe('procedure calls', () => {
  table([
    { name: 'EXEC with a bracketed name', sql: 'EXEC [dbo].[MyProc]', exec: ['MyProc'] },
    { name: 'EXECUTE spelled in full', sql: 'EXECUTE [dbo].[MyProc]', exec: ['MyProc'] },
    { name: 'EXEC with parameters', sql: `EXEC [dbo].[MyProc] @p1 = 1, @p2 = 'abc'`, exec: ['MyProc'] },
    { name: 'EXEC assigning a return value', sql: 'EXEC @result = [dbo].[MyProc] @p1 = 1', exec: ['MyProc'] },
    { name: 'EXEC assigning a return value without spaces', sql: 'EXEC @result=[dbo].[CalcTotal] @input=5', exec: ['CalcTotal'] },
    { name: 'EXEC with a bare name', sql: 'EXEC dbo.MyProc', exec: ['MyProc'] },
    { name: 'two EXEC statements', sql: 'EXEC [dbo].[P1]\nEXEC [dbo].[P2]', exec: ['P1', 'P2'] },
    {
      name: 'an EXEC after a string containing -- is still found',
      sql: `
        SET @msg = ' <--- Start ETL --->'
        EXEC [dbo].[LogStart]
        INSERT INTO [dbo].[Target] SELECT * FROM [dbo].[Source]
        EXEC [dbo].[LogEnd]
      `,
      exec: ['LogStart', 'LogEnd'], targets: ['Target'], sources: ['Source'],
    },
  ]);

  it('preserves a dot inside a bracketed procedure name as part of the identifier', () => {
    expect(parseSqlBody('EXEC [dbo].[spLoad_Case4.5]').execCalls
      .map(entry => entry.toLowerCase())).toContain('[dbo].[spload_case4.5]');
  });

  it('preserves a dot inside a bracketed table name as part of the identifier', () => {
    expect(parseSqlBody('SELECT * FROM [staging].[view.name]').sources
      .map(entry => entry.toLowerCase())).toContain('[staging].[view.name]');
  });
});

// ─── 5. UDF extraction ────────────────────────────────────────────────────────

describe('UDF extraction', () => {
  table([
    {
      name: 'an inline scalar UDF is captured as a source',
      sql: 'SELECT dbo.udfDivide(x, y) FROM [dbo].[T1]',
      sources: ['T1'], exactSources: ['dbo.udfDivide'],
    },
    {
      name: 'two UDFs in one SELECT are both captured',
      sql: 'SELECT dbo.udfA(1), dbo.udfB(2) FROM [dbo].[T1]',
      sources: ['T1'], exactSources: ['dbo.udfA', 'dbo.udfB'],
    },
    {
      name: 'a bracketed UDF name is captured',
      sql: 'SELECT [dbo].[udfCalc](x) FROM [dbo].[T1]',
      sources: ['T1'], exactSources: ['dbo.udfCalc'],
    },
    {
      name: 'a UDF in an INSERT ... SELECT is a source, never the target',
      sql: 'INSERT INTO [dbo].[Target](col) SELECT dbo.udfCalc(x) FROM [dbo].[Source]',
      targets: ['Target'], sources: ['Source'], exactSources: ['dbo.udfCalc'], noTargets: ['udfcalc'],
    },
    {
      name: 'a single-part built-in such as GETDATE() is not a dependency',
      sql: 'SELECT GETDATE()',
      sourceCount: 0,
    },
    {
      name: 'a single-part built-in alongside a real table leaves only the table',
      sql: 'SELECT ISNULL(x, 0) FROM [dbo].[T1]',
      sources: ['T1'], sourceCount: 1,
    },
  ]);
});

// ─── 6. CTE exclusion ─────────────────────────────────────────────────────────

describe('CTE exclusion', () => {
  table([
    {
      name: 'a CTE name is not a source, but the tables inside and outside it are',
      sql: 'WITH MyCTE AS (SELECT * FROM [dbo].[T1]) SELECT * FROM MyCTE JOIN [dbo].[T2] ON 1=1',
      sources: ['T1', 'T2'], noSources: ['mycte'],
    },
    {
      name: 'an UPDATE through a CTE resolves to the base table, not the CTE name',
      sql: 'WITH Alias AS (SELECT * FROM [dbo].[Orders]) UPDATE Alias SET Amount = 0',
      targets: ['Orders'], sources: ['Orders'], noTargets: ['alias'],
    },
    {
      name: 'an UPDATE through a CTE with a WHERE clause resolves to the base table',
      sql: 'WITH Upd AS (SELECT Id, Val FROM [sales].[Prices]) UPDATE Upd SET Val = Val * 2 WHERE Id > 0',
      targets: ['Prices'], noTargets: ['upd'],
    },
    {
      name: 'an UPDATE aliasing a CTE in its FROM clause resolves to the base table',
      sql: `
        WITH cte_Result AS (SELECT * FROM [staging].[OrderWorker])
        UPDATE w SET w.Col = 1 FROM cte_Result w
      `,
      targets: ['OrderWorker'], sources: ['OrderWorker'], noTargets: ['cte_result'],
    },
    {
      name: 'an UPDATE through a chain of CTEs resolves to the original table',
      sql: `
        WITH BaseOrders AS (SELECT * FROM [dbo].[SalesOrder] WHERE Status = 'PENDING'),
        OrdersWithLimit AS (SELECT * FROM BaseOrders WHERE TotalAmount > 100)
        UPDATE OrdersWithLimit SET Status = 'APPROVED'
      `,
      targets: ['SalesOrder'], sources: ['SalesOrder'],
    },
    {
      name: 'an UPDATE aliasing a chained CTE resolves to the original table',
      sql: `
        WITH cte_Base AS (SELECT * FROM [warehouse].[Inventory]),
        cte_Filtered AS (SELECT * FROM cte_Base WHERE Qty > 0)
        UPDATE inv SET inv.Qty = 0 FROM cte_Filtered inv
      `,
      targets: ['Inventory'], sources: ['Inventory'],
    },
  ]);

  it('excludes every CTE name when several are declared', () => {
    const result = parseSqlBody(
      'WITH A AS (SELECT 1), B AS (SELECT 2) SELECT * FROM A JOIN B ON 1=1 JOIN [dbo].[T1] ON 1=1',
    );
    expect(hasName(result.sources, 'T1')).toBe(true);
    expect(result.sources.filter(entry => ['a', 'b'].includes(entry.replace(/\[|\]/g, '').toLowerCase())))
      .toEqual([]);
  });
});

// ─── 7. Extraction boundaries ─────────────────────────────────────────────────

describe('extraction boundaries', () => {
  table([
    { name: 'a temp table is not a dependency', sql: 'SELECT * FROM #TempTable', noSources: ['#'] },
    { name: 'a table variable is not a dependency', sql: 'SELECT * FROM @TableVar', noSources: ['@'], sourceCount: 0 },
    {
      name: 'an unqualified system procedure is not an exec call',
      sql: 'EXEC sp_executesql @sql',
      noExec: ['sp_executesql'],
    },
    {
      name: 'an unqualified system function is not a source',
      sql: 'SELECT * FROM fn_helpcollations',
      noSources: ['fn_helpcollations'],
    },
    {
      name: 'an unqualified table name is rejected — a dependency needs a schema',
      sql: 'SELECT * FROM UnqualifiedTable',
      sourceCount: 0,
    },
    {
      name: 'a temp-table INSERT target is dropped but the real source is kept',
      sql: 'INSERT INTO #TempTable SELECT * FROM [dbo].[Src]',
      noTargets: ['#'], sources: ['Src'],
    },
    {
      name: 'a keyword used as a column name after WHERE is not a source',
      sql: 'SELECT * FROM [dbo].[T1] WHERE set = 1',
      sources: ['T1'], noSources: ['set'],
    },
    {
      name: 'SQL inside an OPENQUERY string literal is not extracted',
      sql: `SELECT * FROM OPENQUERY(LinkedServer, 'SELECT * FROM dbo.Remote')`,
      noSources: ['remote'],
    },
    {
      name: 'SQL inside a dynamic EXEC string is not extracted',
      sql: `EXEC('INSERT INTO dbo.Secret SELECT * FROM dbo.Source')`,
      noTargets: ['Secret'], noSources: ['Source'],
    },
  ]);

  it('does not capture a single-character table alias as a source', () => {
    const result = parseSqlBody('SELECT * FROM [dbo].[Orders] o');
    expect(hasExact(result.sources, 'dbo.Orders')).toBe(true);
    expect(result.sources.map(entry => entry.replace(/\[|\]/g, ''))).not.toContain('o');
  });

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

// ─── 8. Combined complex SQL ──────────────────────────────────────────────────

describe('a complete procedure body', () => {
  const sql = `
-- This is a comment
INSERT INTO [dbo].[Audit](Msg)
SELECT N'Processing: ' + dbo.udfFormat(x)
FROM [dbo].[Source] s
INNER JOIN [dbo].[Lookup] l ON s.id = l.id
WHERE s.status = 'active -- not inactive'
EXEC [dbo].[LogComplete]
`;

  table([
    {
      name: 'captures both joined sources, the UDF, the insert target and the exec call',
      sql,
      sources: ['Source', 'Lookup'],
      exactSources: ['dbo.udfFormat'],
      targets: ['Audit'],
      exec: ['LogComplete'],
      noSources: ['Audit', 'inactive'],
    },
  ]);
});

// ─── 9. Three- and four-part names ────────────────────────────────────────────

describe('cross-database references', () => {
  table([
    {
      name: 'a three-part name is a cross-database source, not a local one',
      sql: 'SELECT * FROM OtherDB.dbo.RemoteTable',
      crossDbSources: ['otherdb.dbo.remotetable'], noSources: ['remotetable'],
    },
    {
      name: 'a three-part bare name routes to the cross-database sources',
      sql: 'SELECT * FROM MyDB.dbo.Orders',
      crossDbSources: ['mydb.dbo.orders'], noSources: ['orders'],
    },
    {
      name: 'a three-part bracketed INSERT target routes to the cross-database targets',
      sql: 'INSERT INTO [MyDB].[staging].[Orders] SELECT 1',
      crossDbTargets: ['mydb.staging.orders'], noTargets: ['orders'],
    },
    {
      name: 'a four-part linked-server name drops the server and keeps the last three parts',
      sql: 'SELECT * FROM [Server].[DB].[dbo].[Orders]',
      crossDbSources: ['db.dbo.orders'], noSources: ['orders'],
    },
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
    {
      name: 'a four-part linked-server reference in a procedure strips the server name',
      sql: `
        CREATE PROCEDURE [dbo].[spRemoteLoad] AS
        SELECT * FROM LinkedSrv.RemoteDB.dbo.Customers
      `,
      crossDbSources: ['remotedb.dbo.customers'],
    },
  ]);

  it('does not leave the linked-server name anywhere in the cross-database sources', () => {
    const result = parseSqlBody(`
      CREATE PROCEDURE [dbo].[spRemoteLoad] AS
      SELECT * FROM LinkedSrv.RemoteDB.dbo.Customers
    `);
    expect(mentions(result.crossDbSources, 'linkedsrv')).toBe(false);
  });
});

// ─── 10. CLR method false positives ───────────────────────────────────────────

describe('CLR method calls are not cross-database references', () => {
  // `alias.column.Method(args)` is textually a three-part name. Admitting one invents a
  // database that does not exist, so each CLR family is guarded separately.
  table([
    {
      name: 'HierarchyID GetAncestor inside a recursive CTE',
      sql: `
        WITH EMP_cte (EmployeeID, OrganizationNode) AS (
          SELECT e.BusinessEntityID, e.OrganizationNode FROM HumanResources.Employee e
          UNION ALL
          SELECT e.BusinessEntityID, e.OrganizationNode
          FROM HumanResources.Employee e
          INNER JOIN EMP_cte ON EMP_cte.OrganizationNode.GetAncestor(1) = e.OrganizationNode
        )
        SELECT * FROM EMP_cte WHERE EmployeeID = @BusinessEntityID
      `,
      sources: ['Employee'],
    },
    {
      name: 'HierarchyID GetLevel in a SELECT list',
      sql: `
        SELECT e.BusinessEntityID, e.OrganizationNode.GetLevel() AS [Level]
        FROM HumanResources.Employee e
      `,
      sources: ['Employee'],
    },
    {
      name: 'geography STDistance in a SELECT and a WHERE',
      sql: `
        SELECT s.StoreID, s.Location.STDistance(@pt) AS Dist
        FROM Sales.Store s
        WHERE s.Location.STDistance(@pt) < 50000
      `,
      sources: ['Store'],
    },
    {
      name: 'geometry STArea in a SELECT list',
      sql: 'SELECT g.Name, g.SpatialLocation.STArea() AS Area FROM dbo.GeoObjects g',
      sources: ['GeoObjects'],
    },
  ]);

  it.each([
    ['HierarchyID GetAncestor', `
      WITH EMP_cte (EmployeeID, OrganizationNode) AS (
        SELECT e.BusinessEntityID, e.OrganizationNode FROM HumanResources.Employee e
        UNION ALL
        SELECT e.BusinessEntityID, e.OrganizationNode FROM HumanResources.Employee e
        INNER JOIN EMP_cte ON EMP_cte.OrganizationNode.GetAncestor(1) = e.OrganizationNode
      )
      SELECT * FROM EMP_cte`, ['getancestor', 'organizationnode']],
    ['HierarchyID GetLevel',
      'SELECT e.OrganizationNode.GetLevel() AS [Level] FROM HumanResources.Employee e', ['getlevel']],
    ['mixed-bracket GetAncestor',
      'INNER JOIN [EMP_cte] ON [EMP_cte].[OrganizationNode].GetAncestor(1) = e.OrganizationNode', ['getancestor']],
    ['geography STDistance',
      'SELECT s.Location.STDistance(@pt) AS Dist FROM Sales.Store s', ['stdistance', 'location']],
    ['geometry STArea',
      'SELECT g.SpatialLocation.STArea() AS Area FROM dbo.GeoObjects g', ['starea']],
    ['XML nodes() and value()', `
      SELECT x.n.value('text()[1]', 'nvarchar(100)') AS Val
      FROM dbo.XmlTable CROSS APPLY xmlcol.nodes('/root/item') x(n)`, ['value', 'nodes']],
  ])('%s produces no cross-database source', (_label, sql, fragments) => {
    const { crossDbSources } = parseSqlBody(sql);
    for (const fragment of fragments as string[]) {
      expect(mentions(crossDbSources, fragment), `${fragment} must not be a cross-DB source`).toBe(false);
    }
  });

  it('still captures a genuine three-part FROM and JOIN', () => {
    const result = parseSqlBody(`
      SELECT * FROM OtherDB.dbo.RemoteTable t
      INNER JOIN OtherDB.dbo.Lookup l ON t.id = l.id
    `);
    expect(result.crossDbSources.map(entry => entry.toLowerCase()))
      .toEqual(expect.arrayContaining(['otherdb.dbo.remotetable', 'otherdb.dbo.lookup']));
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

// ─── 11. CETAS ────────────────────────────────────────────────────────────────

describe('CETAS', () => {
  table([
    {
      name: 'CREATE EXTERNAL TABLE AS SELECT captures the external target and the source',
      sql: `
        CREATE EXTERNAL TABLE [ext].[SalesExport]
        WITH (LOCATION = '/export/sales/', DATA_SOURCE = ExtDS, FILE_FORMAT = ParquetFF)
        AS SELECT * FROM [dbo].[Sales]
      `,
      exactSources: ['dbo.Sales'], targets: ['SalesExport'],
    },
    {
      name: 'a plain CREATE EXTERNAL TABLE with no AS SELECT is not a target',
      sql: `
        CREATE EXTERNAL TABLE [ext].[RawData] (id INT, name VARCHAR(100))
        WITH (LOCATION = '/raw/', DATA_SOURCE = ExtDS)
      `,
      noTargets: ['rawdata'],
    },
    {
      name: 'a CETAS with a multi-option WITH clause captures both sides',
      sql: `
        CREATE PROCEDURE [dbo].[spExportPartitioned] AS
        CREATE EXTERNAL TABLE [ext].[PartitionedExport]
        WITH (
          LOCATION = '/export/partitioned/',
          DATA_SOURCE = MyLake,
          FILE_FORMAT = ParquetFormat,
          REJECT_TYPE = VALUE,
          REJECT_VALUE = 0
        )
        AS SELECT col1, col2 FROM [dbo].[BigTable]
      `,
      targets: ['PartitionedExport'], sources: ['BigTable'],
    },
    {
      name: 'a CETAS with an aggregate SELECT captures both sides',
      sql: `
        CREATE EXTERNAL TABLE [export].[DailyReport]
        WITH (
          LOCATION = '/reports/daily/',
          DATA_SOURCE = ExternalDataSource,
          FILE_FORMAT = ParquetFileFormat
        )
        AS SELECT
          OrderDate, SUM(Amount) AS TotalAmount
        FROM dbo.FactSales
        GROUP BY OrderDate
      `,
      targets: ['DailyReport'], sources: ['FactSales'],
    },
  ]);
});

// ─── 12. External file and URL references ─────────────────────────────────────

describe('extractExternalRefs', () => {
  const REFS: Array<{ name: string; sql: string; count: number; kind?: string }> = [
    {
      name: 'OPENROWSET BULK',
      sql: `
        SELECT * FROM OPENROWSET(BULK 'https://storage.blob.core.windows.net/data/sales.parquet',
        FORMAT = 'PARQUET') AS r
      `,
      count: 1, kind: 'openrowset',
    },
    {
      name: 'COPY INTO ... FROM',
      sql: `
        COPY INTO dbo.TargetTable FROM 'https://storage.blob.core.windows.net/data/input.csv'
        WITH (FILE_TYPE = 'CSV')
      `,
      count: 1, kind: 'copy_from',
    },
    {
      name: 'BULK INSERT ... FROM',
      sql: `
        BULK INSERT dbo.TargetTable FROM 'C:\\Data\\import.csv'
        WITH (FIELDTERMINATOR = ',')
      `,
      count: 1, kind: 'bulk_from',
    },
    {
      name: 'a Synapse serverless OPENROWSET with a wildcard path',
      sql: `
        SELECT r.filepath(1) AS [Year], r.filepath(2) AS [Month], *
        FROM OPENROWSET(
          BULK 'https://myaccount.dfs.core.windows.net/curated/fact_sales/year=*/month=*/*.parquet',
          FORMAT = 'DELTA'
        ) WITH (
          SalesKey INT, OrderDate DATE, Amount DECIMAL(18,2)
        ) AS r
      `,
      count: 1, kind: 'openrowset',
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
      count: 1, kind: 'copy_from',
    },
    {
      name: 'OPENROWSET inside a view body',
      sql: `
        CREATE VIEW [lake].[vwRawSales] AS
        SELECT * FROM OPENROWSET(
          BULK 'https://adls.dfs.core.windows.net/bronze/sales/*.csv',
          FORMAT = 'CSV', PARSER_VERSION = '2.0',
          HEADER_ROW = TRUE
        ) AS csv_data
      `,
      count: 1, kind: 'openrowset',
    },
    {
      name: 'BULK INSERT from a UNC path',
      sql: `
        BULK INSERT dbo.ImportedData
        FROM '\\\\fileserver\\data\\export_20240101.csv'
        WITH (FIELDTERMINATOR = '|', ROWTERMINATOR = '\\n', FIRSTROW = 2)
      `,
      count: 1, kind: 'bulk_from',
    },
    {
      name: 'the same URL read twice, deduplicated',
      sql: `
        SELECT * FROM OPENROWSET(BULK 'https://lake/data.parquet', FORMAT = 'PARQUET') AS a
        UNION ALL
        SELECT * FROM OPENROWSET(BULK 'https://lake/data.parquet', FORMAT = 'PARQUET') AS b
      `,
      count: 1,
    },
    {
      name: 'two distinct URLs',
      sql: `
        SELECT * FROM OPENROWSET(BULK 'https://lake/a.parquet', FORMAT = 'PARQUET') AS a
        UNION ALL
        SELECT * FROM OPENROWSET(BULK 'https://lake/b.parquet', FORMAT = 'PARQUET') AS b
      `,
      count: 2,
    },
    {
      name: 'ordinary SQL with no external reference',
      sql: 'SELECT * FROM dbo.Orders',
      count: 0,
    },
    {
      name: 'a non-BULK OPENROWSET connection string, which names no file',
      sql: `
        SELECT * FROM OPENROWSET('SQLNCLI', 'Server=remote;Database=Sales;Trusted_Connection=yes;',
          'SELECT * FROM dbo.Orders')
      `,
      count: 0,
    },
  ];

  it.each(REFS)('$name', ({ sql, count, kind }) => {
    const refs = extractExternalRefs(sql);
    expect(refs).toHaveLength(count);
    if (kind) expect(refs[0].kind).toBe(kind);
  });

  it('captures the URL itself, not merely the fact of a reference', () => {
    const [ref] = extractExternalRefs(`
      SELECT * FROM OPENROWSET(BULK 'https://storage.blob.core.windows.net/data/sales.parquet',
      FORMAT = 'PARQUET') AS r
    `);
    expect(ref.url).toContain('sales.parquet');
  });

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

// ─── 13. Constructs with no dedicated parse rule ──────────────────────────────
// None of these have a rule of their own; each rides on FROM/JOIN, INSERT, or the string-
// cleansing pass. Pinned here so a future rule change shows up as a diff against a known value.

describe('PIVOT and UNPIVOT', () => {
  table([
    {
      name: 'PIVOT captures the base table, not the pivot column list',
      sql: `SELECT * FROM dbo.SalesData
        PIVOT (SUM(Amount) FOR Year IN ([2020],[2021],[2022])) AS PivotTable`,
      exactSources: ['dbo.SalesData'],
      noSources: ['2020', '2021', '2022', 'pivottable'],
      sourceCount: 1,
    },
    {
      name: 'UNPIVOT captures the base table, not the pivot column list',
      sql: `SELECT * FROM dbo.SalesWide
        UNPIVOT (Amount FOR Year IN ([Y2020],[Y2021])) AS UnpivotTable`,
      exactSources: ['dbo.SalesWide'],
      noSources: ['y2020', 'y2021', 'unpivottable'],
      sourceCount: 1,
    },
  ]);
});

describe('OPENJSON and OPENXML', () => {
  // Both are single-part identifiers to the ANSI FROM rule (`normalizeCaptured` drops anything
  // under 2 dot-separated parts), and neither is followed by a `.` so `extract_udf_calls` never
  // sees them either — the function name itself never becomes a dependency.
  table([
    {
      name: 'OPENJSON is not captured as a source',
      sql: `SELECT * FROM OPENJSON(@json) WITH (id INT '$.id', name NVARCHAR(50) '$.name')`,
      sourceCount: 0,
    },
    {
      name: 'OPENJSON does not suppress the real INSERT target',
      sql: `INSERT INTO dbo.Target SELECT * FROM OPENJSON(@json) WITH (id INT '$.id')`,
      targets: ['Target'],
      sourceCount: 0,
    },
  ]);

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

describe('OPENQUERY and OPENDATASOURCE', () => {
  table([
    {
      name: 'OPENQUERY captures no source — the linked-server name and the quoted remote query both stay out',
      sql: `SELECT * FROM OPENQUERY(LinkedServer, 'SELECT * FROM dbo.Remote')`,
      sourceCount: 0,
    },
    {
      name: 'OPENDATASOURCE captures no source — the provider string and connection string do not leak',
      // The four-part `OPENDATASOURCE(...).dbo.RemoteTable` reference itself is not recognized either:
      // real T-SQL treats it as a source, but nothing here precedes `dbo.RemoteTable` with FROM/JOIN or
      // a dot-prefixed call, so it is silently dropped rather than falsely captured.
      sql: `SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Server=Remote;Trusted_Connection=yes').dbo.RemoteTable`,
      sourceCount: 0,
    },
  ]);

  it('neither OPENQUERY nor OPENDATASOURCE is picked up as an external file/URL reference', () => {
    expect(extractExternalRefs(`SELECT * FROM OPENQUERY(LinkedServer, 'SELECT * FROM dbo.Remote')`)).toEqual([]);
    expect(extractExternalRefs(
      `SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Server=Remote;Trusted_Connection=yes').dbo.RemoteTable`,
    )).toEqual([]);
  });
});

describe('FOR SYSTEM_TIME AS OF', () => {
  table([
    {
      name: 'the temporal table itself is still captured as a source',
      sql: `SELECT * FROM dbo.Employee FOR SYSTEM_TIME AS OF '2020-01-01'`,
      exactSources: ['dbo.Employee'],
      sourceCount: 1,
    },
  ]);
});

describe('table hints', () => {
  table([
    {
      name: 'WITH (NOLOCK) leaves the table captured and the hint uncaptured',
      sql: 'SELECT * FROM dbo.T WITH (NOLOCK)',
      exactSources: ['dbo.T'],
      noSources: ['nolock'],
      sourceCount: 1,
    },
  ]);
});

describe('OPTION (RECOMPILE)', () => {
  table([
    {
      name: 'a trailing OPTION clause leaves the table captured and RECOMPILE uncaptured',
      sql: 'SELECT * FROM dbo.T WHERE 1 = 1 OPTION (RECOMPILE)',
      exactSources: ['dbo.T'],
      noSources: ['recompile'],
      sourceCount: 1,
    },
  ]);
});

describe('COLLATE clause', () => {
  table([
    {
      name: 'a COLLATE clause leaves the table captured and the collation name uncaptured',
      sql: `SELECT * FROM dbo.T WHERE Name = 'x' COLLATE SQL_Latin1_General_CP1_CI_AS`,
      exactSources: ['dbo.T'],
      noSources: ['collate', 'latin1'],
      sourceCount: 1,
    },
  ]);
});

describe('UNION / EXCEPT / INTERSECT', () => {
  table([
    {
      name: 'UNION captures the FROM of every branch',
      sql: 'SELECT * FROM dbo.A UNION SELECT * FROM dbo.B',
      exactSources: ['dbo.A', 'dbo.B'],
      sourceCount: 2,
    },
    {
      name: 'UNION ALL captures the FROM of every branch',
      sql: 'SELECT * FROM dbo.A UNION ALL SELECT * FROM dbo.B',
      exactSources: ['dbo.A', 'dbo.B'],
      sourceCount: 2,
    },
    {
      name: 'EXCEPT captures the FROM of both branches',
      sql: 'SELECT * FROM dbo.A EXCEPT SELECT * FROM dbo.B',
      exactSources: ['dbo.A', 'dbo.B'],
      sourceCount: 2,
    },
    {
      name: 'INTERSECT captures the FROM of both branches',
      sql: 'SELECT * FROM dbo.A INTERSECT SELECT * FROM dbo.B',
      exactSources: ['dbo.A', 'dbo.B'],
      sourceCount: 2,
    },
  ]);
});

describe('GO batch separators', () => {
  table([
    {
      name: 'a GO between two SELECT statements does not stop either FROM from being captured',
      sql: 'SELECT * FROM dbo.A\nGO\nSELECT * FROM dbo.B',
      exactSources: ['dbo.A', 'dbo.B'],
      sourceCount: 2,
    },
    {
      name: 'a GO between an INSERT and a SELECT still captures the target on one side and the source on the other',
      sql: 'INSERT INTO dbo.Log(Msg) VALUES (1)\nGO\nSELECT * FROM dbo.T',
      targets: ['Log'],
      exactSources: ['dbo.T'],
      sourceCount: 1,
    },
  ]);
});

describe('TABLESAMPLE', () => {
  table([
    {
      name: 'TABLESAMPLE leaves the table captured and the sample clause uncaptured',
      sql: 'SELECT * FROM dbo.T TABLESAMPLE (10 PERCENT)',
      exactSources: ['dbo.T'],
      noSources: ['percent', 'tablesample'],
      sourceCount: 1,
    },
  ]);
});

// ─── 14. Statement boundaries and pass ordering ───────────────────────────────

describe('UPDATE alias target does not cross a statement boundary', () => {
  table([
    {
      name: 'an unqualified UPDATE does not claim a table read by a later statement',
      // The alias rule exists for `UPDATE u SET ... FROM schema.table`, where the target is
      // only knowable from the FROM. Bounded by `;` it cannot reach into the next statement,
      // so an unrelated later read stays a source and never becomes a target.
      sql: 'UPDATE t SET col = 1;\nSELECT x FROM dbo.UnrelatedNextStatement;',
      exactSources: ['dbo.UnrelatedNextStatement'],
      noTargets: ['unrelatednextstatement'],
    },
    {
      name: 'the alias form still resolves its target from the FROM inside one statement',
      sql: 'UPDATE u SET u.Total = s.Amt FROM dbo.OrderTotal u JOIN dbo.Staging s ON s.id = u.id;',
      targets: ['OrderTotal'],
    },
  ]);
});

describe('CREATE TABLE is not a function call', () => {
  table([
    {
      name: 'a permanent table created in the body is not captured as a source',
      // extract_udf_calls matches any `schema.name(`, and the suppression that rescues
      // `INSERT INTO dbo.T (cols)` only drops a UDF source that is also a target — which a
      // plain CREATE TABLE never is. Without an exclusion the created table becomes a read,
      // drawing the dependency arrow backwards.
      sql: 'CREATE TABLE dbo.StageBatch (id INT NOT NULL); SELECT id FROM dbo.Source;',
      exactSources: ['dbo.Source'],
      noSources: ['stagebatch'],
      sourceCount: 1,
    },
    {
      name: 'a genuine schema-qualified UDF call is still captured',
      sql: 'SELECT dbo.fn_Rate(o.Amount) FROM dbo.Orders o;',
      sources: ['fn_Rate'],
    },
  ]);
});

describe('a wildcard path in a string literal is not a comment', () => {
  table([
    {
      name: 'statements after a wildcard storage path are still parsed',
      // Pass 0 strips block comments from raw SQL, before Pass 1 neutralises string
      // literals. A path such as '.../01/*.parquet' contains `/*`, which opens a comment
      // that never closes — and the unterminated-comment guard then discards the whole
      // remainder of the body, silently. Wildcards in a storage path are ordinary
      // OPENROWSET/COPY INTO usage on Fabric and Synapse.
      sql:
        "COPY INTO dbo.Fact FROM 'https://acct.blob.core.windows.net/sales/2024/01/*.parquet' WITH (FILE_TYPE = 'PARQUET');"
        + ' INSERT INTO dbo.Dim SELECT c.id FROM stg.Customer c;'
        + ' EXEC dbo.usp_Audit;',
      targets: ['Fact', 'Dim'],
      exactSources: ['stg.Customer'],
      exec: ['usp_Audit'],
    },
    {
      name: 'a real block comment is still removed, including a nested one',
      sql: 'SELECT * FROM dbo.Keep /* outer /* inner */ still comment */ WHERE 1 = 1',
      exactSources: ['dbo.Keep'],
      noSources: ['inner', 'outer'],
      sourceCount: 1,
    },
    {
      name: "an apostrophe inside a block comment does not swallow the statement after it",
      sql: "/* don't trust this */ SELECT * FROM dbo.Kept",
      exactSources: ['dbo.Kept'],
      sourceCount: 1,
    },
  ]);
});
