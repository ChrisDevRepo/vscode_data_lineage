/**
 * @module ProfilingEngine
 * Handles SQL generation and result parsing for table-level data profiling.
 *
 * This module enables "Smart Profiling" by generating type-aware, single-pass SQL 
 * aggregation queries. It supports multiple target platforms (SQL Server 2022+, 
 * Azure SQL, Synapse, Fabric DWH) and provides:
 * - Statistical metrics (distinct counts, null percentages, completeness, uniqueness).
 * - Advanced profiling (min/max, mean, standard deviation, zero/empty counts).
 * - Automatic sampling logic for massive datasets.
 * - Platform-specific optimizations like `APPROX_COUNT_DISTINCT`.
 */

import { ENGINE_EDITION_FABRIC, type ColumnDef } from './types';

/**
 * Statistical profile for a single column.
 */
export interface ColumnStats {
  /** The original column name. */
  name: string;
  /** The SQL data type (e.g., 'nvarchar(50)'). */
  type: string;
  /** Number of unique values (may be approximated). */
  distinctCount: number;
  /** count of NULL values. */
  nullCount: number | null;
  /** Percentage of rows containing NULL. */
  nullPercent: number | null;
  /** Ratio of non-NULL values to total rows. */
  completeness: number;
  /** Ratio of distinct values to total rows. */
  uniqueness: number;
  /** Minimum value (formatted as string). */
  min?: string;
  /** Maximum value (formatted as string). */
  max?: string;
  /** Numeric mean. */
  mean?: number;
  /** Population standard deviation. */
  stdDev?: number;
  /** Minimum string length. */
  minLength?: number;
  /** Maximum string length. */
  maxLength?: number;
  /** Count of values equal to 0 (numeric only). */
  zeroCount?: number;
  /** Count of empty strings (string only). */
  emptyCount?: number;
  /** Whether profiling was skipped (e.g., for XML/LOB types). */
  skipped?: boolean;
}

/**
 * Comprehensive statistical profile for a database table.
 */
export interface TableStats {
  /** Total rows evaluated (or sampled). */
  rowCount: number;
  /** Metrics for each individual column. */
  columns: ColumnStats[];
  /** Whether the data was sampled or fully scanned. */
  sampled: boolean;
  /** The percentage of the table that was sampled. */
  samplePercent?: number;
  /** Warnings encountered during parsing. */
  warnings?: string[];
}

/**
 * Available profiling depths.
 */
export type StatsMode = 'quick' | 'standard';

/**
 * Internal classification for determining applicable aggregations.
 */
type ColCategory = 'integer' | 'decimal' | 'string' | 'datetime' | 'boolean' | 'uuid' | 'skip';

/**
 * Mapping of SQL Server base types to profiling categories.
 */
const TYPE_CATEGORIES: Record<string, ColCategory> = {
  int: 'integer', bigint: 'integer', smallint: 'integer', tinyint: 'integer',
  decimal: 'decimal', numeric: 'decimal', float: 'decimal', real: 'decimal',
  money: 'decimal', smallmoney: 'decimal',
  varchar: 'string', nvarchar: 'string', char: 'string', nchar: 'string',
  date: 'datetime', datetime: 'datetime', datetime2: 'datetime',
  smalldatetime: 'datetime', datetimeoffset: 'datetime', time: 'datetime',
  bit: 'boolean',
  uniqueidentifier: 'uuid',
  binary: 'skip', varbinary: 'skip', image: 'skip',
  text: 'skip', ntext: 'skip', xml: 'skip',
  geography: 'skip', geometry: 'skip', hierarchyid: 'skip',
  sql_variant: 'skip', timestamp: 'skip', rowversion: 'skip', sysname: 'skip',
};

/**
 * Extracts the base type name from a complex type string (e.g., 'varchar(max)' -> 'varchar').
 */
export function extractBaseType(typeStr: string): string {
  return typeStr.replace(/\(.*$/, '').trim().toLowerCase();
}

/**
 * Classifies a column definition into a profiling category.
 */
export function classifyColumn(col: ColumnDef): ColCategory {
  if (col.extra === 'COMPUTED') return 'skip';
  const base = extractBaseType(col.type);
  return TYPE_CATEGORIES[base] ?? 'skip';
}

/**
 * Safely bracket-quotes a SQL identifier.
 */
function qi(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`;
}

/**
 * Pair of column name and its generated SQL aggregation fragments.
 */
export interface ColumnAggregation {
  colName: string;
  fragments: string[];
  category: ColCategory;
}

/**
 * Generates SQL aggregation fragments for a set of columns based on the requested mode.
 *
 * @param cols - Columns to profile.
 * @param useApprox - Whether to use faster `APPROX_COUNT_DISTINCT`.
 * @param mode - The depth of profiling ('quick' or 'standard').
 * @param maxColumns - Budget for total columns to profile in a single pass.
 * @returns Array of column aggregations.
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

    if (useApprox) {
      fragments.push(`APPROX_COUNT_DISTINCT(${qn}) AS ${alias('d')}`);
    } else {
      fragments.push(`COUNT(DISTINCT ${qn}) AS ${alias('d')}`);
    }

    const isNullable = col.nullable === 'NULL';
    if (isNullable) {
      fragments.push(`SUM(CASE WHEN ${qn} IS NULL THEN 1 ELSE 0 END) AS ${alias('n')}`);
    }

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
 * Assembles the full profiling SELECT statement with optional sampling.
 *
 * @param schema - Target schema.
 * @param tableName - Target table.
 * @param aggregations - Pre-computed column aggregations.
 * @param engineEdition - SQL Server engine edition for platform-specific sampling.
 * @param rowCount - Known total row count.
 * @param sampleThreshold - Threshold to trigger sampling.
 * @param sampleSize - Target row count for the sample.
 * @returns Complete T-SQL profiling query.
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

/**
 * Bracket-quotes and escapes a string for use in dynamic SQL literals.
 */
function qiStr(name: string): string {
  return qi(name).replace(/'/g, "''");
}

/**
 * Generates an efficient row count query using `sys.partitions`.
 */
export function buildRowCountQuery(schema: string, tableName: string): string {
  return `SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID('${qiStr(schema)}.${qiStr(tableName)}')
  AND p.index_id IN (0, 1)`;
}

/**
 * Calculates the required sampling percentage for `TABLESAMPLE`.
 */
export function computeSamplePercent(_engineEdition: number, sampleSize: number, rowCount: number): number {
  if (rowCount <= 0) return 100;
  return Math.min(100, Math.ceil((sampleSize / rowCount) * 100));
}

/**
 * Formats a raw database datetime string into a compact, UI-friendly format.
 */
export function compactDate(raw: string): string {
  if (!raw || raw === 'NULL') return raw;
  const trimmed = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/);
  if (!match) return trimmed;

  const [, datePart, hh, mm, ss, ms] = match;
  if (hh === '00' && mm === '00' && (!ss || ss === '00') && (!ms || /^0+$/.test(ms))) {
    return datePart;
  }
  return `${datePart} ${hh}:${mm}`;
}

/** Short UI labels for base SQL types. */
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

/**
 * Returns a 3-4 letter badge label for a SQL type.
 */
export function typeBadgeLabel(typeStr: string): string {
  const base = extractBaseType(typeStr);
  return TYPE_BADGE_LABELS[base] ?? base.toUpperCase().slice(0, 4);
}

/**
 * Parses the single-row result from a profiling query into structured statistics.
 *
 * @param row - The raw relational result row.
 * @param cols - Column definitions of the table.
 * @param rowCount - The evaluated row count.
 * @param sampled - Whether sampling was used.
 * @param samplePercent - Percentage of rows sampled.
 * @returns Structured TableStats.
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
