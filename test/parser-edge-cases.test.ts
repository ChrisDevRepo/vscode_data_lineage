/**
 * Comprehensive syntactic edge-case tests for the SQL body parser.
 * Execute with: npx tsx test/parser-edge-cases.test.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { parseSqlBody, loadRules } from '../src/engine/sqlBodyParser';
import type { ParseRulesConfig } from '../src/engine/sqlBodyParser';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load built-in rules from single source of truth (assets/defaultParseRules.yaml)
const rulesYaml = readFileSync(resolve(__dirname, '../assets/defaultParseRules.yaml'), 'utf-8');
loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 ${msg}`);
    failed++;
  }
}

/** Helper: check that a list contains a value (case-insensitive partial match on the last part) */
function hasName(list: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some(s => {
    const norm = s.replace(/\[|\]/g, '').toLowerCase();
    // Match if the full normalized string equals the name, or if the last part after '.' matches
    if (norm === lower) return true;
    const parts = norm.split('.');
    return parts[parts.length - 1] === lower;
  });
}

/** Helper: check exact match including schema (case-insensitive) */
function hasExact(list: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some(s => s.replace(/\[|\]/g, '').toLowerCase() === lower);
}


// ═══════════════════════════════════════════════════════════════════════════
// 1. Preprocessing (clean_sql)
// ═══════════════════════════════════════════════════════════════════════════

function testPreprocessing() {
  console.log('\n\u2500\u2500 1. Preprocessing (clean_sql) \u2500\u2500');

  // String with -- inside
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] WHERE x = '-- not a comment' AND y = 1`);
    assert(hasName(r.sources, 'T1'), 'String with "--" inside: T1 found as source');
  }

  // String with /* inside
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] WHERE x = '/* not a comment */' AND y = 1`);
    assert(hasName(r.sources, 'T1'), 'String with "/*...*/" inside: T1 found as source');
  }

  // Block comment removing table
  {
    const r = parseSqlBody(`SELECT /* FROM [dbo].[Fake] */ * FROM [dbo].[Real]`);
    assert(hasName(r.sources, 'Real'), 'Block comment: Real found as source');
    assert(!hasName(r.sources, 'Fake'), 'Block comment: Fake NOT found (inside comment)');
  }

  // Line comment at end
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] -- FROM [dbo].[Fake]`);
    assert(hasName(r.sources, 'T1'), 'Line comment at end: T1 found');
    assert(!hasName(r.sources, 'Fake'), 'Line comment at end: Fake NOT found');
  }

  // Bracket-quoted name with dash
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[my-table]`);
    assert(hasExact(r.sources, 'dbo.my-table'), 'Bracket name with dash: dbo.my-table found');
  }

  // Bracket-quoted name with space
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[my table]`);
    assert(hasExact(r.sources, 'dbo.my table'), 'Bracket name with space: "dbo.my table" found');
  }

  // Bracket-quoted name with --
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[my--table]`);
    assert(hasExact(r.sources, 'dbo.my--table'), 'Bracket name with "--": "dbo.my--table" found');
  }

  // N-prefix strings
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[Real] WHERE Name = N'FROM [dbo].[Fake]' AND x = 1`);
    assert(hasName(r.sources, 'Real'), 'N-prefix string: Real found');
    assert(!hasName(r.sources, 'Fake'), 'N-prefix string: Fake NOT found (inside N-string)');
  }

  // Empty string
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] WHERE x = '' AND y = 1`);
    assert(hasName(r.sources, 'T1'), 'Empty string: T1 found');
  }

  // Escaped quotes
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] WHERE x = 'it''s' AND y = 1`);
    assert(hasName(r.sources, 'T1'), 'Escaped quotes: T1 found');
  }

  // Multiple strings
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] WHERE x = 'a' AND y = 'b' AND z = 1`);
    assert(hasName(r.sources, 'T1'), 'Multiple strings: T1 found');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 2. Source extraction (FROM/JOIN)
// ═══════════════════════════════════════════════════════════════════════════

function testSourceExtraction() {
  console.log('\n\u2500\u2500 2. Source extraction (FROM/JOIN) \u2500\u2500');

  // Simple FROM
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[Orders]`);
    assert(hasExact(r.sources, 'dbo.Orders'), 'Simple FROM: dbo.Orders found');
  }

  // FROM with schema
  {
    const r = parseSqlBody(`SELECT * FROM [Sales].[Orders]`);
    assert(hasExact(r.sources, 'Sales.Orders'), 'FROM with schema: Sales.Orders found');
  }

  // INNER JOIN
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] INNER JOIN [dbo].[B] ON A.id = B.id`);
    assert(hasName(r.sources, 'A'), 'INNER JOIN: A found');
    assert(hasName(r.sources, 'B'), 'INNER JOIN: B found');
  }

  // LEFT OUTER JOIN
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] LEFT OUTER JOIN [dbo].[B] ON 1=1`);
    assert(hasName(r.sources, 'A'), 'LEFT OUTER JOIN: A found');
    assert(hasName(r.sources, 'B'), 'LEFT OUTER JOIN: B found');
  }

  // CROSS JOIN
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] CROSS JOIN [dbo].[B]`);
    assert(hasName(r.sources, 'A'), 'CROSS JOIN: A found');
    assert(hasName(r.sources, 'B'), 'CROSS JOIN: B found');
  }

  // Multiple JOINs
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] JOIN [dbo].[B] ON 1=1 JOIN [dbo].[C] ON 1=1`);
    assert(hasName(r.sources, 'A'), 'Multiple JOINs: A found');
    assert(hasName(r.sources, 'B'), 'Multiple JOINs: B found');
    assert(hasName(r.sources, 'C'), 'Multiple JOINs: C found');
  }

  // Bare names (no brackets)
  {
    const r = parseSqlBody(`SELECT * FROM dbo.Orders`);
    assert(hasExact(r.sources, 'dbo.Orders'), 'Bare name: dbo.Orders found');
  }

  // CROSS APPLY
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] CROSS APPLY [dbo].[Func](A.id)`);
    assert(hasName(r.sources, 'A'), 'CROSS APPLY: A found');
    assert(hasName(r.sources, 'Func'), 'CROSS APPLY: Func found');
  }

  // OUTER APPLY
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] OUTER APPLY [dbo].[TVF](A.id)`);
    assert(hasName(r.sources, 'A'), 'OUTER APPLY: A found');
    assert(hasName(r.sources, 'TVF'), 'OUTER APPLY: TVF found');
  }

  // MERGE USING
  {
    const r = parseSqlBody(`MERGE [dbo].[Target] USING [dbo].[Source] ON 1=1 WHEN MATCHED THEN DELETE;`);
    assert(hasName(r.sources, 'Source'), 'MERGE USING: Source found');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 3. Target extraction (INSERT/UPDATE/MERGE/CTAS/SELECT INTO)
// ═══════════════════════════════════════════════════════════════════════════

function testTargetExtraction() {
  console.log('\n\u2500\u2500 3. Target extraction (INSERT/UPDATE/MERGE/CTAS/SELECT INTO/COPY INTO/BULK INSERT) \u2500\u2500');

  // INSERT INTO
  {
    const r = parseSqlBody(`INSERT INTO [dbo].[Target](col1) SELECT * FROM [dbo].[Source]`);
    assert(hasName(r.targets, 'Target'), 'INSERT INTO: Target found');
    assert(hasName(r.sources, 'Source'), 'INSERT INTO: Source found from SELECT');
  }

  // INSERT without INTO
  {
    const r = parseSqlBody(`INSERT [dbo].[Target] SELECT * FROM [dbo].[Source]`);
    assert(hasName(r.targets, 'Target'), 'INSERT (no INTO): Target found');
    assert(hasName(r.sources, 'Source'), 'INSERT (no INTO): Source found');
  }

  // UPDATE
  {
    const r = parseSqlBody(`UPDATE [dbo].[Target] SET col = 1`);
    assert(hasName(r.targets, 'Target'), 'UPDATE: Target found');
  }

  // UPDATE FROM
  {
    const r = parseSqlBody(`UPDATE [dbo].[Target] SET col = s.val FROM [dbo].[Source] s`);
    assert(hasName(r.targets, 'Target'), 'UPDATE FROM: Target found');
    assert(hasName(r.sources, 'Source'), 'UPDATE FROM: Source found');
  }

  // MERGE INTO
  {
    const r = parseSqlBody(`MERGE INTO [dbo].[Target] USING [dbo].[Source] ON 1=1 WHEN NOT MATCHED THEN INSERT(col) VALUES(1);`);
    assert(hasName(r.targets, 'Target'), 'MERGE INTO: Target found');
    assert(hasName(r.sources, 'Source'), 'MERGE INTO: Source found via USING');
  }

  // CTAS
  {
    const r = parseSqlBody(`CREATE TABLE [dbo].[NewTable] AS SELECT * FROM [dbo].[Source]`);
    assert(hasName(r.targets, 'NewTable'), 'CTAS: NewTable found as target');
    assert(hasName(r.sources, 'Source'), 'CTAS: Source found');
  }

  // SELECT INTO
  {
    const r = parseSqlBody(`SELECT * INTO [dbo].[NewTable] FROM [dbo].[Source]`);
    assert(hasName(r.targets, 'NewTable'), 'SELECT INTO: NewTable found as target');
    assert(hasName(r.sources, 'Source'), 'SELECT INTO: Source found');
  }

  // INSERT INTO with column list (UDF false positive guard)
  {
    const r = parseSqlBody(`INSERT INTO [dbo].[T1](col1, col2) VALUES(1, dbo.udfCalc(x))`);
    assert(hasName(r.targets, 'T1'), 'INSERT INTO + UDF: T1 is target');
    assert(hasName(r.sources, 'dbo.udfCalc') || hasExact(r.sources, 'dbo.udfCalc'),
      'INSERT INTO + UDF: dbo.udfCalc captured as source (UDF)');
  }

  // COPY INTO (Fabric/Synapse)
  {
    const r = parseSqlBody(`COPY INTO [staging].[RawData] FROM 'https://storage.blob.core.windows.net/container/file.parquet'`);
    assert(hasName(r.targets, 'RawData'), 'COPY INTO: RawData found as target');
  }

  // COPY INTO with brackets
  {
    const r = parseSqlBody(`COPY INTO [dbo].[FactSales]
      FROM 'abfss://container@account.dfs.core.windows.net/data/*.csv'
      WITH (FILE_TYPE = 'CSV', FIRSTROW = 2)`);
    assert(hasName(r.targets, 'FactSales'), 'COPY INTO bracketed: FactSales found as target');
  }

  // BULK INSERT
  {
    const r = parseSqlBody(`BULK INSERT [dbo].[ImportData] FROM '\\\\server\\share\\data.csv'`);
    assert(hasName(r.targets, 'ImportData'), 'BULK INSERT: ImportData found as target');
  }

  // BULK INSERT with options
  {
    const r = parseSqlBody(`BULK INSERT [staging].[RawImport]
      FROM 'C:\\data\\export.csv'
      WITH (FIELDTERMINATOR = ',', ROWTERMINATOR = '\\n', FIRSTROW = 2)`);
    assert(hasName(r.targets, 'RawImport'), 'BULK INSERT with options: RawImport found as target');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 4. EXEC calls
// ═══════════════════════════════════════════════════════════════════════════

function testExecCalls() {
  console.log('\n\u2500\u2500 4. EXEC calls \u2500\u2500');

  // Simple EXEC
  {
    const r = parseSqlBody(`EXEC [dbo].[MyProc]`);
    assert(hasName(r.execCalls, 'MyProc'), 'Simple EXEC: MyProc found');
  }

  // EXECUTE
  {
    const r = parseSqlBody(`EXECUTE [dbo].[MyProc]`);
    assert(hasName(r.execCalls, 'MyProc'), 'EXECUTE: MyProc found');
  }

  // EXEC with params
  {
    const r = parseSqlBody(`EXEC [dbo].[MyProc] @p1 = 1, @p2 = 'abc'`);
    assert(hasName(r.execCalls, 'MyProc'), 'EXEC with params: MyProc found');
  }

  // EXEC with return var
  {
    const r = parseSqlBody(`EXEC @result = [dbo].[MyProc] @p1 = 1`);
    assert(hasName(r.execCalls, 'MyProc'), 'EXEC with return var: MyProc found');
  }

  // EXEC bare name
  {
    const r = parseSqlBody(`EXEC dbo.MyProc`);
    assert(hasName(r.execCalls, 'MyProc'), 'EXEC bare name: MyProc found');
  }

  // Multiple EXECs
  {
    const r = parseSqlBody(`EXEC [dbo].[P1]\nEXEC [dbo].[P2]`);
    assert(hasName(r.execCalls, 'P1'), 'Multiple EXECs: P1 found');
    assert(hasName(r.execCalls, 'P2'), 'Multiple EXECs: P2 found');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 5. UDF extraction (extract_udf_calls)
// ═══════════════════════════════════════════════════════════════════════════

function testUdfExtraction() {
  console.log('\n\u2500\u2500 5. UDF extraction (extract_udf_calls) \u2500\u2500');

  // Inline scalar
  {
    const r = parseSqlBody(`SELECT dbo.udfDivide(x, y) FROM [dbo].[T1]`);
    assert(hasName(r.sources, 'T1'), 'Inline scalar UDF: T1 found');
    assert(hasExact(r.sources, 'dbo.udfDivide'), 'Inline scalar UDF: dbo.udfDivide found as source');
  }

  // Multiple UDFs
  {
    const r = parseSqlBody(`SELECT dbo.udfA(1), dbo.udfB(2) FROM [dbo].[T1]`);
    assert(hasName(r.sources, 'T1'), 'Multiple UDFs: T1 found');
    assert(hasExact(r.sources, 'dbo.udfA'), 'Multiple UDFs: dbo.udfA found');
    assert(hasExact(r.sources, 'dbo.udfB'), 'Multiple UDFs: dbo.udfB found');
  }

  // UDF with schema brackets
  {
    const r = parseSqlBody(`SELECT [dbo].[udfCalc](x) FROM [dbo].[T1]`);
    assert(hasName(r.sources, 'T1'), 'UDF with brackets: T1 found');
    assert(hasExact(r.sources, 'dbo.udfCalc'), 'UDF with brackets: dbo.udfCalc found');
  }

  // UDF NOT captured as target
  {
    const r = parseSqlBody(`INSERT INTO [dbo].[Target](col) SELECT dbo.udfCalc(x) FROM [dbo].[Source]`);
    assert(hasName(r.targets, 'Target'), 'UDF not target: Target is target');
    assert(hasName(r.sources, 'Source'), 'UDF not target: Source is source');
    assert(hasExact(r.sources, 'dbo.udfCalc'), 'UDF not target: dbo.udfCalc is source');
    assert(!hasExact(r.targets, 'dbo.udfCalc'), 'UDF not target: dbo.udfCalc is NOT a target');
  }

  // Single-part name NOT captured (built-in functions)
  {
    const r = parseSqlBody(`SELECT GETDATE()`);
    assert(r.sources.length === 0, 'Single-part GETDATE(): no sources (needs 2+ parts)');
  }

  // ISNULL etc NOT captured
  {
    const r = parseSqlBody(`SELECT ISNULL(x, 0) FROM [dbo].[T1]`);
    assert(r.sources.length === 1, `ISNULL: only 1 source (got ${r.sources.length})`);
    assert(hasName(r.sources, 'T1'), 'ISNULL: only T1 as source');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 6. CTE exclusion
// ═══════════════════════════════════════════════════════════════════════════

function testCteExclusion() {
  console.log('\n\u2500\u2500 6. CTE exclusion \u2500\u2500');

  // Single CTE
  {
    const r = parseSqlBody(`WITH MyCTE AS (SELECT * FROM [dbo].[T1]) SELECT * FROM MyCTE JOIN [dbo].[T2] ON 1=1`);
    assert(hasName(r.sources, 'T1'), 'Single CTE: T1 found (inside CTE)');
    assert(hasName(r.sources, 'T2'), 'Single CTE: T2 found (outside CTE)');
    assert(!hasName(r.sources, 'MyCTE'), 'Single CTE: MyCTE NOT in sources');
  }

  // Multiple CTEs
  {
    const r = parseSqlBody(`WITH A AS (SELECT 1), B AS (SELECT 2) SELECT * FROM A JOIN B ON 1=1 JOIN [dbo].[T1] ON 1=1`);
    assert(hasName(r.sources, 'T1'), 'Multiple CTEs: T1 found');
    assert(!r.sources.some(s => s.replace(/\[|\]/g, '').toLowerCase() === 'a'), 'Multiple CTEs: A NOT in sources');
    assert(!r.sources.some(s => s.replace(/\[|\]/g, '').toLowerCase() === 'b'), 'Multiple CTEs: B NOT in sources');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 7. Parser extraction boundaries
// ═══════════════════════════════════════════════════════════════════════════

function testSkipPatterns() {
  console.log('\n\u2500\u2500 7. Parser extraction boundaries \u2500\u2500');

  // Temp table — regex can't match # (not a word character)
  {
    const r = parseSqlBody(`SELECT * FROM #TempTable`);
    assert(!r.sources.some(s => s.includes('#')), 'Temp table: #TempTable not matched by regex');
  }

  // Table variable — regex can't match @ (not a word character)
  {
    const r = parseSqlBody(`SELECT * FROM @TableVar`);
    assert(!r.sources.some(s => s.includes('@')), 'Table variable: @TableVar not matched by regex');
  }

  // System proc (unqualified) — normalizeCaptured filters unqualified names early (no schema.obj)
  {
    const r = parseSqlBody(`EXEC sp_executesql @sql`);
    assert(!r.execCalls.some(s => s.toLowerCase().includes('sp_executesql')),
      'System proc: sp_executesql NOT in execCalls (unqualified — filtered by normalizeCaptured)');
  }

  // System fn (unqualified) — normalizeCaptured filters unqualified names early (no schema.obj)
  {
    const r = parseSqlBody(`SELECT * FROM fn_helpcollations`);
    assert(!r.sources.some(s => s.toLowerCase().includes('fn_helpcollations')),
      'System fn: fn_helpcollations NOT in sources (unqualified — filtered by normalizeCaptured)');
  }

  // Single char alias — parser-level guard (always table aliases)
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[Orders] o`);
    assert(hasExact(r.sources, 'dbo.Orders'), 'Single char alias: dbo.Orders found');
    assert(!r.sources.some(s => s.replace(/\[|\]/g, '') === 'o'),
      'Single char alias: "o" NOT captured as source');
  }

  // SQL keyword after WHERE — no regex pattern matches it (not after FROM/JOIN/INSERT etc.)
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[T1] WHERE set = 1`);
    assert(hasName(r.sources, 'T1'), 'Keyword context: T1 found');
    assert(!r.sources.some(s => s.replace(/\[|\]/g, '').toLowerCase() === 'set'),
      'Keyword context: "set" not matched (no regex captures after WHERE)');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 8. Combined complex SQL
// ═══════════════════════════════════════════════════════════════════════════

function testCombinedComplexSql() {
  console.log('\n\u2500\u2500 8. Combined complex SQL \u2500\u2500');

  const sql = `
-- This is a comment
INSERT INTO [dbo].[Audit](Msg)
SELECT N'Processing: ' + dbo.udfFormat(x)
FROM [dbo].[Source] s
INNER JOIN [dbo].[Lookup] l ON s.id = l.id
WHERE s.status = 'active -- not inactive'
EXEC [dbo].[LogComplete]
`;

  const r = parseSqlBody(sql);

  // Sources
  assert(hasName(r.sources, 'Source'), 'Complex: Source found');
  assert(hasName(r.sources, 'Lookup'), 'Complex: Lookup found');
  assert(hasExact(r.sources, 'dbo.udfFormat'), 'Complex: dbo.udfFormat found as source (UDF)');

  // Targets
  assert(hasName(r.targets, 'Audit'), 'Complex: Audit found as target');

  // Exec
  assert(hasName(r.execCalls, 'LogComplete'), 'Complex: LogComplete found as exec call');

  // Negatives
  assert(!hasName(r.sources, 'Audit'), 'Complex: Audit NOT in sources');
  assert(!r.sources.some(s => s.toLowerCase().includes('inactive')),
    'Complex: string content "inactive" not captured');
}


// ═══════════════════════════════════════════════════════════════════════════
// 9. Edge cases from critical review
// ═══════════════════════════════════════════════════════════════════════════

function testCriticalReviewEdgeCases() {
  console.log('\n\u2500\u2500 9. Edge cases from critical review \u2500\u2500');

  // DELETE FROM produces a target (DELETE is a write — lineage fact)
  {
    const r = parseSqlBody(`DELETE FROM [dbo].[Target] WHERE Id = 1`);
    assert(hasName(r.targets, 'Target'),
      'DELETE FROM: Target IS in targets (DELETE is a write operation)');
    // DELETE FROM also fires extract_sources_ansi (FROM keyword match) → bidirectional
    assert(hasName(r.sources, 'Target'),
      'DELETE FROM: Target appears as source (via FROM keyword — bidirectional edge)');
  }

  // OPENQUERY: content inside string should not be extracted
  {
    const r = parseSqlBody(`SELECT * FROM OPENQUERY(LinkedServer, 'SELECT * FROM dbo.Remote')`);
    assert(!r.sources.some(s => s.toLowerCase().includes('remote')),
      'OPENQUERY: dbo.Remote inside string NOT extracted');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 10. Regression guards (from 4-agent cross-review)
// ═══════════════════════════════════════════════════════════════════════════

function testRegressionGuards() {
  console.log('\n\u2500\u2500 10. Regression guards (4-agent cross-review) \u2500\u2500');

  // RG1: String containing -- must NOT eat subsequent EXEC calls
  // This was the original preprocessing bug that motivated the single-pass rewrite
  {
    const r = parseSqlBody(`
      SET @msg = ' <--- Start ETL --->'
      EXEC [dbo].[LogStart]
      INSERT INTO [dbo].[Target] SELECT * FROM [dbo].[Source]
      EXEC [dbo].[LogEnd]
    `);
    assert(hasName(r.execCalls, 'LogStart'), 'RG1: EXEC after string with -- is found');
    assert(hasName(r.execCalls, 'LogEnd'), 'RG1: Second EXEC also found');
    assert(hasName(r.targets, 'Target'), 'RG1: INSERT target found');
    assert(hasName(r.sources, 'Source'), 'RG1: FROM source found');
  }

  // RG2: INSERT INTO table(cols) — target must NOT appear as source (UDF false-positive guard)
  {
    const r = parseSqlBody(`INSERT INTO [dbo].[Audit](msg, ts) VALUES('test', GETDATE())`);
    assert(hasName(r.targets, 'Audit'), 'RG2: Audit is target');
    assert(!hasExact(r.sources, 'dbo.Audit'), 'RG2: Audit is NOT a source (column list, not UDF)');
  }

  // RG3: INSERT without INTO + column list
  {
    const r = parseSqlBody(`INSERT [staging].[Orders](id, amount) SELECT id, amt FROM [dbo].[Raw]`);
    assert(hasName(r.targets, 'Orders'), 'RG3: INSERT (no INTO) target found');
    assert(!hasExact(r.sources, 'staging.Orders'), 'RG3: target NOT in sources');
    assert(hasName(r.sources, 'Raw'), 'RG3: FROM source found');
  }

  // RG4: EXEC @retval = [dbo].[Proc] — no spaces around =
  {
    const r = parseSqlBody(`EXEC @result=[dbo].[CalcTotal] @input=5`);
    assert(hasName(r.execCalls, 'CalcTotal'), 'RG4: EXEC @var=proc (no spaces) found');
  }

  // RG5: Three-part name (database.schema.table — cross-db ref)
  {
    const r = parseSqlBody(`SELECT * FROM OtherDB.dbo.RemoteTable`);
    assert(r.sources.some(s => s.toLowerCase().includes('remotetable')),
      'RG5: Three-part name captured (catalog resolution will filter)');
  }

  // RG6: Newlines between keyword and table name
  {
    const r = parseSqlBody(`SELECT *\n  FROM\n    [dbo].[Orders]`);
    assert(hasName(r.sources, 'Orders'), 'RG6: FROM + newline + table name found');
  }

  // RG7: Tabs between keyword and table name
  {
    const r = parseSqlBody(`INSERT\tINTO\t[dbo].[Target]\tSELECT * FROM\t[dbo].[Source]`);
    assert(hasName(r.targets, 'Target'), 'RG7: INSERT\\tINTO\\ttable found');
    assert(hasName(r.sources, 'Source'), 'RG7: FROM\\ttable found');
  }

  // RG8: FULL OUTER JOIN
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] FULL OUTER JOIN [dbo].[B] ON 1=1`);
    assert(hasName(r.sources, 'A'), 'RG8: FULL OUTER JOIN: A found');
    assert(hasName(r.sources, 'B'), 'RG8: FULL OUTER JOIN: B found');
  }

  // RG9: RIGHT JOIN
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[A] RIGHT JOIN [dbo].[B] ON 1=1`);
    assert(hasName(r.sources, 'B'), 'RG9: RIGHT JOIN: B found');
  }

  // RG10: Same table as both source and target (bidirectional)
  {
    const r = parseSqlBody(`UPDATE [dbo].[T1] SET col = s.val FROM [dbo].[T1] s WHERE s.id > 0`);
    assert(hasName(r.targets, 'T1'), 'RG10: Bidirectional: T1 is target');
    assert(hasName(r.sources, 'T1'), 'RG10: Bidirectional: T1 is also source (self-join UPDATE)');
  }

  // RG11: Multiple statements in one SP body
  {
    const r = parseSqlBody(`
      INSERT INTO [dbo].[A] SELECT * FROM [dbo].[B]
      UPDATE [dbo].[C] SET x = 1
      EXEC [dbo].[D]
    `);
    assert(hasName(r.targets, 'A'), 'RG11: Multi-stmt: A is target');
    assert(hasName(r.sources, 'B'), 'RG11: Multi-stmt: B is source');
    assert(hasName(r.targets, 'C'), 'RG11: Multi-stmt: C is target');
    assert(hasName(r.execCalls, 'D'), 'RG11: Multi-stmt: D is exec');
  }

  // RG12: Dynamic SQL — string content must NOT be extracted
  {
    const r = parseSqlBody(`EXEC('INSERT INTO dbo.Secret SELECT * FROM dbo.Source')`);
    assert(!hasName(r.targets, 'Secret'), 'RG12: Dynamic SQL: Secret NOT in targets');
    assert(!hasName(r.sources, 'Source'), 'RG12: Dynamic SQL: Source NOT in sources');
  }

  // RG13: Empty/whitespace body
  {
    const r = parseSqlBody('');
    assert(r.sources.length === 0 && r.targets.length === 0 && r.execCalls.length === 0,
      'RG13: Empty body returns no deps');
  }
  {
    const r = parseSqlBody('   \n\t  ');
    assert(r.sources.length === 0 && r.targets.length === 0 && r.execCalls.length === 0,
      'RG13: Whitespace-only body returns no deps');
  }

  // RG14: Mixed bracket and bare name parts
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].Orders`);
    assert(r.sources.some(s => s.toLowerCase().includes('orders')),
      'RG14: Mixed [dbo].Orders found');
  }

  // RG15: Bracket name containing SQL keyword
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[select]`);
    assert(r.sources.some(s => s.toLowerCase().includes('select') && s.includes('.')),
      'RG15: Bracket [dbo].[select] found (keyword in brackets is a valid table name)');
  }

  // RG16: UPDATE alias resolved via extract_update_alias_target rule
  // UPDATE t SET ... FROM [dbo].[Target] t — alias rule captures [dbo].[Target] as write target.
  // Target also appears as source (bidirectional ⇄ edge expected).
  {
    const r = parseSqlBody(`UPDATE t SET t.col = s.val FROM [dbo].[Target] t INNER JOIN [dbo].[Source] s ON t.id = s.id`);
    assert(hasName(r.targets, 'Target'),
      'RG16: UPDATE alias — Target captured as write target by extract_update_alias_target');
    assert(hasName(r.sources, 'Target'),
      'RG16: UPDATE alias — Target also appears as source (⇄ bidirectional edge)');
    assert(hasName(r.sources, 'Source'), 'RG16: Source found');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 11. Cleansing and normalization improvements
//     Tests for: nested block comments, bracket-aware name splitting,
//     @var/#temp filtering, double-quote identifiers, 3/4-part names
// ═══════════════════════════════════════════════════════════════════════════

function testCleansingAndNormalization() {
  console.log('\n── 11. Cleansing and normalization improvements ──');

  // ── Nested block comments ─────────────────────────────────────────────────

  // Non-nested block comment — still works
  {
    const r = parseSqlBody(`SELECT * FROM /* this is a comment */ [dbo].[Orders]`);
    assert(hasName(r.sources, 'Orders'), 'BC1: Non-nested block comment removed, table found');
  }

  // Nested block comment — inner */ no longer leaves "still here" text
  {
    const r = parseSqlBody(`SELECT * FROM [dbo].[Orders] /* outer /* inner */ still here */ WHERE 1=1`);
    assert(hasName(r.sources, 'Orders'), 'BC2: Nested comment: Orders still found');
    assert(!r.sources.some(s => s.toLowerCase().includes('still')),
      'BC2: Nested comment: "still" NOT extracted as spurious reference');
  }

  // Deep nesting — depth 3
  {
    const r = parseSqlBody(`/* depth /* two /* three */ two */ one */ INSERT INTO [dbo].[T] SELECT * FROM [dbo].[S]`);
    assert(hasName(r.targets, 'T'), 'BC3: Depth-3 nested comment: T is target');
    assert(hasName(r.sources, 'S'), 'BC3: Depth-3 nested comment: S is source');
  }

  // ── Bracket-aware name splitting ──────────────────────────────────────────

  // Object name containing a dot inside brackets
  {
    const r = parseSqlBody(`EXEC [dbo].[spLoad_Case4.5]`);
    assert(r.execCalls.some(s => s.toLowerCase() === '[dbo].[spload_case4.5]'),
      'BN1: Object name with dot in brackets treated as one identifier');
  }

  // 2-part bracket-quoted — dot inside object name is NOT a separator
  {
    const r = parseSqlBody(`SELECT * FROM [staging].[view.name]`);
    assert(r.sources.some(s => s.toLowerCase() === '[staging].[view.name]'),
      'BN2: Dot inside bracket-quoted name preserved as part of identifier');
  }

  // ── @var / #temp filtered early ───────────────────────────────────────────

  // @tableVar — not captured by regex (@ not a word char), should not appear
  {
    const r = parseSqlBody(`SELECT * FROM @tableVar`);
    assert(r.sources.length === 0, 'NF1: @tableVar not in sources');
  }

  // #TempTable — not captured by regex (# not a word char), should not appear
  {
    const r = parseSqlBody(`INSERT INTO #TempTable SELECT * FROM [dbo].[Src]`);
    assert(!r.targets.some(s => s.includes('#')),
      'NF2: #TempTable not in targets');
    assert(hasName(r.sources, 'Src'), 'NF2: [dbo].[Src] source still found');
  }

  // Unqualified name (no dot) — rejected by normalizeCaptured
  {
    const r = parseSqlBody(`SELECT * FROM UnqualifiedTable`);
    assert(r.sources.length === 0,
      'NF3: Unqualified table name (no schema) rejected — not in sources');
  }

  // ── Double-quote identifiers ──────────────────────────────────────────────

  // "schema"."table" — should be treated as [schema].[table]
  {
    const r = parseSqlBody(`SELECT * FROM "dbo"."Orders"`);
    assert(r.sources.some(s => s.toLowerCase() === '[dbo].[orders]'),
      'DQ1: Double-quoted "dbo"."Orders" normalized to [dbo].[orders]');
  }

  // ── 3-part names: take last 2 (drop database prefix) ─────────────────────

  // db.schema.object → schema.object (last 2 parts)
  {
    const r = parseSqlBody(`SELECT * FROM MyDB.dbo.Orders`);
    assert(r.sources.some(s => s.toLowerCase() === '[dbo].[orders]'),
      'MP1: 3-part MyDB.dbo.Orders → [dbo].[orders] (database prefix stripped)');
  }

  // Bracket-quoted 3-part → also last 2
  {
    const r = parseSqlBody(`INSERT INTO [MyDB].[staging].[Orders] SELECT 1`);
    assert(r.targets.some(s => s.toLowerCase() === '[staging].[orders]'),
      'MP2: Bracket-quoted 3-part [MyDB].[staging].[Orders] → [staging].[orders]');
  }

  // 4-part linked server → rejected
  {
    const r = parseSqlBody(`SELECT * FROM [Server].[DB].[dbo].[Orders]`);
    assert(!r.sources.some(s => s.toLowerCase() === '[dbo].[orders]'),
      'MP3: 4-part linked server ref rejected (never in local catalog)');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  console.log('\u2550\u2550\u2550 SQL Body Parser Edge Case Tests \u2550\u2550\u2550');

  testPreprocessing();
  testSourceExtraction();
  testTargetExtraction();
  testExecCalls();
  testUdfExtraction();
  testCteExclusion();
  testSkipPatterns();
  testCombinedComplexSql();
  testCriticalReviewEdgeCases();
  testRegressionGuards();
  testCleansingAndNormalization();

  console.log(`\n\u2550\u2550\u2550 Results: ${passed} passed, ${failed} failed \u2550\u2550\u2550`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
