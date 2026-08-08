/**
 * Unit tests for pure functions in src/engine/profilingEngine.ts.
 *
 * Covers: extractBaseType, classifyColumn, buildColumnAggregations,
 * buildProfilingQuery, buildRowCountQuery, computeSamplePercent,
 * compactDate, typeBadgeLabel, parseProfilingResult.
 *
 * Skipped (require live sql.ConnectionPool): none — all exports are pure.
 */

import { describe, it, expect } from 'vitest';
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
} from '../../../src/engine/profilingEngine';
import type { ColumnDef } from '../../../src/engine/types';
import { ENGINE_EDITION_FABRIC } from '../../../src/engine/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function col(
  name: string,
  type: string,
  nullable: 'NULL' | 'NOT NULL' = 'NOT NULL',
  extra = '',
): ColumnDef {
  return { name, type, nullable, extra };
}

describe('ProfilingEngine pure functions', () => {
  it('extractBaseType', () => {
    expect(extractBaseType('nvarchar(50)'), 'extractBaseType strips length suffix').toBe('nvarchar');
    expect(extractBaseType('decimal(18,4)'), 'extractBaseType strips precision suffix').toBe('decimal');
    expect(extractBaseType('INT'), 'extractBaseType lowercases').toBe('int');
    expect(extractBaseType('varchar(max)'), 'extractBaseType handles varchar(max)').toBe('varchar');
    expect(extractBaseType('datetime2'), 'extractBaseType passthrough for bare type').toBe('datetime2');
  });

  it('classifyColumn', () => {
    expect(classifyColumn(col('id', 'int')), 'int maps to integer').toBe('integer');
    expect(classifyColumn(col('price', 'decimal(10,2)')), 'decimal(10,2) maps to decimal').toBe('decimal');
    expect(classifyColumn(col('name', 'nvarchar(100)')), 'nvarchar maps to string').toBe('string');
    expect(classifyColumn(col('created', 'datetime2')), 'datetime2 maps to datetime').toBe('datetime');
    expect(classifyColumn(col('flag', 'bit')), 'bit maps to boolean').toBe('boolean');
    expect(classifyColumn(col('uid', 'uniqueidentifier')), 'uniqueidentifier maps to uuid').toBe('uuid');
    expect(classifyColumn(col('blob', 'varbinary(max)')), 'varbinary maps to skip').toBe('skip');
    expect(classifyColumn(col('xml_col', 'xml')), 'xml maps to skip').toBe('skip');
    expect(classifyColumn(col('computed', 'int', 'NOT NULL', 'COMPUTED')), 'COMPUTED columns map to skip').toBe('skip');
    expect(classifyColumn(col('val', 'sql_variant')), 'sql_variant maps to skip').toBe('skip');
  });

  it('typeBadgeLabel', () => {
    expect(typeBadgeLabel('int'), 'int badge is INT').toBe('INT');
    expect(typeBadgeLabel('bigint'), 'bigint badge is INT').toBe('INT');
    expect(typeBadgeLabel('decimal(18,4)'), 'decimal badge is DEC').toBe('DEC');
    expect(typeBadgeLabel('nvarchar(50)'), 'nvarchar badge is STR').toBe('STR');
    expect(typeBadgeLabel('datetime2'), 'datetime2 badge is DATE').toBe('DATE');
    expect(typeBadgeLabel('bit'), 'bit badge is BIT').toBe('BIT');
    expect(typeBadgeLabel('uniqueidentifier'), 'uniqueidentifier badge is UUID').toBe('UUID');
    expect(typeBadgeLabel('xml'), 'xml badge is XML').toBe('XML');
    expect(typeBadgeLabel('timestamp'), 'timestamp badge is TS').toBe('TS');
    // Unknown type falls back to first 4 chars uppercased
    expect(typeBadgeLabel('cursor'), 'unknown type truncates to 4 chars').toBe('CURS');
  });

  it('computeSamplePercent', () => {
    expect(computeSamplePercent(100_000, 0), 'zero rowCount returns 100').toBe(100);
    expect(computeSamplePercent(100_000, -1), 'negative rowCount returns 100').toBe(100);
    expect(computeSamplePercent(1_000_000, 10_000_000), 'ceil((1M/10M)*100) = 10').toBe(10);
    expect(computeSamplePercent(500_000, 1_000_000), 'exact 50% sample').toBe(50);
    expect(computeSamplePercent(1_000_000, 100_000), 'sample > total clamps to 100').toBe(100);
    expect(computeSamplePercent(999, 1_000), 'ceil(99.9%) = 100').toBe(100);
    expect(computeSamplePercent(1, 3), 'ceil((1/3)*100) = 34').toBe(34);
  });

  it('compactDate', () => {
    expect(compactDate('2024-03-15'), 'bare date passthrough').toBe('2024-03-15');
    expect(compactDate('2024-03-15 00:00:00.000'), 'midnight datetime collapses to date').toBe('2024-03-15');
    expect(compactDate('2024-03-15 00:00:00'), 'midnight without ms collapses to date').toBe('2024-03-15');
    expect(compactDate('2024-03-15 00:00'), 'midnight hh:mm collapses to date').toBe('2024-03-15');
    expect(compactDate('2024-03-15 14:35:00'), 'non-midnight keeps hh:mm').toBe('2024-03-15 14:35');
    expect(compactDate('2024-03-15 09:05:22.123'), 'non-midnight with ms keeps hh:mm').toBe('2024-03-15 09:05');
    expect(compactDate('NULL'), 'NULL string passthrough').toBe('NULL');
    expect(compactDate(''), 'empty string passthrough').toBe('');
    expect(compactDate('not-a-date'), 'non-date string passthrough').toBe('not-a-date');
  });

  it('buildRowCountQuery', () => {
    const q = buildRowCountQuery('dbo', 'SalesOrder');
    expect(q.includes('sys.partitions'), 'row count query targets sys.partitions').toBe(true);
    expect(q.includes('row_count'), 'row count query selects row_count alias').toBe(true);
    expect(q.includes('[dbo].[SalesOrder]'), 'row count query bracket-quotes schema.table').toBe(true);
    expect(q.includes('index_id IN (0, 1)'), 'row count query filters heap and clustered index').toBe(true);
  });

  it('buildRowCountQuery escapes ] in identifiers', () => {
    // Schema/table names containing ] must be escaped
    const q = buildRowCountQuery('my]schema', 'my]table');
    expect(q.includes('[my]]schema]'), 'buildRowCountQuery escapes ] in schema name').toBe(true);
    expect(q.includes('[my]]table]'), 'buildRowCountQuery escapes ] in table name').toBe(true);
  });

  it('buildColumnAggregations — quick mode', () => {
    // Quick mode: only distinct count, no advanced aggregations
    const cols: ColumnDef[] = [col('Id', 'int'), col('Name', 'nvarchar(100)', 'NULL')];
    const aggs = buildColumnAggregations(cols, false, 'quick');

    expect(aggs.length, 'quick mode includes one entry per non-skip column').toBe(2);
    expect(aggs[0].colName, 'first aggregation maps to Id').toBe('Id');
    expect(aggs[0].category, 'Id category is integer').toBe('integer');
    expect(aggs[0].fragments.some(f => f.includes('COUNT(DISTINCT')), 'Id uses COUNT(DISTINCT) when useApprox=false').toBe(true);
    expect(aggs[0].fragments.some(f => f.includes('MIN(')), 'quick mode emits no MIN for integer').toBe(false);

    // Nullable Name column gets null counter
    expect(aggs[1].fragments.some(f => f.includes('IS NULL')), 'nullable column gets null counter fragment').toBe(true);
  });

  it('buildColumnAggregations — standard mode, decimal', () => {
    // Standard mode: integer gets MIN/MAX/AVG/STDEV
    const cols: ColumnDef[] = [col('Amount', 'decimal(18,4)', 'NULL')];
    const aggs = buildColumnAggregations(cols, false, 'standard');
    const frags = aggs[0].fragments;

    expect(frags.some(f => f.includes('MIN(')), 'standard decimal emits MIN').toBe(true);
    expect(frags.some(f => f.includes('MAX(')), 'standard decimal emits MAX').toBe(true);
    expect(frags.some(f => f.includes('AVG(')), 'standard decimal emits AVG').toBe(true);
    expect(frags.some(f => f.includes('STDEV(')), 'standard decimal emits STDEV').toBe(true);
    expect(frags.some(f => f.includes('= 0')), 'standard nullable decimal emits zero counter').toBe(true);
  });

  it('buildColumnAggregations — standard mode, string', () => {
    // Standard mode: string gets LEN min/max and empty counter
    const cols: ColumnDef[] = [col('Description', 'nvarchar(max)', 'NULL')];
    const aggs = buildColumnAggregations(cols, false, 'standard');
    const frags = aggs[0].fragments;

    expect(frags.some(f => f.includes('LEN(')), 'standard string emits LEN-based fragment').toBe(true);
    expect(frags.some(f => f.includes("= ''")), 'standard string emits empty-string counter').toBe(true);
  });

  it('buildColumnAggregations — standard mode, datetime', () => {
    // Standard mode: datetime gets MIN/MAX only
    const cols: ColumnDef[] = [col('CreatedAt', 'datetime2')];
    const aggs = buildColumnAggregations(cols, false, 'standard');
    const frags = aggs[0].fragments;

    expect(frags.some(f => f.includes('MIN(')), 'standard datetime emits MIN').toBe(true);
    expect(frags.some(f => f.includes('MAX(')), 'standard datetime emits MAX').toBe(true);
    expect(frags.some(f => f.includes('AVG(')), 'standard datetime does not emit AVG').toBe(false);
  });

  it('buildColumnAggregations — APPROX_COUNT_DISTINCT when useApprox=true', () => {
    const cols: ColumnDef[] = [col('Id', 'int')];
    const aggs = buildColumnAggregations(cols, true, 'quick');
    expect(aggs[0].fragments.some(f => f.includes('APPROX_COUNT_DISTINCT(')), 'useApprox=true emits APPROX_COUNT_DISTINCT').toBe(true);
  });

  it('buildColumnAggregations — skip-typed columns are excluded', () => {
    const cols: ColumnDef[] = [col('img', 'image'), col('x', 'xml')];
    const aggs = buildColumnAggregations(cols, false, 'standard');
    expect(aggs.length, 'skip-typed columns produce no aggregation entries').toBe(0);
  });

  it('buildColumnAggregations — maxColumns budget cap', () => {
    const cols: ColumnDef[] = [col('a', 'int'), col('b', 'int'), col('c', 'int')];
    const aggs = buildColumnAggregations(cols, false, 'quick', 2);
    expect(aggs.length, 'maxColumns=2 caps output at 2 entries').toBe(2);
  });

  it('buildColumnAggregations — alias format colName__d', () => {
    const cols: ColumnDef[] = [col('SalesId', 'bigint')];
    const aggs = buildColumnAggregations(cols, false, 'quick');
    expect(aggs[0].fragments[0].includes('[SalesId__d]'), 'fragment alias uses colName__d pattern').toBe(true);
  });

  it('buildProfilingQuery — no fragments returns empty string', () => {
    const result = buildProfilingQuery('dbo', 'T', [], 0, 0, 1000, 100_000);
    expect(result, 'empty aggregations return empty string').toBe('');
  });

  it('buildProfilingQuery — no sampling when rowCount <= sampleThreshold', () => {
    const cols: ColumnDef[] = [col('Id', 'int')];
    const aggs = buildColumnAggregations(cols, false, 'quick');
    const q = buildProfilingQuery('dbo', 'SalesOrder', aggs, 0, 1_000, 10_000, 100_000);

    expect(q.startsWith('SELECT '), 'query starts with SELECT').toBe(true);
    expect(q.includes('[dbo].[SalesOrder]'), 'query bracket-quotes schema.table').toBe(true);
    expect(q.includes('TABLESAMPLE'), 'no TABLESAMPLE when under threshold').toBe(false);
    expect(q.includes('TOP '), 'no TOP when under threshold').toBe(false);
  });

  it('buildProfilingQuery — TABLESAMPLE for non-Fabric over threshold', () => {
    const cols: ColumnDef[] = [col('Id', 'int')];
    const aggs = buildColumnAggregations(cols, false, 'quick');
    const q = buildProfilingQuery('dbo', 'BigTable', aggs, 5 /* SQL Server 2022 */, 10_000_000, 1_000_000, 500_000);

    expect(q.includes('TABLESAMPLE('), 'non-Fabric large table uses TABLESAMPLE').toBe(true);
    expect(q.includes('TOP '), 'non-Fabric does not use TOP').toBe(false);
  });

  it('buildProfilingQuery — TOP for Fabric over threshold', () => {
    const cols: ColumnDef[] = [col('Id', 'int')];
    const aggs = buildColumnAggregations(cols, false, 'quick');
    const q = buildProfilingQuery('dbo', 'BigTable', aggs, ENGINE_EDITION_FABRIC, 10_000_000, 1_000_000, 500_000);

    expect(q.includes('TOP '), 'Fabric large table uses TOP').toBe(true);
    expect(q.includes('TABLESAMPLE'), 'Fabric does not use TABLESAMPLE').toBe(false);
    expect(q.includes('500000'), 'Fabric TOP clause uses sampleSize').toBe(true);
  });

  it('parseProfilingResult — basic integer column, not nullable', () => {
    const cols: ColumnDef[] = [col('Id', 'int', 'NOT NULL')];
    const row: Record<string, string> = { 'Id__d': '42' };
    const result = parseProfilingResult(row, cols, 100, false);

    expect(result.rowCount, 'parseProfilingResult sets rowCount').toBe(100);
    expect(result.sampled, 'parseProfilingResult sets sampled=false').toBe(false);
    expect(result.columns.length, 'parseProfilingResult produces one ColumnStats').toBe(1);
    expect(result.columns[0].name, 'parsed column name is Id').toBe('Id');
    expect(result.columns[0].distinctCount, 'parsed distinctCount from Id__d').toBe(42);
    expect(result.columns[0].nullCount, 'NOT NULL column has null nullCount').toBe(null);
    expect(result.columns[0].nullPercent, 'NOT NULL column has null nullPercent').toBe(null);
    expect(result.columns[0].completeness, 'NOT NULL column has completeness=1').toBe(1);
    expect(result.columns[0].uniqueness, 'uniqueness = distinctCount / rowCount').toBe(0.42);
  });

  it('parseProfilingResult — nullable string column with standard-mode fields', () => {
    const cols: ColumnDef[] = [col('Name', 'nvarchar(100)', 'NULL')];
    const row: Record<string, string> = {
      'Name__d': '80',
      'Name__n': '5',
      'Name__minl': '3',
      'Name__maxl': '50',
      'Name__e': '2',
    };
    const result = parseProfilingResult(row, cols, 100, true, 10);

    expect(result.sampled, 'sampled=true is preserved').toBe(true);
    expect(result.samplePercent, 'samplePercent=10 is preserved').toBe(10);
    expect(result.columns[0].nullCount, 'nullable column nullCount parsed').toBe(5);
    expect(result.columns[0].nullPercent!, 'nullPercent = (5/100)*100 = 5').toBe(5);
    expect(result.columns[0].completeness, 'completeness = 1 - (5/100)').toBe(0.95);
    expect(result.columns[0].minLength, 'minLength parsed from Name__minl').toBe(3);
    expect(result.columns[0].maxLength, 'maxLength parsed from Name__maxl').toBe(50);
    expect(result.columns[0].emptyCount, 'emptyCount parsed from Name__e').toBe(2);
  });

  it('parseProfilingResult — datetime column applies compactDate to min/max', () => {
    const cols: ColumnDef[] = [col('CreatedAt', 'datetime2')];
    const row: Record<string, string> = {
      'CreatedAt__d': '10',
      'CreatedAt__min': '2024-01-01 00:00:00.000',
      'CreatedAt__max': '2024-12-31 14:30:00',
    };
    const result = parseProfilingResult(row, cols, 200, false);
    expect(result.columns[0].min, 'datetime min collapsed to date').toBe('2024-01-01');
    expect(result.columns[0].max, 'datetime max kept hh:mm').toBe('2024-12-31 14:30');
  });

  it('parseProfilingResult — skip-typed column produces a stub entry', () => {
    const cols: ColumnDef[] = [col('doc', 'xml')];
    const row: Record<string, string> = {};
    const result = parseProfilingResult(row, cols, 10, false);

    expect(result.columns[0].skipped, 'xml column marked skipped=true').toBe(true);
    expect(result.columns[0].distinctCount, 'skipped column has distinctCount=0').toBe(0);
    expect(result.columns[0].completeness, 'skipped column has completeness=1').toBe(1);
  });

  it('parseProfilingResult — zero rowCount gives uniqueness=0', () => {
    const cols: ColumnDef[] = [col('Id', 'int')];
    const row: Record<string, string> = { 'Id__d': '0' };
    const result = parseProfilingResult(row, cols, 0, false);
    expect(result.columns[0].uniqueness, 'zero rowCount gives uniqueness=0').toBe(0);
  });

  it('parseProfilingResult — non-numeric values emit a warning and fall back to 0', () => {
    const cols: ColumnDef[] = [col('Id', 'int')];
    const row: Record<string, string> = { 'Id__d': 'NaN' };
    const result = parseProfilingResult(row, cols, 10, false);
    expect(result.columns[0].distinctCount, 'non-numeric Id__d falls back to 0').toBe(0);
    expect(result.warnings !== undefined && result.warnings.length > 0, 'parse warning emitted for bad numeric value').toBe(true);
  });

  it('parseProfilingResult — numeric decimal column parses mean and stdDev', () => {
    const cols: ColumnDef[] = [col('Price', 'decimal(10,2)')];
    const row: Record<string, string> = {
      'Price__d': '50',
      'Price__min': '1.5',
      'Price__max': '999.99',
      'Price__avg': '123.45',
      'Price__sd': '67.89',
    };
    const result = parseProfilingResult(row, cols, 200, false);
    expect(result.columns[0].min, 'decimal min is raw string (not compactDate)').toBe('1.5');
    expect(result.columns[0].max, 'decimal max is raw string').toBe('999.99');
    expect(Math.abs(result.columns[0].mean! - 123.45) < 0.001, 'mean parsed correctly').toBe(true);
    expect(Math.abs(result.columns[0].stdDev! - 67.89) < 0.001, 'stdDev parsed correctly').toBe(true);
  });
});
