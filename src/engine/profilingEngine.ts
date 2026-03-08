/**
 * Table profiling query generator and result parser.
 *
 * Generates type-aware, single-pass SQL aggregation queries for table statistics.
 * Supports Quick (distinct + null%) and Standard (+ min/max/avg/stdev/zero/empty) modes.
 *
 * SQL patterns are documented in docs/PROFILING_PATTERNS.md.
 * Generated SQL is logged to the outputChannel for DBA review.
 *
 * Target platforms: SQL Server 2022+, Azure SQL, Synapse Dedicated SQL Pool, Fabric DWH.
 */

import { ENGINE_EDITION_FABRIC, type ColumnDef } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ColumnStats {
  name: string;
  type: string;
  distinctCount: number;
  nullCount: number | null;    // null = NOT NULL column, skipped
  nullPercent: number | null;
  completeness: number;        // 1 - (nullCount / rowCount), always computed
  uniqueness: number;          // distinctCount / rowCount, always computed
  min?: string;
  max?: string;
  mean?: number;               // integer/decimal only (standard mode)
  stdDev?: number;             // integer/decimal only (standard mode)
  minLength?: number;
  maxLength?: number;
  zeroCount?: number;          // integer/decimal, nullable only (standard mode)
  emptyCount?: number;         // string (standard mode)
  skipped?: boolean;
}

export interface TopValue {
  value: string;
  count: number;
  percent: number;
}

export interface TableStats {
  rowCount: number;
  columns: ColumnStats[];
  sampled: boolean;
  samplePercent?: number;
  warnings?: string[];
}

export type StatsMode = 'quick' | 'standard';

// ─── Type Classification ────────────────────────────────────────────────────

type ColCategory = 'integer' | 'decimal' | 'string' | 'datetime' | 'boolean' | 'uuid' | 'skip';

const TYPE_CATEGORIES: Record<string, ColCategory> = {
  int: 'integer', bigint: 'integer', smallint: 'integer', tinyint: 'integer',
  decimal: 'decimal', numeric: 'decimal', float: 'decimal', real: 'decimal',
  money: 'decimal', smallmoney: 'decimal',
  varchar: 'string', nvarchar: 'string', char: 'string', nchar: 'string',
  date: 'datetime', datetime: 'datetime', datetime2: 'datetime',
  smalldatetime: 'datetime', datetimeoffset: 'datetime', time: 'datetime',
  bit: 'boolean',
  uniqueidentifier: 'uuid',
  // Skip types
  binary: 'skip', varbinary: 'skip', image: 'skip',
  text: 'skip', ntext: 'skip', xml: 'skip',
  geography: 'skip', geometry: 'skip', hierarchyid: 'skip',
  sql_variant: 'skip', timestamp: 'skip', rowversion: 'skip', sysname: 'skip',
};

/** Extract base type name from formatted type string like "nvarchar(50)" → "nvarchar" */
export function extractBaseType(typeStr: string): string {
  return typeStr.replace(/\(.*$/, '').trim().toLowerCase();
}

/** Classify a column's SQL type into a category for profiling. */
export function classifyColumn(col: ColumnDef): ColCategory {
  if (col.extra === 'COMPUTED') return 'skip';
  const base = extractBaseType(col.type);
  return TYPE_CATEGORIES[base] ?? 'skip';
}

// ─── Query Generation ───────────────────────────────────────────────────────

/** Bracket-quote a SQL identifier. */
function qi(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`;
}

export interface ColumnAggregation {
  colName: string;
  fragments: string[];
  category: ColCategory;
}

/**
 * Generate per-column SQL aggregation fragments.
 * Returns array of aggregation info — one per non-skipped column.
 */
export function buildColumnAggregations(
  cols: ColumnDef[],
  useApprox: boolean,
  mode: StatsMode,
  maxColumns?: number,
): ColumnAggregation[] {
  const result: ColumnAggregation[] = [];
  let profiled = 0;

  for (const col of cols) {
    const cat = classifyColumn(col);
    if (cat === 'skip') continue;

    if (maxColumns !== undefined && profiled >= maxColumns) continue;
    profiled++;

    const qn = qi(col.name);
    const fragments: string[] = [];
    const alias = (suffix: string) => qi(`${col.name}__${suffix}`);

    // Distinct count — always
    if (useApprox) {
      fragments.push(`APPROX_COUNT_DISTINCT(${qn}) AS ${alias('d')}`);
    } else {
      fragments.push(`COUNT(DISTINCT ${qn}) AS ${alias('d')}`);
    }

    // Null count — only for nullable columns
    const isNullable = col.nullable === 'NULL';
    if (isNullable) {
      fragments.push(`SUM(CASE WHEN ${qn} IS NULL THEN 1 ELSE 0 END) AS ${alias('n')}`);
    }

    // Standard mode: additional aggregations based on type
    if (mode === 'standard') {
      if (cat === 'integer' || cat === 'decimal') {
        fragments.push(`MIN(${qn}) AS ${alias('min')}`);
        fragments.push(`MAX(${qn}) AS ${alias('max')}`);
        fragments.push(`AVG(CAST(${qn} AS float)) AS ${alias('avg')}`);
        fragments.push(`STDEV(CAST(${qn} AS float)) AS ${alias('sd')}`);
        if (isNullable) {
          fragments.push(`SUM(CASE WHEN ${qn} = 0 THEN 1 ELSE 0 END) AS ${alias('z')}`);
        }
      } else if (cat === 'datetime') {
        fragments.push(`MIN(${qn}) AS ${alias('min')}`);
        fragments.push(`MAX(${qn}) AS ${alias('max')}`);
      } else if (cat === 'string') {
        fragments.push(`MIN(LEN(${qn})) AS ${alias('minl')}`);
        fragments.push(`MAX(LEN(${qn})) AS ${alias('maxl')}`);
        fragments.push(`SUM(CASE WHEN ${qn} = '' THEN 1 ELSE 0 END) AS ${alias('e')}`);
      }
    }

    result.push({ colName: col.name, fragments, category: cat });
  }

  return result;
}

/**
 * Build the full profiling SELECT query.
 *
 * @param schema        - Table schema
 * @param tableName     - Table name
 * @param aggregations  - From buildColumnAggregations()
 * @param engineEdition - From IServerInfo.engineEditionId (2/3=SQL Server, 5=Azure SQL, 6=Synapse, 11=Fabric)
 * @param rowCount      - From DMV row count query
 * @param sampleThreshold - Rows below which full scan is used
 * @param sampleSize    - Target sample size (rows)
 */
export function buildProfilingQuery(
  schema: string,
  tableName: string,
  aggregations: ColumnAggregation[],
  engineEdition: number,
  rowCount: number,
  sampleThreshold: number,
  sampleSize: number,
): string {
  const allFragments = aggregations.flatMap(a => a.fragments);
  if (allFragments.length === 0) return '';

  const columnsAgg = allFragments.join(',\n  ');
  const fullTable = `${qi(schema)}.${qi(tableName)}`;

  // Determine sampling
  const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
  let topClause = '';
  let tablesampleClause = '';

  if (needsSampling) {
    if (engineEdition === ENGINE_EDITION_FABRIC) {
      topClause = `TOP ${sampleSize} `;
    } else {
      const pct = computeSamplePercent(engineEdition, sampleSize, rowCount);
      tablesampleClause = ` TABLESAMPLE(${pct} PERCENT)`;
    }
  }

  return `SELECT ${topClause}${columnsAgg}\nFROM ${fullTable}${tablesampleClause}`;
}

/** Bracket-quote a SQL identifier for use inside a T-SQL string literal. */
function qiStr(name: string): string {
  return qi(name).replace(/'/g, "''");
}

/** Build DMV row count query for a table. */
export function buildRowCountQuery(schema: string, tableName: string): string {
  return `SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID('${qiStr(schema)}.${qiStr(tableName)}')
  AND p.index_id IN (0, 1)`;
}

/** Compute the TABLESAMPLE percent. Fabric uses TOP N instead (handled by buildProfilingQuery caller). */
export function computeSamplePercent(_engineEdition: number, sampleSize: number, rowCount: number): number {
  if (rowCount <= 0) return 100;
  return Math.min(100, Math.ceil((sampleSize / rowCount) * 100));
}

// ─── Compact Date Formatting ────────────────────────────────────────────────

/**
 * Truncate a datetime string for display in the stats grid.
 * - Midnight or date-only → `YYYY-MM-DD`
 * - Otherwise → `YYYY-MM-DD HH:mm`
 * Never shows seconds/milliseconds.
 */
export function compactDate(raw: string): string {
  if (!raw || raw === 'NULL') return raw;
  const trimmed = raw.trim();

  // Already date-only (YYYY-MM-DD)?
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Try to parse as date+time
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/);
  if (!match) return trimmed; // unparseable — return as-is

  const [, datePart, hh, mm, ss, ms] = match;
  // If time is midnight (00:00:00.000), show date only
  if (hh === '00' && mm === '00' && (!ss || ss === '00') && (!ms || /^0+$/.test(ms))) {
    return datePart;
  }
  return `${datePart} ${hh}:${mm}`;
}

// ─── Type Badge Labels ──────────────────────────────────────────────────────

/** Short label for column type display in the stats grid. */
const TYPE_BADGE_LABELS: Record<string, string> = {
  int: 'INT', bigint: 'INT', smallint: 'INT', tinyint: 'INT',
  decimal: 'DEC', numeric: 'DEC', float: 'DEC', real: 'DEC',
  money: 'DEC', smallmoney: 'DEC',
  varchar: 'STR', nvarchar: 'STR', char: 'STR', nchar: 'STR',
  date: 'DATE', datetime: 'DATE', datetime2: 'DATE',
  smalldatetime: 'DATE', datetimeoffset: 'DATE', time: 'TIME',
  bit: 'BIT',
  uniqueidentifier: 'UUID',
  binary: 'BIN', varbinary: 'BIN', image: 'BIN',
  text: 'TXT', ntext: 'TXT',
  xml: 'XML',
  geography: 'GEO', geometry: 'GEO', hierarchyid: 'HIER',
  sql_variant: 'VAR', timestamp: 'TS', rowversion: 'TS', sysname: 'STR',
};

/** Get the short badge label for a SQL type string. */
export function typeBadgeLabel(typeStr: string): string {
  const base = extractBaseType(typeStr);
  return TYPE_BADGE_LABELS[base] ?? base.toUpperCase().slice(0, 4);
}

// ─── Result Parsing ─────────────────────────────────────────────────────────

/**
 * Parse the single-row profiling result into TableStats.
 */
export function parseProfilingResult(
  row: Record<string, string>,
  cols: ColumnDef[],
  rowCount: number,
  sampled: boolean,
  samplePercent?: number,
): TableStats {
  const columns: ColumnStats[] = [];
  const warnings: string[] = [];

  function safeInt(raw: string | undefined, label: string): number {
    if (raw === undefined) return 0;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) {
      warnings.push(`${label}: expected number, got '${raw}'`);
      return 0;
    }
    return n;
  }

  for (const col of cols) {
    const cat = classifyColumn(col);
    const isNullable = col.nullable === 'NULL';

    if (cat === 'skip') {
      columns.push({
        name: col.name,
        type: col.type,
        distinctCount: 0,
        nullCount: null,
        nullPercent: null,
        completeness: 1,
        uniqueness: 0,
        skipped: true,
      });
      continue;
    }

    const distinctCount = safeInt(row[`${col.name}__d`], `${col.name} distinct`);
    const nullCount = isNullable ? safeInt(row[`${col.name}__n`], `${col.name} nulls`) : null;
    const nullPercent = nullCount !== null && rowCount > 0 ? (nullCount / rowCount) * 100 : null;
    const completeness = nullCount !== null && rowCount > 0 ? 1 - (nullCount / rowCount) : 1;
    const uniqueness = rowCount > 0 ? Math.min(distinctCount / rowCount, 1) : 0;

    const entry: ColumnStats = {
      name: col.name,
      type: col.type,
      distinctCount,
      nullCount,
      nullPercent,
      completeness,
      uniqueness,
    };

    // Standard-mode fields
    const minRaw = row[`${col.name}__min`];
    const maxRaw = row[`${col.name}__max`];
    const isDatetime = cat === 'datetime';
    if (minRaw !== undefined) entry.min = isDatetime ? compactDate(minRaw) : minRaw;
    if (maxRaw !== undefined) entry.max = isDatetime ? compactDate(maxRaw) : maxRaw;

    const avgRaw = row[`${col.name}__avg`];
    const sdRaw = row[`${col.name}__sd`];
    if (avgRaw !== undefined) entry.mean = parseFloat(avgRaw) || 0;
    if (sdRaw !== undefined) entry.stdDev = parseFloat(sdRaw) || 0;

    const minlRaw = row[`${col.name}__minl`];
    const maxlRaw = row[`${col.name}__maxl`];
    if (minlRaw !== undefined) entry.minLength = safeInt(minlRaw, `${col.name} minLen`);
    if (maxlRaw !== undefined) entry.maxLength = safeInt(maxlRaw, `${col.name} maxLen`);

    const zRaw = row[`${col.name}__z`];
    if (zRaw !== undefined) entry.zeroCount = safeInt(zRaw, `${col.name} zeroCount`);

    const eRaw = row[`${col.name}__e`];
    if (eRaw !== undefined) entry.emptyCount = safeInt(eRaw, `${col.name} emptyCount`);

    columns.push(entry);
  }

  return { rowCount, columns, sampled, samplePercent, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─── Top-N Values (on-demand per column) ─────────────────────────────────────

/**
 * Build a Top-N frequency query for a single column.
 * Returns the N most frequent values with counts.
 */
export function buildTopNQuery(
  schema: string,
  tableName: string,
  colName: string,
  topN: number,
): string {
  const fullTable = `${qi(schema)}.${qi(tableName)}`;
  const qn = qi(colName);
  return `SELECT TOP ${topN} CAST(${qn} AS nvarchar(200)) AS val, COUNT(*) AS cnt\nFROM ${fullTable}\nGROUP BY ${qn}\nORDER BY cnt DESC`;
}

/**
 * Parse Top-N query rows into TopValue array.
 */
export function parseTopNResult(
  rows: Array<{ val: string; cnt: string }>,
  rowCount: number,
): TopValue[] {
  return rows.map(r => {
    const count = parseInt(r.cnt, 10) || 0;
    return {
      value: r.val ?? '(NULL)',
      count,
      percent: rowCount > 0 ? (count / rowCount) * 100 : 0,
    };
  });
}
