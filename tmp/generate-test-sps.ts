/**
 * Synthetic T-SQL SP Generator — Wave 0 RL Corpus
 *
 * Produces ~310 synthetic stored procedures with controlled dependency graphs.
 * Each file contains a machine-parseable -- EXPECT annotation as the oracle.
 * Output: test/sql/generated/gen_NNN_<tier>.sql
 *
 * Run: npx tsx tmp/generate-test-sps.ts
 *
 * Design: template-based (no LLM calls) — purely TypeScript + randomness.
 * Ground truth is declared first; SQL is constructed to match it.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../test/sql/generated');

// ─── Catalog ──────────────────────────────────────────────────────────────────
interface CatalogItem { schema: string; name: string; }

const TABLES: CatalogItem[] = [
  // dbo — core business
  { schema: 'dbo', name: 'Customer' },
  { schema: 'dbo', name: 'Order' },
  { schema: 'dbo', name: 'OrderLine' },
  { schema: 'dbo', name: 'Product' },
  { schema: 'dbo', name: 'Category' },
  { schema: 'dbo', name: 'Employee' },
  { schema: 'dbo', name: 'Department' },
  { schema: 'dbo', name: 'Region' },
  { schema: 'dbo', name: 'Invoice' },
  { schema: 'dbo', name: 'Payment' },
  { schema: 'dbo', name: 'Account' },
  { schema: 'dbo', name: 'Transaction' },
  { schema: 'dbo', name: 'Contact' },
  { schema: 'dbo', name: 'Address' },
  { schema: 'dbo', name: 'Shipper' },
  { schema: 'dbo', name: 'SalesTarget' },
  { schema: 'dbo', name: 'PriceList' },
  { schema: 'dbo', name: 'Warehouse' },
  // stg — staging
  { schema: 'stg', name: 'CustomerStage' },
  { schema: 'stg', name: 'OrderStage' },
  { schema: 'stg', name: 'ProductStage' },
  { schema: 'stg', name: 'EmployeeStage' },
  { schema: 'stg', name: 'InvoiceStage' },
  { schema: 'stg', name: 'PaymentStage' },
  // rpt — reporting
  { schema: 'rpt', name: 'SalesSummary' },
  { schema: 'rpt', name: 'EmployeePerf' },
  { schema: 'rpt', name: 'ProductRevenue' },
  { schema: 'rpt', name: 'CustomerChurn' },
  { schema: 'rpt', name: 'MonthlyOrders' },
  { schema: 'rpt', name: 'RegionMetrics' },
  // hr — human resources
  { schema: 'hr', name: 'Employee' },
  { schema: 'hr', name: 'Department' },
  { schema: 'hr', name: 'Position' },
  { schema: 'hr', name: 'LeaveRequest' },
  { schema: 'hr', name: 'Performance' },
  // fin — finance
  { schema: 'fin', name: 'Account' },
  { schema: 'fin', name: 'Transaction' },
  { schema: 'fin', name: 'Budget' },
  { schema: 'fin', name: 'CostCenter' },
  { schema: 'fin', name: 'JournalEntry' },
  // ops — operations
  { schema: 'ops', name: 'Shipment' },
  { schema: 'ops', name: 'Inventory' },
  { schema: 'ops', name: 'PickList' },
  { schema: 'ops', name: 'ReturnOrder' },
  // etl — ETL pipeline
  { schema: 'etl', name: 'LoadLog' },
  { schema: 'etl', name: 'ExtractLog' },
  { schema: 'etl', name: 'ErrorLog' },
  { schema: 'etl', name: 'BatchControl' },
  // audit — audit trail
  { schema: 'audit', name: 'ChangeLog' },
  { schema: 'audit', name: 'AccessLog' },
];

const PROCS: CatalogItem[] = [
  { schema: 'dbo', name: 'usp_UpdateCustomer' },
  { schema: 'dbo', name: 'usp_ProcessOrder' },
  { schema: 'dbo', name: 'usp_ApplyDiscount' },
  { schema: 'dbo', name: 'usp_GenerateInvoice' },
  { schema: 'dbo', name: 'usp_ReconcilePayments' },
  { schema: 'dbo', name: 'usp_ArchiveOrders' },
  { schema: 'etl', name: 'usp_LoadCustomers' },
  { schema: 'etl', name: 'usp_LoadOrders' },
  { schema: 'etl', name: 'usp_LoadProducts' },
  { schema: 'etl', name: 'usp_ValidateStage' },
  { schema: 'audit', name: 'usp_LogChange' },
  { schema: 'audit', name: 'usp_LogAccess' },
  { schema: 'rpt', name: 'usp_RefreshSummary' },
  { schema: 'hr', name: 'usp_ApproveLeave' },
  { schema: 'fin', name: 'usp_PostJournal' },
];

// ─── RNG (seeded for reproducibility) ───────────────────────────────────────
let seed = 42;
function rng(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}
function randInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => rng() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ─── Bracket formatting ───────────────────────────────────────────────────────
function br(schema: string, name: string): string {
  return `[${schema}].[${name}]`;
}
function plain(schema: string, name: string): string {
  return `${schema}.${name}`;
}
type Fmt = 'bracket' | 'plain' | 'mixed';
function fmt(item: CatalogItem, f: Fmt): string {
  if (f === 'bracket') return br(item.schema, item.name);
  if (f === 'plain')   return plain(item.schema, item.name);
  return rng() > 0.5 ? br(item.schema, item.name) : plain(item.schema, item.name);
}

// ─── Style flags ─────────────────────────────────────────────────────────────
type StyleFlag =
  | 'noFormatting'
  | 'allCaps'
  | 'noCaps'
  | 'massiveComments'
  | 'commentedOutSQL'
  | 'excessiveDeclare'
  | 'deepTryCatch'
  | 'tempTableHeavy'
  | 'variableTableHeavy'
  | 'transactionBlocks'
  | 'bracketedEverything'
  | 'noBrackets'
  | 'weirdWhitespace'
  | 'printStatements'
  | 'nestedSubqueries'
  | 'cursorLoop';

const ALL_FLAGS: StyleFlag[] = [
  'noFormatting', 'allCaps', 'noCaps', 'massiveComments', 'commentedOutSQL',
  'excessiveDeclare', 'deepTryCatch', 'tempTableHeavy', 'variableTableHeavy',
  'transactionBlocks', 'bracketedEverything', 'noBrackets', 'weirdWhitespace',
  'printStatements', 'nestedSubqueries', 'cursorLoop',
];

// ─── Complexity tiers ────────────────────────────────────────────────────────
type Tier = 'tiny' | 'medium' | 'large' | 'monster' | 'dmv_style';

interface TierConfig {
  count:      number;
  minSrc:     number; maxSrc: number;
  minTgt:     number; maxTgt: number;
  minExec:    number; maxExec: number;
  flagCount:  number;
}

const TIERS: Record<Tier, TierConfig> = {
  tiny:      { count: 50,  minSrc: 1, maxSrc: 2,  minTgt: 1, maxTgt: 1,  minExec: 0, maxExec: 1,  flagCount: 1 },
  medium:    { count: 100, minSrc: 2, maxSrc: 4,  minTgt: 1, maxTgt: 2,  minExec: 1, maxExec: 3,  flagCount: 2 },
  large:     { count: 80,  minSrc: 3, maxSrc: 6,  minTgt: 2, maxTgt: 3,  minExec: 2, maxExec: 6,  flagCount: 3 },
  monster:   { count: 50,  minSrc: 4, maxSrc: 8,  minTgt: 2, maxTgt: 4,  minExec: 3, maxExec: 10, flagCount: 6 },
  dmv_style: { count: 30,  minSrc: 1, maxSrc: 4,  minTgt: 1, maxTgt: 2,  minExec: 0, maxExec: 3,  flagCount: 2 },
};

// ─── SQL building blocks ──────────────────────────────────────────────────────

/** Generate a SELECT from source table (2-column subset, realistic WHERE) */
function genSelect(src: CatalogItem, alias: string, f: Fmt): string {
  const t = fmt(src, f);
  const conditions = [
    `[Status] = N'ACTIVE'`,
    `[IsDeleted] = 0`,
    `[CreatedDate] >= DATEADD(DAY, -30, GETDATE())`,
    `[UpdatedDate] IS NOT NULL`,
    `[RecordType] IN (1, 2, 3)`,
  ];
  const where = pick(conditions);
  return `SELECT ${alias}.[ID], ${alias}.[Name], ${alias}.[UpdatedDate]\n    FROM   ${t} AS ${alias}\n    WHERE  ${where}`;
}

/** Generate an INSERT from source → target */
function genInsert(src: CatalogItem, tgt: CatalogItem, f: Fmt): string {
  const s = fmt(src, f);
  const t = fmt(tgt, f);
  return `INSERT INTO ${t} ([SourceID], [SourceName], [LoadedAt])\nSELECT s.[ID], s.[Name], GETUTCDATE()\nFROM   ${s} AS s\nWHERE  s.[IsDeleted] = 0;`;
}

/** Generate a multi-source INSERT */
function genMultiInsert(sources: CatalogItem[], tgt: CatalogItem, f: Fmt): string {
  const t = fmt(tgt, f);
  const lines: string[] = [];
  lines.push(`INSERT INTO ${t} ([SourceID], [RefID], [Amount], [LoadedAt])`);
  lines.push(`SELECT`);
  lines.push(`    a.[ID]          AS SourceID,`);
  lines.push(`    b.[ID]          AS RefID,`);
  lines.push(`    ISNULL(a.[Amount], 0) AS Amount,`);
  lines.push(`    GETUTCDATE()    AS LoadedAt`);
  lines.push(`FROM   ${fmt(sources[0], f)} AS a`);
  for (let i = 1; i < Math.min(sources.length, 3); i++) {
    lines.push(`JOIN   ${fmt(sources[i], f)} AS ${String.fromCharCode(98 + i)} ON ${String.fromCharCode(98 + i)}.[ID] = a.[ID]`);
  }
  lines.push(`WHERE  a.[Status] = N'PENDING';`);
  return lines.join('\n');
}

/** Generate an UPDATE statement */
function genUpdate(src: CatalogItem, tgt: CatalogItem, f: Fmt): string {
  const s = fmt(src, f);
  const t = fmt(tgt, f);
  return `UPDATE t\nSET    t.[Status]      = s.[Status],\n       t.[UpdatedDate] = GETUTCDATE()\nFROM   ${t} AS t\nJOIN   ${s} AS s ON s.[ID] = t.[SourceID]\nWHERE  t.[Status] = N'PENDING';`;
}

/** Generate a MERGE statement */
function genMerge(src: CatalogItem, tgt: CatalogItem, f: Fmt): string {
  const s = fmt(src, f);
  const t = fmt(tgt, f);
  return `MERGE INTO ${t} AS tgt\nUSING ${s} AS src ON src.[ID] = tgt.[ID]\nWHEN MATCHED THEN\n    UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()\nWHEN NOT MATCHED BY TARGET THEN\n    INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())\nWHEN NOT MATCHED BY SOURCE THEN\n    UPDATE SET tgt.[IsDeleted] = 1;`;
}

/** Generate an EXEC call */
function genExec(proc: CatalogItem, f: Fmt): string {
  const p = fmt(proc, f);
  return `EXEC ${p} @ProcessDate = GETDATE(), @BatchID = @BatchID;`;
}

/** Generate nested subquery SELECT (for nestedSubqueries flag) */
function genNestedSelect(src: CatalogItem, f: Fmt): string {
  const t = fmt(src, f);
  return `SELECT x.[ID], x.[Name]\nFROM (\n    SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn\n    FROM (\n        SELECT [ID], [Name], [UpdatedDate]\n        FROM   ${t}\n        WHERE  [IsDeleted] = 0\n    ) AS i\n) AS x\nWHERE x.rn = 1;`;
}

// ─── Decorators (style flags) ─────────────────────────────────────────────────

function addExcessiveDeclares(): string {
  const vars = [
    '@BatchID INT = 0',
    '@ProcessDate DATETIME = GETDATE()',
    '@RowCount INT',
    '@ErrorMessage NVARCHAR(4000)',
    '@ErrorSeverity INT',
    '@ErrorState INT',
    '@RetryCount INT = 0',
    '@MaxRetries INT = 3',
    '@StartTime DATETIME = GETUTCDATE()',
    '@EndTime DATETIME',
    '@DebugMode BIT = 0',
    '@SchemaVersion NVARCHAR(20) = N\'1.0\'',
    '@ProcName NVARCHAR(128) = OBJECT_NAME(@@PROCID)',
    '@AppName NVARCHAR(128) = APP_NAME()',
    '@HostName NVARCHAR(128) = HOST_NAME()',
    '@UserName NVARCHAR(128) = SUSER_SNAME()',
    '@DBName NVARCHAR(128) = DB_NAME()',
    '@ServerName NVARCHAR(128) = @@SERVERNAME',
    '@SPID INT = @@SPID',
    '@NestLevel INT = @@NESTLEVEL',
  ];
  return vars.map(v => `DECLARE ${v};`).join('\n');
}

function addTempTableSection(tempName: string, srcTable: CatalogItem, f: Fmt): string {
  return [
    `CREATE TABLE #${tempName} ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);`,
    `INSERT INTO #${tempName} ([ID], [Name], [Amount], [ProcessedAt])`,
    `SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()`,
    `FROM   ${fmt(srcTable, f)}`,
    `WHERE  [IsDeleted] = 0;`,
  ].join('\n');
}

function addVarTableSection(varName: string): string {
  return [
    `DECLARE ${varName} TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));`,
    `-- @table variable populated from logic above — not a catalog dependency`,
  ].join('\n');
}

function addMassiveCommentBlock(index: number): string {
  return [
    `/*`,
    ` * ─── Processing Block ${index} ─────────────────────────────────────────────────`,
    ` * This section handles the core ETL for batch ${index}.`,
    ` * Original implementation: 2015-03-12 (developer: J.Smith)`,
    ` * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic`,
    ` *`,
    ` * LEGACY NOTE: The following was removed in v3.2:`,
    ` *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1`,
    ` *   -- UPDATE dbo.Legacy SET Flag = 0`,
    ` *`,
    ` * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01`,
    ` */`,
  ].join('\n');
}

function addCommentedOutSQL(tableRef: string): string {
  return [
    `-- OLD CODE (removed 2019-06-15) — kept for reference:`,
    `-- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)`,
    `-- SELECT ID, N'PROCESS', GETDATE() FROM ${tableRef} WHERE Status = 0`,
    `-- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'`,
    `-- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'`,
  ].join('\n');
}

function addPrintStatements(step: number): string {
  return `PRINT N'Step ${step}: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';`;
}

function wrapTryCatch(body: string, depth: number): string {
  if (depth <= 0) return body;
  const inner = wrapTryCatch(body, depth - 1);
  return [
    `BEGIN TRY`,
    inner.split('\n').map(l => '    ' + l).join('\n'),
    `END TRY`,
    `BEGIN CATCH`,
    `    SET @ErrorMessage = ERROR_MESSAGE();`,
    `    SET @ErrorSeverity = ERROR_SEVERITY();`,
    `    SET @ErrorState = ERROR_STATE();`,
    `    RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);`,
    `END CATCH`,
  ].join('\n');
}

function wrapTransaction(body: string): string {
  return [
    `BEGIN TRANSACTION;`,
    body,
    `IF @@ERROR = 0`,
    `    COMMIT TRANSACTION;`,
    `ELSE`,
    `    ROLLBACK TRANSACTION;`,
  ].join('\n');
}

function addCursorLoop(src: CatalogItem, f: Fmt): string {
  const t = fmt(src, f);
  return [
    `DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR`,
    `    SELECT [ID], [Name] FROM ${t} WHERE [Status] = N'PENDING';`,
    ``,
    `DECLARE @CurID INT, @CurName NVARCHAR(200);`,
    `OPEN cur_Process;`,
    `FETCH NEXT FROM cur_Process INTO @CurID, @CurName;`,
    `WHILE @@FETCH_STATUS = 0`,
    `BEGIN`,
    `    -- Process each row`,
    `    SET @BatchID = @CurID;`,
    `    PRINT N'Processing: ' + ISNULL(@CurName, N'NULL');`,
    `    FETCH NEXT FROM cur_Process INTO @CurID, @CurName;`,
    `END`,
    `CLOSE cur_Process;`,
    `DEALLOCATE cur_Process;`,
  ].join('\n');
}

// ─── Keyword transformers ─────────────────────────────────────────────────────
function applyAllCaps(sql: string): string {
  const kws = ['select','insert','into','update','set','delete','from','join','inner join','left join','right join',
                'where','and','or','on','as','exec','execute','begin','end','declare','merge','using','when','then',
                'matched','not','output','inserted','deleted','group by','order by','having','with','create','table',
                'procedure','proc','return','null','isnull','getdate','getutcdate','cast','convert','count','sum',
                'is','in','exists','by','if','else','print','rollback','commit','transaction','try','catch'];
  let result = sql;
  for (const kw of kws) {
    result = result.replace(new RegExp(`\\b${kw}\\b`, 'gi'), kw.toUpperCase());
  }
  return result;
}

function applyNoCaps(sql: string): string {
  return sql.toLowerCase();
}

function applyNoFormatting(sql: string): string {
  // Remove leading whitespace and strip inline -- comments before joining.
  // Critical: if -- comments are kept, they will eat the rest of the line when
  // all lines are joined into one (since -- is end-of-line, not end-of-file).
  return sql.split('\n')
    .map(l => l.replace(/--.*$/, '').trim())   // strip trailing -- comments
    .filter(l => l)                             // drop empty lines
    .join(' ');
}

function applyWeirdWhitespace(sql: string): string {
  // Add extra blank lines randomly, mix tabs/spaces
  return sql.split('\n').map(l => {
    if (rng() > 0.7) return '\t' + l;
    if (rng() > 0.8) return '\n' + l;
    return l;
  }).join('\n');
}

// ─── SP generator ────────────────────────────────────────────────────────────
interface SPSpec {
  procSchema: string;
  procName:   string;
  sources:    CatalogItem[];
  targets:    CatalogItem[];
  execCalls:  CatalogItem[];
  flags:      StyleFlag[];
  tier:       Tier;
}

function generateSP(spec: SPSpec, fileIndex: number): string {
  const fmtStyle: Fmt = spec.flags.includes('bracketedEverything') ? 'bracket'
                      : spec.flags.includes('noBrackets') ? 'plain'
                      : 'mixed';

  const isDmvStyle = spec.tier === 'dmv_style';
  const lines: string[] = [];

  // ── EXPECT annotation (oracle) ──────────────────────────────────────────
  const expectSources = spec.sources.map(t => br(t.schema, t.name)).join(',');
  const expectTargets = spec.targets.map(t => br(t.schema, t.name)).join(',');
  const expectExec    = spec.execCalls.map(p => br(p.schema, p.name)).join(',');
  lines.push(`-- GENERATED SP ${fileIndex}: tier=${spec.tier} flags=[${spec.flags.join(',')}]`);
  lines.push(`-- EXPECT  sources:${expectSources}  targets:${expectTargets}  exec:${expectExec}`);
  lines.push('');

  // ── Proc header ────────────────────────────────────────────────────────
  const procRef = isDmvStyle
    ? `CREATE OR ALTER PROCEDURE ${br(spec.procSchema, spec.procName)}`
    : `CREATE PROCEDURE ${br(spec.procSchema, spec.procName)}`;

  if (isDmvStyle) {
    lines.push(`SET NOCOUNT ON;`);
    lines.push('');
    lines.push(`${procRef}`);
    lines.push(`    @BatchID    INT = 0,`);
    lines.push(`    @ProcessDate DATETIME = NULL`);
    lines.push(`WITH EXECUTE AS OWNER`);
    lines.push(`AS`);
    lines.push(`BEGIN`);
    lines.push(`    SET NOCOUNT ON;`);
    lines.push(`    SET XACT_ABORT ON;`);
  } else {
    lines.push(`${procRef}`);
    lines.push(`    @BatchID    INT = 0,`);
    lines.push(`    @ProcessDate DATETIME = NULL`);
    lines.push(`AS`);
    lines.push(`BEGIN`);
    lines.push(`    SET NOCOUNT ON;`);
  }

  const bodyLines: string[] = [];

  // ── DECLARE section ────────────────────────────────────────────────────
  bodyLines.push(`    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();`);
  bodyLines.push('');

  if (spec.flags.includes('excessiveDeclare')) {
    bodyLines.push(addExcessiveDeclares().split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push('');
  } else {
    bodyLines.push(`    DECLARE @RowCount INT = 0;`);
    bodyLines.push(`    DECLARE @StartTime DATETIME = GETUTCDATE();`);
    bodyLines.push('');
  }

  // ── @table variables ────────────────────────────────────────────────────
  if (spec.flags.includes('variableTableHeavy')) {
    bodyLines.push(addVarTableSection('@TempBuffer').split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push(addVarTableSection('@StagingRows').split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push('');
  }

  // ── #temp table section ────────────────────────────────────────────────
  if (spec.flags.includes('tempTableHeavy') && spec.sources.length > 0) {
    bodyLines.push('    -- Pre-stage data in temp tables');
    bodyLines.push(addTempTableSection('WorkSet', spec.sources[0], fmtStyle).split('\n').map(l => '    ' + l).join('\n'));
    if (spec.sources.length > 1) {
      bodyLines.push(addTempTableSection('RefData', spec.sources[1], fmtStyle).split('\n').map(l => '    ' + l).join('\n'));
    }
    bodyLines.push('');
  }

  // ── Commented-out old SQL ────────────────────────────────────────────────
  if (spec.flags.includes('commentedOutSQL')) {
    bodyLines.push(addCommentedOutSQL(`dbo.OldLegacyTable`).split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push('');
  }

  // ── DML statements ─────────────────────────────────────────────────────
  let stepNum = 1;
  const totalTargets = spec.targets.length;
  const totalSources = spec.sources.length;

  // Cursor loop (wraps a source read)
  if (spec.flags.includes('cursorLoop') && totalSources > 0) {
    if (spec.flags.includes('massiveComments')) {
      bodyLines.push(addMassiveCommentBlock(stepNum).split('\n').map(l => '    ' + l).join('\n'));
    }
    bodyLines.push(addCursorLoop(spec.sources[0], fmtStyle).split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push('');
    stepNum++;
  }

  // Main DML: one INSERT per target
  for (let i = 0; i < totalTargets; i++) {
    const tgt = spec.targets[i];
    const availSrcs = spec.sources;

    if (spec.flags.includes('massiveComments')) {
      bodyLines.push(addMassiveCommentBlock(stepNum).split('\n').map(l => '    ' + l).join('\n'));
    }

    let dml: string;
    if (availSrcs.length === 0) {
      // No sources — just a SELECT to populate target
      dml = `INSERT INTO ${fmt(tgt, fmtStyle)} ([BatchID], [ProcessedAt])\nSELECT @BatchID, GETUTCDATE()\nWHERE 1 = 1;`;
    } else if (availSrcs.length === 1 || i === 0) {
      dml = spec.flags.includes('nestedSubqueries') && availSrcs.length > 0
        ? `INSERT INTO ${fmt(tgt, fmtStyle)} ([ID], [Name])\n` + genNestedSelect(availSrcs[0], fmtStyle)
        : genInsert(availSrcs[Math.min(i, availSrcs.length - 1)], tgt, fmtStyle);
    } else {
      dml = genMultiInsert(availSrcs, tgt, fmtStyle);
    }

    if (spec.flags.includes('transactionBlocks') && i === 0) {
      dml = wrapTransaction(dml);
    }
    if (spec.flags.includes('deepTryCatch')) {
      const depth = spec.tier === 'monster' ? 3 : 2;
      dml = wrapTryCatch(dml, depth);
    }

    bodyLines.push(dml.split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push(`    SET @RowCount = @RowCount + @@ROWCOUNT;`);
    bodyLines.push('');

    if (spec.flags.includes('printStatements')) {
      bodyLines.push('    ' + addPrintStatements(stepNum));
      bodyLines.push('');
    }
    stepNum++;
  }

  // UPDATE on first source/target pair
  if (totalSources > 0 && totalTargets > 0 && spec.tier !== 'tiny') {
    const updateSrc = spec.sources[Math.min(1, totalSources - 1)];
    const updateTgt = spec.targets[0];
    if (updateSrc !== updateTgt || spec.tier === 'large' || spec.tier === 'monster') {
      if (spec.flags.includes('massiveComments')) {
        bodyLines.push(addMassiveCommentBlock(stepNum).split('\n').map(l => '    ' + l).join('\n'));
      }
      bodyLines.push(genUpdate(updateSrc, updateTgt, fmtStyle).split('\n').map(l => '    ' + l).join('\n'));
      bodyLines.push(`    SET @RowCount = @RowCount + @@ROWCOUNT;`);
      bodyLines.push('');
      stepNum++;
    }
  }

  // MERGE (for monster tier or when we have 2+ sources and 1+ targets)
  if ((spec.tier === 'monster' || spec.tier === 'large') && totalSources > 1 && totalTargets > 1) {
    const mergeSrc = spec.sources[totalSources - 1];
    const mergeTgt = spec.targets[totalTargets - 1];
    if (spec.flags.includes('massiveComments')) {
      bodyLines.push(addMassiveCommentBlock(stepNum).split('\n').map(l => '    ' + l).join('\n'));
    }
    bodyLines.push(genMerge(mergeSrc, mergeTgt, fmtStyle).split('\n').map(l => '    ' + l).join('\n'));
    bodyLines.push('');
    stepNum++;
  }

  // EXEC calls
  for (const proc of spec.execCalls) {
    bodyLines.push('    ' + genExec(proc, fmtStyle));
    bodyLines.push('');
  }

  // Extra SELECT reads (for sources that aren't in INSERT - ensures they're in EXPECT sources)
  for (const src of spec.sources) {
    bodyLines.push(`    -- Reference read: ${fmt(src, fmtStyle)}`);
    bodyLines.push(`    SELECT @RowCount = COUNT(*) FROM ${fmt(src, fmtStyle)} WHERE [IsDeleted] = 0;`);
    bodyLines.push('');
  }

  // Weirdly formatted block
  if (spec.flags.includes('weirdWhitespace')) {
    bodyLines.push(`    SELECT\t@RowCount   =  @RowCount + 0;  -- padding stmt`);
    bodyLines.push('');
  }

  bodyLines.push(`    RETURN @RowCount;`);

  // ── Close proc ────────────────────────────────────────────────────────
  lines.push(...bodyLines);
  lines.push(`END`);
  lines.push(`GO`);

  // ── Apply keyword style flags ─────────────────────────────────────────
  let body = lines.join('\n');

  if (spec.flags.includes('allCaps')) {
    body = applyAllCaps(body);
  } else if (spec.flags.includes('noCaps')) {
    body = applyNoCaps(body);
  }

  if (spec.flags.includes('noFormatting')) {
    // Only apply to body lines (not the EXPECT annotation)
    const [header, ...rest] = body.split('\n');
    const header2 = rest[0]; // EXPECT line
    const header3 = rest[1]; // empty line
    const bodyPart = rest.slice(2).join('\n');
    body = [header, header2, header3, applyNoFormatting(bodyPart)].join('\n');
  }

  if (spec.flags.includes('weirdWhitespace') && !spec.flags.includes('noFormatting')) {
    const [h1, h2, ...rest] = body.split('\n');
    body = [h1, h2, applyWeirdWhitespace(rest.join('\n'))].join('\n');
  }

  return body;
}

// ─── Main generation loop ─────────────────────────────────────────────────────
function main(): void {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  let fileIndex = 1;
  let totalGenerated = 0;

  for (const [tier, config] of Object.entries(TIERS) as [Tier, TierConfig][]) {
    console.log(`\nGenerating ${config.count} ${tier} SPs...`);

    for (let i = 0; i < config.count; i++) {
      // Pick random sources, targets, exec from catalog
      const numSrc  = randInt(config.minSrc, config.maxSrc);
      const numTgt  = randInt(config.minTgt, config.maxTgt);
      const numExec = randInt(config.minExec, config.maxExec);

      const sources   = pickN(TABLES, numSrc);
      // Targets must NOT overlap with sources for clarity (except bidirectional, which we skip in generator)
      const nonSrcTables = TABLES.filter(t => !sources.includes(t));
      const targets   = pickN(nonSrcTables.length >= numTgt ? nonSrcTables : TABLES, numTgt);
      const execCalls = pickN(PROCS, numExec);

      // Pick style flags
      const flags = pickN(ALL_FLAGS, config.flagCount) as StyleFlag[];

      // Pick a proc name
      const procSchema = pick(['dbo', 'etl', 'fin', 'hr', 'rpt', 'ops']);
      const procName = `usp_Gen${tier.charAt(0).toUpperCase() + tier.slice(1)}_${String(fileIndex).padStart(3, '0')}`;

      const spec: SPSpec = { procSchema, procName, sources, targets, execCalls, flags, tier };

      const sql = generateSP(spec, fileIndex);
      const fileName = `gen_${String(fileIndex).padStart(3, '0')}_${tier}.sql`;
      writeFileSync(resolve(OUT_DIR, fileName), sql, 'utf-8');

      fileIndex++;
      totalGenerated++;
    }
  }

  console.log(`\n✓ Generated ${totalGenerated} synthetic SPs in ${OUT_DIR}`);
  console.log(`  Files: gen_001_tiny.sql ... gen_${String(fileIndex - 1).padStart(3, '0')}_dmv_style.sql`);
}

main();
