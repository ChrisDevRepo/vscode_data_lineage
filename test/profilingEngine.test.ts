/**
 * Unit tests for profilingEngine.ts — table statistics query generation and result parsing.
 */

import { strict as assert } from 'assert';
import type { ColumnDef } from '../src/engine/types';
import {
  extractBaseType,
  classifyColumn,
  buildColumnAggregations,
  buildProfilingQuery,
  buildRowCountQuery,
  buildTopNQuery,
  parseProfilingResult,
  parseTopNResult,
  compactDate,
  typeBadgeLabel,
} from '../src/engine/profilingEngine';
import type { StatsMode } from '../src/engine/profilingEngine';
import { test, printSummary } from './testUtils';

function col(name: string, type: string, nullable = 'NULL', extra = ''): ColumnDef {
  return { name, type, nullable, extra };
}

// ─── extractBaseType ─────────────────────────────────────────────────────────

console.log('\n── extractBaseType ──');

test('strips parenthesized length', () => {
  assert.equal(extractBaseType('nvarchar(50)'), 'nvarchar');
  assert.equal(extractBaseType('decimal(18,2)'), 'decimal');
  assert.equal(extractBaseType('varchar(max)'), 'varchar');
});

test('handles plain types', () => {
  assert.equal(extractBaseType('int'), 'int');
  assert.equal(extractBaseType('uniqueidentifier'), 'uniqueidentifier');
});

test('case insensitive', () => {
  assert.equal(extractBaseType('NVARCHAR(100)'), 'nvarchar');
  assert.equal(extractBaseType('Int'), 'int');
});

// ─── classifyColumn ─────────────────────────────────────────────────────────

console.log('\n── classifyColumn ──');

test('integer types', () => {
  assert.equal(classifyColumn(col('id', 'int')), 'integer');
  assert.equal(classifyColumn(col('x', 'bigint')), 'integer');
  assert.equal(classifyColumn(col('x', 'smallint')), 'integer');
  assert.equal(classifyColumn(col('x', 'tinyint')), 'integer');
});

test('decimal types', () => {
  assert.equal(classifyColumn(col('x', 'decimal(18,2)')), 'decimal');
  assert.equal(classifyColumn(col('x', 'float')), 'decimal');
  assert.equal(classifyColumn(col('x', 'money')), 'decimal');
});

test('string types', () => {
  assert.equal(classifyColumn(col('x', 'varchar(100)')), 'string');
  assert.equal(classifyColumn(col('x', 'nvarchar(max)')), 'string');
  assert.equal(classifyColumn(col('x', 'char(10)')), 'string');
});

test('datetime types', () => {
  assert.equal(classifyColumn(col('x', 'datetime2')), 'datetime');
  assert.equal(classifyColumn(col('x', 'date')), 'datetime');
  assert.equal(classifyColumn(col('x', 'datetimeoffset')), 'datetime');
});

test('boolean type', () => {
  assert.equal(classifyColumn(col('x', 'bit')), 'boolean');
});

test('uuid type', () => {
  assert.equal(classifyColumn(col('x', 'uniqueidentifier')), 'uuid');
});

test('skip types', () => {
  assert.equal(classifyColumn(col('x', 'xml')), 'skip');
  assert.equal(classifyColumn(col('x', 'geography')), 'skip');
  assert.equal(classifyColumn(col('x', 'varbinary(max)')), 'skip');
  assert.equal(classifyColumn(col('x', 'hierarchyid')), 'skip');
  assert.equal(classifyColumn(col('x', 'image')), 'skip');
});

test('computed columns skipped', () => {
  assert.equal(classifyColumn(col('x', '(computed)', 'NULL', 'COMPUTED')), 'skip');
});

// ─── buildColumnAggregations ────────────────────────────────────────────────

console.log('\n── buildColumnAggregations ──');

test('quick mode: distinct + null for nullable', () => {
  const cols = [col('Name', 'nvarchar(50)', 'NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0].colName, 'Name');
  assert.equal(aggs[0].fragments.length, 2); // distinct + null
  assert(aggs[0].fragments[0].includes('APPROX_COUNT_DISTINCT'), 'Uses APPROX_COUNT_DISTINCT');
  assert(aggs[0].fragments[1].includes('IS NULL'), 'Has null count');
});

test('quick mode: distinct only for NOT NULL', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0].fragments.length, 1); // distinct only, no null
  assert(!aggs[0].fragments[0].includes('IS NULL'), 'No null count for NOT NULL');
});

test('standard mode: int NOT NULL adds min/max/avg/sd', () => {
  const cols = [col('Amount', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert.equal(aggs[0].fragments.length, 5); // distinct + min + max + avg + sd (no zero for NOT NULL)
  assert(aggs[0].fragments[1].includes('MIN'), 'Has MIN');
  assert(aggs[0].fragments[2].includes('MAX'), 'Has MAX');
  assert(aggs[0].fragments[3].includes('AVG'), 'Has AVG');
  assert(aggs[0].fragments[4].includes('STDEV'), 'Has STDEV');
});

test('standard mode: string NOT NULL adds len + empty', () => {
  const cols = [col('Name', 'varchar(100)', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert.equal(aggs[0].fragments.length, 4); // distinct + minlen + maxlen + empty
  assert(aggs[0].fragments[1].includes('MIN(LEN'), 'Has MIN(LEN)');
  assert(aggs[0].fragments[2].includes('MAX(LEN'), 'Has MAX(LEN)');
  assert(aggs[0].fragments[3].includes("= ''"), 'Has empty count');
});

test('standard mode: bit has no min/max', () => {
  const cols = [col('Active', 'bit', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert.equal(aggs[0].fragments.length, 1); // distinct only
});

test('standard mode: datetime NULL adds min/max', () => {
  const cols = [col('Created', 'datetime2', 'NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert.equal(aggs[0].fragments.length, 4); // distinct + null + min + max (no avg/sd for datetime)
});

test('skipped types produce no aggregations', () => {
  const cols = [col('Geo', 'geography', 'NULL'), col('Doc', 'xml', 'NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert.equal(aggs.length, 0);
});

test('computed columns skipped', () => {
  const cols = [col('Calc', '(computed)', 'NULL', 'COMPUTED')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert.equal(aggs.length, 0);
});

test('exact distinct uses COUNT(DISTINCT)', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, false, 'quick');
  assert(aggs[0].fragments[0].includes('COUNT(DISTINCT'), 'Uses COUNT(DISTINCT)');
});

test('mixed columns: correct counts', () => {
  const cols = [
    col('Id', 'int', 'NOT NULL'),
    col('Name', 'nvarchar(50)', 'NULL'),
    col('Geo', 'geography', 'NULL'),
    col('Calc', '(computed)', 'NULL', 'COMPUTED'),
    col('Active', 'bit', 'NOT NULL'),
  ];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert.equal(aggs.length, 3, '3 non-skipped columns');
  assert.equal(aggs[0].colName, 'Id');
  assert.equal(aggs[1].colName, 'Name');
  assert.equal(aggs[2].colName, 'Active');
});

// ─── buildProfilingQuery ────────────────────────────────────────────────────

console.log('\n── buildProfilingQuery ──');

test('full scan for small tables', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'Users', aggs, 5, 500, 100000, 10000);
  assert(!sql.includes('TABLESAMPLE'), 'No TABLESAMPLE for small table');
  assert(!sql.includes('TOP'), 'No TOP for small table');
  assert(sql.includes('[dbo].[Users]'), 'Has table reference');
});

test('TABLESAMPLE for large table (SQL Server)', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'BigTable', aggs, 2, 1000000, 100000, 10000);
  assert(sql.includes('TABLESAMPLE'), 'Has TABLESAMPLE');
  assert(sql.includes('PERCENT'), 'Has PERCENT');
  assert(!sql.includes('TOP'), 'No TOP for SQL Server');
});

test('TOP N for Fabric DWH (edition 11)', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'BigTable', aggs, 11, 1000000, 100000, 10000);
  assert(sql.includes('TOP 10000'), 'Has TOP N for Fabric');
  assert(!sql.includes('TABLESAMPLE'), 'No TABLESAMPLE for Fabric');
});

test('Azure SQL uses TABLESAMPLE', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'BigTable', aggs, 5, 1000000, 100000, 10000);
  assert(sql.includes('TABLESAMPLE'), 'Azure SQL uses TABLESAMPLE');
});

test('Synapse Dedicated uses TABLESAMPLE', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'BigTable', aggs, 6, 1000000, 100000, 10000);
  assert(sql.includes('TABLESAMPLE'), 'Synapse uses TABLESAMPLE');
});

test('empty aggregations return empty string', () => {
  const sql = buildProfilingQuery('dbo', 'T', [], 2, 100, 100000, 10000);
  assert.equal(sql, '');
});

test('bracket quoting special characters', () => {
  const cols = [col('Col]Name', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'My Table', aggs, 2, 100, 100000, 10000);
  assert(sql.includes('[Col]]Name]'), 'Bracket-quoted ] character');
  assert(sql.includes('[My Table]'), 'Bracket-quoted space in table name');
});

test('sampleThreshold boundary: rowCount = threshold → no sampling', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 100000, 100000, 10000);
  assert(!sql.includes('TABLESAMPLE'), 'No TABLESAMPLE when rowCount = threshold');
  assert(!sql.includes('TOP'), 'No TOP when rowCount = threshold');
});

test('sampleThreshold boundary: rowCount = threshold+1 → sampling', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 100001, 100000, 10000);
  assert(sql.includes('TABLESAMPLE'), 'TABLESAMPLE when rowCount > threshold');
});

test('sampleThreshold = 0 → always sample (any row count)', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 10, 0, 5);
  assert(sql.includes('TABLESAMPLE'), 'TABLESAMPLE even for 10 rows when threshold=0');
});

test('sampleThreshold negative → never sample', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 10000000, -1, 10000);
  assert(!sql.includes('TABLESAMPLE'), 'No TABLESAMPLE when threshold < 0');
  assert(!sql.includes('TOP'), 'No TOP when threshold < 0');
});

test('TABLESAMPLE percentage: sampleSize=10000, rowCount=1M → 1%', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 1000000, 100000, 10000);
  assert(sql.includes('TABLESAMPLE(1 PERCENT)'), `Expected 1%, got: ${sql}`);
});

test('TABLESAMPLE percentage: sampleSize=500000, rowCount=1M → 50%', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 1000000, 100000, 500000);
  assert(sql.includes('TABLESAMPLE(50 PERCENT)'), `Expected 50%, got: ${sql}`);
});

test('TABLESAMPLE percentage: sampleSize > rowCount → capped at 100%', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 200000, 100000, 500000);
  assert(sql.includes('TABLESAMPLE(100 PERCENT)'), `Expected 100% cap, got: ${sql}`);
});

test('TABLESAMPLE percentage: ceil rounds up fractional (sampleSize=10001, rowCount=1M → 2%)', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 2, 1000000, 100000, 10001);
  assert(sql.includes('TABLESAMPLE(2 PERCENT)'), `Expected ceil to 2%, got: ${sql}`);
});

test('Fabric TOP N: sampleSize respected exactly', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  const sql = buildProfilingQuery('dbo', 'T', aggs, 11, 1000000, 100000, 50000);
  assert(sql.includes('TOP 50000'), `Expected TOP 50000, got: ${sql}`);
});

test('settings simulation: useApproxDistinct=false → COUNT(DISTINCT)', () => {
  const cols = [col('Name', 'nvarchar(50)', 'NULL'), col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, false, 'quick');
  for (const agg of aggs) {
    assert(agg.fragments[0].includes('COUNT(DISTINCT'), `${agg.colName} should use COUNT(DISTINCT)`);
    assert(!agg.fragments[0].includes('APPROX_COUNT_DISTINCT'), `${agg.colName} should NOT use APPROX`);
  }
});

test('settings simulation: useApproxDistinct=true → APPROX_COUNT_DISTINCT', () => {
  const cols = [col('Name', 'nvarchar(50)', 'NULL'), col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  for (const agg of aggs) {
    assert(agg.fragments[0].includes('APPROX_COUNT_DISTINCT'), `${agg.colName} should use APPROX`);
    assert(!agg.fragments[0].includes('COUNT(DISTINCT'), `${agg.colName} should NOT use COUNT(DISTINCT)`);
  }
});

test('settings simulation: full pipeline with custom settings', () => {
  // Simulate: sampleThreshold=50000, sampleSize=25000, useApprox=false, standard mode
  const cols = [
    col('OrderID', 'int', 'NOT NULL'),
    col('Amount', 'decimal(12,2)', 'NULL'),
    col('Region', 'varchar(50)', 'NULL'),
    col('Created', 'date', 'NOT NULL'),
    col('Geo', 'geography', 'NULL'),
  ];
  const aggs = buildColumnAggregations(cols, false, 'standard');
  assert.equal(aggs.length, 4, '4 profilable columns (Geo skipped)');

  // OrderID: int NOT NULL → distinct + min + max + avg + sd = 5 fragments (no zero for NOT NULL)
  assert.equal(aggs[0].fragments.length, 5, 'OrderID: distinct + min + max + avg + sd');
  // Amount: decimal NULL → distinct + null + min + max + avg + sd + zero = 7 fragments
  assert.equal(aggs[1].fragments.length, 7, 'Amount: distinct + null + min + max + avg + sd + zero');
  // Region: varchar NULL → distinct + null + minlen + maxlen + empty = 5 fragments
  assert.equal(aggs[2].fragments.length, 5, 'Region: distinct + null + minlen + maxlen + empty');
  // Created: date NOT NULL → distinct + min + max = 3 fragments (datetime: no avg/sd)
  assert.equal(aggs[3].fragments.length, 3, 'Created: distinct + min + max');

  const sql = buildProfilingQuery('dbo', 'Orders', aggs, 2, 200000, 50000, 25000);
  assert(sql.includes('TABLESAMPLE'), 'Sampling triggered (200k > 50k threshold)');
  assert(sql.includes('13 PERCENT'), 'ceil(25000/200000*100) = 13%');
  assert(sql.includes('COUNT(DISTINCT'), 'useApprox=false');
  assert(!sql.includes('APPROX_COUNT_DISTINCT'), 'No APPROX when useApprox=false');
  assert(sql.includes('MIN(LEN'), 'String length in standard mode');
  assert(sql.includes('MIN([Created])'), 'Date min in standard mode');
  assert(sql.includes('AVG(CAST'), 'Numeric avg in standard mode');
  assert(sql.includes('STDEV(CAST'), 'Numeric stddev in standard mode');
});

// ─── buildRowCountQuery ─────────────────────────────────────────────────────

console.log('\n── buildRowCountQuery ──');

test('generates DMV row count query', () => {
  const sql = buildRowCountQuery('dbo', 'Users');
  assert(sql.includes('sys.partitions'), 'Uses sys.partitions');
  assert(sql.includes("OBJECT_ID('[dbo].[Users]')"), 'Has OBJECT_ID');
  assert(sql.includes('index_id IN (0, 1)'), 'Covers heap and clustered');
});

// ─── parseProfilingResult ───────────────────────────────────────────────────

console.log('\n── parseProfilingResult ──');

test('parses quick stats correctly', () => {
  const cols = [
    col('Id', 'int', 'NOT NULL'),
    col('Name', 'nvarchar(50)', 'NULL'),
    col('Geo', 'geography', 'NULL'),
  ];
  const row: Record<string, string> = {
    'Id__d': '100',
    'Name__d': '85',
    'Name__n': '3',
  };
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.rowCount, 100);
  assert.equal(stats.sampled, false);
  assert.equal(stats.columns.length, 3);

  // Id: NOT NULL, no null count
  assert.equal(stats.columns[0].name, 'Id');
  assert.equal(stats.columns[0].distinctCount, 100);
  assert.equal(stats.columns[0].nullCount, null);
  assert.equal(stats.columns[0].completeness, 1);
  assert.equal(stats.columns[0].uniqueness, 1);
  assert.equal(stats.columns[0].skipped, undefined);

  // Name: nullable, has null count
  assert.equal(stats.columns[1].name, 'Name');
  assert.equal(stats.columns[1].distinctCount, 85);
  assert.equal(stats.columns[1].nullCount, 3);
  assert.equal(stats.columns[1].nullPercent, 3);
  assert.equal(stats.columns[1].completeness, 0.97);
  assert.equal(stats.columns[1].uniqueness, 0.85);

  // Geo: skipped
  assert.equal(stats.columns[2].name, 'Geo');
  assert.equal(stats.columns[2].skipped, true);
  assert.equal(stats.columns[2].distinctCount, 0);
});

test('parses detail stats with min/max', () => {
  const cols = [col('Amount', 'decimal(18,2)', 'NOT NULL')];
  const row: Record<string, string> = {
    'Amount__d': '50',
    'Amount__min': '1.23',
    'Amount__max': '9999.99',
  };
  const stats = parseProfilingResult(row, cols, 100, true, 5);
  assert.equal(stats.columns[0].min, '1.23');
  assert.equal(stats.columns[0].max, '9999.99');
  assert.equal(stats.sampled, true);
  assert.equal(stats.samplePercent, 5);
});

test('parses detail stats with string lengths', () => {
  const cols = [col('Title', 'varchar(200)', 'NULL')];
  const row: Record<string, string> = {
    'Title__d': '67',
    'Title__n': '0',
    'Title__minl': '5',
    'Title__maxl': '150',
  };
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.columns[0].minLength, 5);
  assert.equal(stats.columns[0].maxLength, 150);
  assert.equal(stats.columns[0].nullCount, 0);
});

test('computed columns marked as skipped', () => {
  const cols = [col('Calc', '(computed)', 'NULL', 'COMPUTED')];
  const row: Record<string, string> = {};
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.columns[0].skipped, true);
  assert.equal(stats.columns[0].name, 'Calc');
});

// ─── standard mode: new aggregations ────────────────────────────────────────

console.log('\n── standard mode: new aggregations ──');

test('standard mode: nullable int adds avg/sd/zero', () => {
  const cols = [col('Amount', 'int', 'NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  // distinct + null + min + max + avg + sd + zero = 7
  assert.equal(aggs[0].fragments.length, 7);
  assert(aggs[0].fragments.some(f => f.includes('AVG(CAST')), 'Has AVG');
  assert(aggs[0].fragments.some(f => f.includes('STDEV(CAST')), 'Has STDEV');
  assert(aggs[0].fragments.some(f => f.includes('= 0')), 'Has zero count');
});

test('standard mode: NOT NULL int has no zero count', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  // distinct + min + max + avg + sd = 5 (no null, no zero for NOT NULL)
  assert.equal(aggs[0].fragments.length, 5);
  assert(!aggs[0].fragments.some(f => f.includes('= 0')), 'No zero count for NOT NULL');
});

test('standard mode: nullable decimal adds zero count', () => {
  const cols = [col('Price', 'decimal(10,2)', 'NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert(aggs[0].fragments.some(f => f.includes('= 0')), 'Has zero count for nullable decimal');
});

test('standard mode: string adds empty count', () => {
  const cols = [col('Email', 'varchar(100)', 'NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert(aggs[0].fragments.some(f => f.includes("= ''")), 'Has empty string count');
});

test('standard mode: string NOT NULL also gets empty count', () => {
  const cols = [col('Code', 'nvarchar(10)', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert(aggs[0].fragments.some(f => f.includes("= ''")), 'Empty count for NOT NULL string too');
});

test('standard mode: datetime has no avg/sd/zero', () => {
  const cols = [col('Created', 'datetime2', 'NOT NULL')];
  const aggs = buildColumnAggregations(cols, true, 'standard');
  assert(!aggs[0].fragments.some(f => f.includes('AVG')), 'No AVG for datetime');
  assert(!aggs[0].fragments.some(f => f.includes('STDEV')), 'No STDEV for datetime');
});

// ─── parseProfilingResult: new fields ──────────────────────────────────────

console.log('\n── parseProfilingResult: new fields ──');

test('parses mean and stdDev from standard mode', () => {
  const cols = [col('Amount', 'decimal(10,2)', 'NULL')];
  const row: Record<string, string> = {
    'Amount__d': '50',
    'Amount__n': '5',
    'Amount__min': '1.00',
    'Amount__max': '999.99',
    'Amount__avg': '123.45',
    'Amount__sd': '67.89',
    'Amount__z': '3',
  };
  const stats = parseProfilingResult(row, cols, 200, false);
  assert.equal(stats.columns[0].mean, 123.45);
  assert.equal(stats.columns[0].stdDev, 67.89);
  assert.equal(stats.columns[0].zeroCount, 3);
});

test('parses emptyCount from standard string mode', () => {
  const cols = [col('Name', 'varchar(50)', 'NULL')];
  const row: Record<string, string> = {
    'Name__d': '40',
    'Name__n': '2',
    'Name__minl': '1',
    'Name__maxl': '48',
    'Name__e': '7',
  };
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.columns[0].emptyCount, 7);
  assert.equal(stats.columns[0].minLength, 1);
});

test('completeness computed correctly', () => {
  const cols = [col('X', 'int', 'NULL')];
  const row: Record<string, string> = { 'X__d': '80', 'X__n': '20' };
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.columns[0].completeness, 0.8);
  assert.equal(stats.columns[0].uniqueness, 0.8);
});

test('completeness is 1 for NOT NULL columns', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  const row: Record<string, string> = { 'Id__d': '100' };
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.columns[0].completeness, 1);
  assert.equal(stats.columns[0].uniqueness, 1);
});

test('uniqueness capped at 1', () => {
  const cols = [col('Id', 'int', 'NOT NULL')];
  // APPROX_COUNT_DISTINCT can overestimate
  const row: Record<string, string> = { 'Id__d': '110' };
  const stats = parseProfilingResult(row, cols, 100, false);
  assert.equal(stats.columns[0].uniqueness, 1);
});

// ─── buildTopNQuery ──────────────────────────────────────────────────────────

console.log('\n── buildTopNQuery ──');

test('generates Top-N query', () => {
  const sql = buildTopNQuery('dbo', 'Users', 'Status', 5);
  assert(sql.includes('TOP 5'), 'Has TOP 5');
  assert(sql.includes('CAST([Status] AS nvarchar(200))'), 'Casts to nvarchar');
  assert(sql.includes('GROUP BY [Status]'), 'Groups by column');
  assert(sql.includes('ORDER BY cnt DESC'), 'Orders by count desc');
  assert(sql.includes('[dbo].[Users]'), 'Has table reference');
});

test('Top-N bracket escaping', () => {
  const sql = buildTopNQuery('dbo', 'My Table', 'Col]Name', 3);
  assert(sql.includes('TOP 3'), 'Correct N');
  assert(sql.includes('[Col]]Name]'), 'Bracket-escaped column');
});

// ─── parseTopNResult ─────────────────────────────────────────────────────────

console.log('\n── parseTopNResult ──');

test('parses Top-N rows', () => {
  const rows = [
    { val: 'Active', cnt: '500' },
    { val: 'Inactive', cnt: '200' },
    { val: 'Pending', cnt: '50' },
  ];
  const result = parseTopNResult(rows, 1000);
  assert.equal(result.length, 3);
  assert.equal(result[0].value, 'Active');
  assert.equal(result[0].count, 500);
  assert.equal(result[0].percent, 50);
  assert.equal(result[2].percent, 5);
});

test('parseTopNResult handles empty rows', () => {
  const result = parseTopNResult([], 100);
  assert.equal(result.length, 0);
});

// ─── maxColumns cap ──────────────────────────────────────────────────────────

console.log('\n── maxColumns cap ──');

test('maxColumns caps profiled columns', () => {
  const cols = [col('A', 'int'), col('B', 'int'), col('C', 'int'), col('D', 'int')];
  const aggs = buildColumnAggregations(cols, true, 'quick', 2);
  assert.equal(aggs.length, 2);
  assert.equal(aggs[0].colName, 'A');
  assert.equal(aggs[1].colName, 'B');
});

test('maxColumns=1 profiles only first column', () => {
  const cols = [col('X', 'varchar'), col('Y', 'varchar')];
  const aggs = buildColumnAggregations(cols, true, 'quick', 1);
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0].colName, 'X');
});

test('maxColumns undefined means no cap', () => {
  const cols = [col('A', 'int'), col('B', 'int'), col('C', 'int'), col('D', 'int'), col('E', 'int')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert.equal(aggs.length, 5);
});

test('maxColumns skips only count non-skip columns', () => {
  // binary is skipped, should not count toward maxColumns cap
  const cols = [col('A', 'int'), col('B', 'binary'), col('C', 'int'), col('D', 'int')];
  const aggs = buildColumnAggregations(cols, true, 'quick', 2);
  assert.equal(aggs.length, 2);
  assert.equal(aggs[0].colName, 'A');
  assert.equal(aggs[1].colName, 'C');
});

// ─── compactDate ──────────────────────────────────────────────────────────────

console.log('\n── compactDate ──');

test('date-only string unchanged', () => {
  assert.equal(compactDate('2015-04-15'), '2015-04-15');
});

test('midnight datetime → date only', () => {
  assert.equal(compactDate('2015-04-15 00:00:00.000'), '2015-04-15');
});

test('midnight no milliseconds → date only', () => {
  assert.equal(compactDate('2015-04-15 00:00:00'), '2015-04-15');
});

test('non-midnight → date + HH:mm', () => {
  assert.equal(compactDate('2015-04-15 16:33:33.060'), '2015-04-15 16:33');
});

test('non-midnight without ms → date + HH:mm', () => {
  assert.equal(compactDate('2025-06-29 09:15:00'), '2025-06-29 09:15');
});

test('empty string passthrough', () => {
  assert.equal(compactDate(''), '');
});

test('NULL string passthrough', () => {
  assert.equal(compactDate('NULL'), 'NULL');
});

test('unparseable string passthrough', () => {
  assert.equal(compactDate('not-a-date'), 'not-a-date');
});

// ─── typeBadgeLabel ──────────────────────────────────────────────────────────

console.log('\n── typeBadgeLabel ──');

test('nvarchar(50) → STR', () => {
  assert.equal(typeBadgeLabel('nvarchar(50)'), 'STR');
});

test('int → INT', () => {
  assert.equal(typeBadgeLabel('int'), 'INT');
});

test('datetime2(7) → DATE', () => {
  assert.equal(typeBadgeLabel('datetime2(7)'), 'DATE');
});

test('uniqueidentifier → UUID', () => {
  assert.equal(typeBadgeLabel('uniqueidentifier'), 'UUID');
});

test('xml → XML', () => {
  assert.equal(typeBadgeLabel('xml'), 'XML');
});

test('unknown type → truncated uppercase', () => {
  assert.equal(typeBadgeLabel('customtype'), 'CUST');
});

// ─── compactDate in parseProfilingResult ─────────────────────────────────────

console.log('\n── compactDate integration ──');

test('datetime min/max are compacted in parseProfilingResult', () => {
  const cols = [col('Created', 'datetime2(7)', 'NULL')];
  const row: Record<string, string> = {
    'Created__d': '500',
    'Created__n': '10',
    'Created__min': '2020-01-01 00:00:00.000',
    'Created__max': '2025-12-31 14:30:00.000',
  };
  const stats = parseProfilingResult(row, cols, 1000, false);
  const c = stats.columns[0];
  assert.equal(c.min, '2020-01-01');
  assert.equal(c.max, '2025-12-31 14:30');
});

// ─── Summary ────────────────────────────────────────────────────────────────

printSummary('Profiling Engine');
