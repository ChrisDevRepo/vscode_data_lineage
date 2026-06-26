/**
 * Unit tests for pure functions in src/engine/profilingEngine.ts.
 *
 * Covers: extractBaseType, classifyColumn, buildColumnAggregations,
 * buildProfilingQuery, buildRowCountQuery, computeSamplePercent,
 * compactDate, typeBadgeLabel, parseProfilingResult.
 *
 * Skipped (require live sql.ConnectionPool): none — all exports are pure.
 */

import { printSummary, resetCounters, assert, assertEq } from './helpers/testUtils';
import {
  extractBaseType,
  classifyColumn,
  buildColumnAggregations,
  buildProfilingQuery,
  buildRowCountQuery,
  computeSamplePercent,
  compactDate,
  typeBadgeLabel,
  parseProfilingResult,
} from '../../src/engine/profilingEngine';
import type { ColumnDef } from '../../src/engine/types';
import { ENGINE_EDITION_FABRIC } from '../../src/engine/types';

console.log('ProfilingEngine pure-function tests');
console.log('='.repeat(40));
resetCounters();

// ── Helpers ──────────────────────────────────────────────────────────────────

function col(
  name: string,
  type: string,
  nullable: 'NULL' | 'NOT NULL' = 'NOT NULL',
  extra = '',
): ColumnDef {
  return { name, type, nullable, extra };
}

// ── extractBaseType ───────────────────────────────────────────────────────────

assertEq(extractBaseType('nvarchar(50)'), 'nvarchar', 'extractBaseType strips length suffix');
assertEq(extractBaseType('decimal(18,4)'), 'decimal', 'extractBaseType strips precision suffix');
assertEq(extractBaseType('INT'), 'int', 'extractBaseType lowercases');
assertEq(extractBaseType('varchar(max)'), 'varchar', 'extractBaseType handles varchar(max)');
assertEq(extractBaseType('datetime2'), 'datetime2', 'extractBaseType passthrough for bare type');

// ── classifyColumn ────────────────────────────────────────────────────────────

assertEq(classifyColumn(col('id', 'int')), 'integer', 'int maps to integer');
assertEq(classifyColumn(col('price', 'decimal(10,2)')), 'decimal', 'decimal(10,2) maps to decimal');
assertEq(classifyColumn(col('name', 'nvarchar(100)')), 'string', 'nvarchar maps to string');
assertEq(classifyColumn(col('created', 'datetime2')), 'datetime', 'datetime2 maps to datetime');
assertEq(classifyColumn(col('flag', 'bit')), 'boolean', 'bit maps to boolean');
assertEq(classifyColumn(col('uid', 'uniqueidentifier')), 'uuid', 'uniqueidentifier maps to uuid');
assertEq(classifyColumn(col('blob', 'varbinary(max)')), 'skip', 'varbinary maps to skip');
assertEq(classifyColumn(col('xml_col', 'xml')), 'skip', 'xml maps to skip');
assertEq(classifyColumn(col('computed', 'int', 'NOT NULL', 'COMPUTED')), 'skip', 'COMPUTED columns map to skip');
assertEq(classifyColumn(col('val', 'sql_variant')), 'skip', 'sql_variant maps to skip');

// ── typeBadgeLabel ────────────────────────────────────────────────────────────

assertEq(typeBadgeLabel('int'), 'INT', 'int badge is INT');
assertEq(typeBadgeLabel('bigint'), 'INT', 'bigint badge is INT');
assertEq(typeBadgeLabel('decimal(18,4)'), 'DEC', 'decimal badge is DEC');
assertEq(typeBadgeLabel('nvarchar(50)'), 'STR', 'nvarchar badge is STR');
assertEq(typeBadgeLabel('datetime2'), 'DATE', 'datetime2 badge is DATE');
assertEq(typeBadgeLabel('bit'), 'BIT', 'bit badge is BIT');
assertEq(typeBadgeLabel('uniqueidentifier'), 'UUID', 'uniqueidentifier badge is UUID');
assertEq(typeBadgeLabel('xml'), 'XML', 'xml badge is XML');
assertEq(typeBadgeLabel('timestamp'), 'TS', 'timestamp badge is TS');
// Unknown type falls back to first 4 chars uppercased
assertEq(typeBadgeLabel('cursor'), 'CURS', 'unknown type truncates to 4 chars');

// ── computeSamplePercent ──────────────────────────────────────────────────────

assertEq(computeSamplePercent(0, 100_000, 0), 100, 'zero rowCount returns 100');
assertEq(computeSamplePercent(0, 100_000, -1), 100, 'negative rowCount returns 100');
assertEq(computeSamplePercent(0, 1_000_000, 10_000_000), 10, 'ceil((1M/10M)*100) = 10');
assertEq(computeSamplePercent(0, 500_000, 1_000_000), 50, 'exact 50% sample');
assertEq(computeSamplePercent(0, 1_000_000, 100_000), 100, 'sample > total clamps to 100');
assertEq(computeSamplePercent(0, 999, 1_000), 100, 'ceil(99.9%) = 100');
assertEq(computeSamplePercent(0, 1, 3), 34, 'ceil((1/3)*100) = 34');
// Engine edition is unused (prefixed _) — different values return same result
assertEq(computeSamplePercent(5, 100_000, 1_000_000), computeSamplePercent(11, 100_000, 1_000_000), 'engineEdition param has no effect');

// ── compactDate ───────────────────────────────────────────────────────────────

assertEq(compactDate('2024-03-15'), '2024-03-15', 'bare date passthrough');
assertEq(compactDate('2024-03-15 00:00:00.000'), '2024-03-15', 'midnight datetime collapses to date');
assertEq(compactDate('2024-03-15 00:00:00'), '2024-03-15', 'midnight without ms collapses to date');
assertEq(compactDate('2024-03-15 00:00'), '2024-03-15', 'midnight hh:mm collapses to date');
assertEq(compactDate('2024-03-15 14:35:00'), '2024-03-15 14:35', 'non-midnight keeps hh:mm');
assertEq(compactDate('2024-03-15 09:05:22.123'), '2024-03-15 09:05', 'non-midnight with ms keeps hh:mm');
assertEq(compactDate('NULL'), 'NULL', 'NULL string passthrough');
assertEq(compactDate(''), '', 'empty string passthrough');
assertEq(compactDate('not-a-date'), 'not-a-date', 'non-date string passthrough');

// ── buildRowCountQuery ────────────────────────────────────────────────────────

{
  const q = buildRowCountQuery('dbo', 'SalesOrder');
  assert(q.includes('sys.partitions'), 'row count query targets sys.partitions');
  assert(q.includes('row_count'), 'row count query selects row_count alias');
  assert(q.includes('[dbo].[SalesOrder]'), 'row count query bracket-quotes schema.table');
  assert(q.includes('index_id IN (0, 1)'), 'row count query filters heap and clustered index');
}

{
  // Schema/table names containing ] must be escaped
  const q = buildRowCountQuery('my]schema', 'my]table');
  assert(q.includes('[my]]schema]'), 'buildRowCountQuery escapes ] in schema name');
  assert(q.includes('[my]]table]'), 'buildRowCountQuery escapes ] in table name');
}

// ── buildColumnAggregations ───────────────────────────────────────────────────

{
  // Quick mode: only distinct count, no advanced aggregations
  const cols: ColumnDef[] = [col('Id', 'int'), col('Name', 'nvarchar(100)', 'NULL')];
  const aggs = buildColumnAggregations(cols, false, 'quick');

  assertEq(aggs.length, 2, 'quick mode includes one entry per non-skip column');
  assertEq(aggs[0].colName, 'Id', 'first aggregation maps to Id');
  assertEq(aggs[0].category, 'integer', 'Id category is integer');
  assert(aggs[0].fragments.some(f => f.includes('COUNT(DISTINCT')), 'Id uses COUNT(DISTINCT) when useApprox=false');
  assert(!aggs[0].fragments.some(f => f.includes('MIN(')), 'quick mode emits no MIN for integer');

  // Nullable Name column gets null counter
  assert(aggs[1].fragments.some(f => f.includes('IS NULL')), 'nullable column gets null counter fragment');
}

{
  // Standard mode: integer gets MIN/MAX/AVG/STDEV
  const cols: ColumnDef[] = [col('Amount', 'decimal(18,4)', 'NULL')];
  const aggs = buildColumnAggregations(cols, false, 'standard');
  const frags = aggs[0].fragments;

  assert(frags.some(f => f.includes('MIN(')), 'standard decimal emits MIN');
  assert(frags.some(f => f.includes('MAX(')), 'standard decimal emits MAX');
  assert(frags.some(f => f.includes('AVG(')), 'standard decimal emits AVG');
  assert(frags.some(f => f.includes('STDEV(')), 'standard decimal emits STDEV');
  assert(frags.some(f => f.includes('= 0')), 'standard nullable decimal emits zero counter');
}

{
  // Standard mode: string gets LEN min/max and empty counter
  const cols: ColumnDef[] = [col('Description', 'nvarchar(max)', 'NULL')];
  const aggs = buildColumnAggregations(cols, false, 'standard');
  const frags = aggs[0].fragments;

  assert(frags.some(f => f.includes('LEN(')), 'standard string emits LEN-based fragment');
  assert(frags.some(f => f.includes("= ''")), 'standard string emits empty-string counter');
}

{
  // Standard mode: datetime gets MIN/MAX only
  const cols: ColumnDef[] = [col('CreatedAt', 'datetime2')];
  const aggs = buildColumnAggregations(cols, false, 'standard');
  const frags = aggs[0].fragments;

  assert(frags.some(f => f.includes('MIN(')), 'standard datetime emits MIN');
  assert(frags.some(f => f.includes('MAX(')), 'standard datetime emits MAX');
  assert(!frags.some(f => f.includes('AVG(')), 'standard datetime does not emit AVG');
}

{
  // APPROX_COUNT_DISTINCT when useApprox=true
  const cols: ColumnDef[] = [col('Id', 'int')];
  const aggs = buildColumnAggregations(cols, true, 'quick');
  assert(aggs[0].fragments.some(f => f.includes('APPROX_COUNT_DISTINCT(')), 'useApprox=true emits APPROX_COUNT_DISTINCT');
}

{
  // skip-typed columns are excluded
  const cols: ColumnDef[] = [col('img', 'image'), col('x', 'xml')];
  const aggs = buildColumnAggregations(cols, false, 'standard');
  assertEq(aggs.length, 0, 'skip-typed columns produce no aggregation entries');
}

{
  // maxColumns budget cap
  const cols: ColumnDef[] = [col('a', 'int'), col('b', 'int'), col('c', 'int')];
  const aggs = buildColumnAggregations(cols, false, 'quick', 2);
  assertEq(aggs.length, 2, 'maxColumns=2 caps output at 2 entries');
}

{
  // Alias format: colName__d etc.
  const cols: ColumnDef[] = [col('SalesId', 'bigint')];
  const aggs = buildColumnAggregations(cols, false, 'quick');
  assert(aggs[0].fragments[0].includes('[SalesId__d]'), 'fragment alias uses colName__d pattern');
}

// ── buildProfilingQuery ───────────────────────────────────────────────────────

{
  // No fragments → empty string
  const result = buildProfilingQuery('dbo', 'T', [], 0, 0, 1000, 100_000);
  assertEq(result, '', 'empty aggregations return empty string');
}

{
  // No sampling when rowCount <= sampleThreshold
  const cols: ColumnDef[] = [col('Id', 'int')];
  const aggs = buildColumnAggregations(cols, false, 'quick');
  const q = buildProfilingQuery('dbo', 'SalesOrder', aggs, 0, 1_000, 10_000, 100_000);

  assert(q.startsWith('SELECT '), 'query starts with SELECT');
  assert(q.includes('[dbo].[SalesOrder]'), 'query bracket-quotes schema.table');
  assert(!q.includes('TABLESAMPLE'), 'no TABLESAMPLE when under threshold');
  assert(!q.includes('TOP '), 'no TOP when under threshold');
}

{
  // TABLESAMPLE for non-Fabric when rowCount > sampleThreshold
  const cols: ColumnDef[] = [col('Id', 'int')];
  const aggs = buildColumnAggregations(cols, false, 'quick');
  const q = buildProfilingQuery('dbo', 'BigTable', aggs, 5 /* SQL Server 2022 */, 10_000_000, 1_000_000, 500_000);

  assert(q.includes('TABLESAMPLE('), 'non-Fabric large table uses TABLESAMPLE');
  assert(!q.includes('TOP '), 'non-Fabric does not use TOP');
}

{
  // TOP for Fabric when rowCount > sampleThreshold
  const cols: ColumnDef[] = [col('Id', 'int')];
  const aggs = buildColumnAggregations(cols, false, 'quick');
  const q = buildProfilingQuery('dbo', 'BigTable', aggs, ENGINE_EDITION_FABRIC, 10_000_000, 1_000_000, 500_000);

  assert(q.includes('TOP '), 'Fabric large table uses TOP');
  assert(!q.includes('TABLESAMPLE'), 'Fabric does not use TABLESAMPLE');
  assert(q.includes('500000'), 'Fabric TOP clause uses sampleSize');
}

// ── parseProfilingResult ──────────────────────────────────────────────────────

{
  // Basic integer column — not nullable
  const cols: ColumnDef[] = [col('Id', 'int', 'NOT NULL')];
  const row: Record<string, string> = { 'Id__d': '42' };
  const result = parseProfilingResult(row, cols, 100, false);

  assertEq(result.rowCount, 100, 'parseProfilingResult sets rowCount');
  assertEq(result.sampled, false, 'parseProfilingResult sets sampled=false');
  assertEq(result.columns.length, 1, 'parseProfilingResult produces one ColumnStats');
  assertEq(result.columns[0].name, 'Id', 'parsed column name is Id');
  assertEq(result.columns[0].distinctCount, 42, 'parsed distinctCount from Id__d');
  assertEq(result.columns[0].nullCount, null, 'NOT NULL column has null nullCount');
  assertEq(result.columns[0].nullPercent, null, 'NOT NULL column has null nullPercent');
  assertEq(result.columns[0].completeness, 1, 'NOT NULL column has completeness=1');
  assertEq(result.columns[0].uniqueness, 0.42, 'uniqueness = distinctCount / rowCount');
}

{
  // Nullable string column with standard-mode fields
  const cols: ColumnDef[] = [col('Name', 'nvarchar(100)', 'NULL')];
  const row: Record<string, string> = {
    'Name__d': '80',
    'Name__n': '5',
    'Name__minl': '3',
    'Name__maxl': '50',
    'Name__e': '2',
  };
  const result = parseProfilingResult(row, cols, 100, true, 10);

  assert(result.sampled, 'sampled=true is preserved');
  assertEq(result.samplePercent, 10, 'samplePercent=10 is preserved');
  assertEq(result.columns[0].nullCount, 5, 'nullable column nullCount parsed');
  assertEq(result.columns[0].nullPercent!, 5, 'nullPercent = (5/100)*100 = 5');
  assertEq(result.columns[0].completeness, 0.95, 'completeness = 1 - (5/100)');
  assertEq(result.columns[0].minLength, 3, 'minLength parsed from Name__minl');
  assertEq(result.columns[0].maxLength, 50, 'maxLength parsed from Name__maxl');
  assertEq(result.columns[0].emptyCount, 2, 'emptyCount parsed from Name__e');
}

{
  // Datetime column: compactDate applied to min/max
  const cols: ColumnDef[] = [col('CreatedAt', 'datetime2')];
  const row: Record<string, string> = {
    'CreatedAt__d': '10',
    'CreatedAt__min': '2024-01-01 00:00:00.000',
    'CreatedAt__max': '2024-12-31 14:30:00',
  };
  const result = parseProfilingResult(row, cols, 200, false);
  assertEq(result.columns[0].min, '2024-01-01', 'datetime min collapsed to date');
  assertEq(result.columns[0].max, '2024-12-31 14:30', 'datetime max kept hh:mm');
}

{
  // Skip-typed column produces a stub entry with skipped=true
  const cols: ColumnDef[] = [col('doc', 'xml')];
  const row: Record<string, string> = {};
  const result = parseProfilingResult(row, cols, 10, false);

  assertEq(result.columns[0].skipped, true, 'xml column marked skipped=true');
  assertEq(result.columns[0].distinctCount, 0, 'skipped column has distinctCount=0');
  assertEq(result.columns[0].completeness, 1, 'skipped column has completeness=1');
}

{
  // Zero rowCount → uniqueness=0, no division by zero
  const cols: ColumnDef[] = [col('Id', 'int')];
  const row: Record<string, string> = { 'Id__d': '0' };
  const result = parseProfilingResult(row, cols, 0, false);
  assertEq(result.columns[0].uniqueness, 0, 'zero rowCount gives uniqueness=0');
}

{
  // Non-numeric values in row → safeInt emits warning, returns 0
  const cols: ColumnDef[] = [col('Id', 'int')];
  const row: Record<string, string> = { 'Id__d': 'NaN' };
  const result = parseProfilingResult(row, cols, 10, false);
  assertEq(result.columns[0].distinctCount, 0, 'non-numeric Id__d falls back to 0');
  assert(result.warnings !== undefined && result.warnings.length > 0, 'parse warning emitted for bad numeric value');
}

{
  // Numeric decimal column: mean and stdDev parsed
  const cols: ColumnDef[] = [col('Price', 'decimal(10,2)')];
  const row: Record<string, string> = {
    'Price__d': '50',
    'Price__min': '1.5',
    'Price__max': '999.99',
    'Price__avg': '123.45',
    'Price__sd': '67.89',
  };
  const result = parseProfilingResult(row, cols, 200, false);
  assertEq(result.columns[0].min, '1.5', 'decimal min is raw string (not compactDate)');
  assertEq(result.columns[0].max, '999.99', 'decimal max is raw string');
  assert(Math.abs(result.columns[0].mean! - 123.45) < 0.001, 'mean parsed correctly');
  assert(Math.abs(result.columns[0].stdDev! - 67.89) < 0.001, 'stdDev parsed correctly');
}

printSummary('ProfilingEngine');
