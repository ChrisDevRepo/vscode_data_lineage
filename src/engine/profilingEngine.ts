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
 *
 * @module profilingEngine
 */

import { ENGINE_EDITION_FABRIC, type ColumnDef } from './types';

/**
 * Represents the statistical profile of a single column.
 */
export interface ColumnStats {
  /** The name of the column. */
  name: string;
  /** The SQL data type of the column. */
  type: string;
  /** The estimated or exact number of distinct values in the column. */
  distinctCount: number;
  /** The number of null values, or null if the column is strictly NOT NULL. */
  nullCount: number | null;
  /** The percentage of null values, or null if the column is strictly NOT NULL. */
  nullPercent: number | null;
  /** The completeness ratio, calculated as 1 - (nullCount / rowCount). */
  completeness: number;
  /** The uniqueness ratio, calculated as distinctCount / rowCount. */
  uniqueness: number;
  /** The minimum value, represented as a string for generic display. */
  min?: string;
  /** The maximum value, represented as a string for generic display. */
  max?: string;
  /** The mean (average) value, applicable to integer and decimal types. */
  mean?: number;
  /** The standard deviation, applicable to integer and decimal types. */
  stdDev?: number;
  /** The minimum string length, applicable to string types. */
  minLength?: number;
  /** The maximum string length, applicable to string types. */
  maxLength?: number;
  /** The count of zero values, applicable to nullable integer and decimal types. */
  zeroCount?: number;
  /** The count of empty string values, applicable to string types. */
  emptyCount?: number;
  /** Indicates whether the column was skipped during profiling (e.g., for unsupported types). */
  skipped?: boolean;
}

/**
 * Represents the statistical profile of a table.
 */
export interface TableStats {
  /** The total number of rows in the table. */
  rowCount: number;
  /** The statistical profile for each column in the table. */
  columns: ColumnStats[];
  /** Indicates whether the statistics were generated from a sample rather than a full scan. */
  sampled: boolean;
  /** The percentage of rows sampled, if sampling was used. */
  samplePercent?: number;
  /** Any warnings generated during the parsing of profiling results. */
  warnings?: string[];
}

/**
 * Defines the profiling mode.
 * - 'quick': Computes only distinct counts and null percentages.
 * - 'standard': Computes extended statistics including min, max, avg, stddev, zero count, and empty count.
 */
export type StatsMode = 'quick' | 'standard';

/**
 * Categories used to determine which aggregations to apply to a column.
 */
type ColCategory = 'integer' | 'decimal' | 'string' | 'datetime' | 'boolean' | 'uuid' | 'skip';

/**
 * Mapping of base SQL Server types to profiling categories.
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
  // Skip types
  binary: 'skip', varbinary: 'skip', image: 'skip',
  text: 'skip', ntext: 'skip', xml: 'skip',
  geography: 'skip', geometry: 'skip', hierarchyid: 'skip',
  sql_variant: 'skip', timestamp: 'skip', rowversion: 'skip', sysname: 'skip',
};

/**
 * Extracts the base type name from a formatted type string.
 *
 * @param typeStr - The full type string (e.g., "nvarchar(50)").
 * @returns The base type name in lowercase (e.g., "nvarchar").
 */
export function extractBaseType(typeStr: string): string {
  return typeStr.replace(/\(.*$/, '').trim().toLowerCase();
}

/**
 * Classifies a column's SQL type into a category for profiling aggregations.
 *
 * @param col - The column definition to classify.
 * @returns The determined category, or 'skip' if the type is not supported for profiling or is a computed column.
 */
export function classifyColumn(col: ColumnDef): ColCategory {
  if (col.extra === 'COMPUTED') return 'skip';
  const base = extractBaseType(col.type);
  return TYPE_CATEGORIES[base] ?? 'skip';
}

/**
 * Bracket-quotes a SQL identifier.
 *
 * @param name - The identifier to quote.
 * @returns The bracket-quoted identifier.
 */
function qi(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`;
}

/**
 * Represents the SQL aggregation fragments generated for a single column.
 */
export interface ColumnAggregation {
  /** The name of the column. */
  colName: string;
  /** The SQL aggregation fragments to include in the SELECT clause. */
  fragments: string[];
  /** The category used to generate the fragments. */
  category: ColCategory;
}

/**
 * Generates per-column SQL aggregation fragments based on the specified mode and column types.
 *
 * @param cols - The array of column definitions to profile.
 * @param useApprox - Whether to use APPROX_COUNT_DISTINCT for faster execution on large tables.
 * @param mode - The profiling mode ('quick' or 'standard') determining the depth of statistics.
 * @param maxColumns - Optional limit on the number of columns to profile.
 * @returns An array of aggregation information, one for each non-skipped column.
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
 * Builds the full profiling SELECT query based on the generated column aggregations.
 *
 * @param schema - The schema name of the table.
 * @param tableName - The name of the table.
 * @param aggregations - The generated column aggregations from {@link buildColumnAggregations}.
 * @param engineEdition - The SQL Server engine edition identifier (2/3=SQL Server, 5=Azure SQL, 6=Synapse, 11=Fabric).
 * @param rowCount - The total row count of the table.
 * @param sampleThreshold - The row count threshold above which sampling should be applied.
 * @param sampleSize - The target sample size in number of rows.
 * @returns The complete T-SQL query string for profiling, or an empty string if no aggregations exist.
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

/**
 * Bracket-quotes a SQL identifier for use inside a T-SQL string literal.
 *
 * @param name - The identifier to quote.
 * @returns The bracket-quoted and safely escaped identifier string.
 */
function qiStr(name: string): string {
  return qi(name).replace(/'/g, "''");
}

/**
 * Builds a query to efficiently retrieve the row count of a table using dynamic management views.
 *
 * @param schema - The schema name of the table.
 * @param tableName - The name of the table.
 * @returns The T-SQL query string for fetching the row count.
 */
export function buildRowCountQuery(schema: string, tableName: string): string {
  return `SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID('${qiStr(schema)}.${qiStr(tableName)}')
  AND p.index_id IN (0, 1)`;
}

/**
 * Computes the TABLESAMPLE percentage based on the target sample size and total row count.
 * Note: Fabric uses TOP N instead, which is handled directly by {@link buildProfilingQuery}.
 *
 * @param _engineEdition - The SQL Server engine edition identifier (currently unused but reserved).
 * @param sampleSize - The target sample size in number of rows.
 * @param rowCount - The total row count of the table.
 * @returns The computed sampling percentage, between 0 and 100.
 */
export function computeSamplePercent(_engineEdition: number, sampleSize: number, rowCount: number): number {
  if (rowCount <= 0) return 100;
  return Math.min(100, Math.ceil((sampleSize / rowCount) * 100));
}

/**
 * Truncates a datetime string for compact display in the statistics grid.
 * - Formats midnight or date-only values as `YYYY-MM-DD`.
 * - Formats values with time as `YYYY-MM-DD HH:mm`.
 * Never displays seconds or milliseconds.
 *
 * @param raw - The raw datetime string.
 * @returns The formatted and compacted datetime string.
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

/**
 * A mapping for concise column type labels used in UI badges.
 */
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
 * Retrieves a short badge label for a given SQL type string.
 *
 * @param typeStr - The SQL type string.
 * @returns A concise uppercase label representing the base type.
 */
export function typeBadgeLabel(typeStr: string): string {
  const base = extractBaseType(typeStr);
  return TYPE_BADGE_LABELS[base] ?? base.toUpperCase().slice(0, 4);
}

/**
 * Parses a single-row profiling result record into structured table statistics.
 *
 * @param row - The raw result row returned by the profiling query.
 * @param cols - The array of column definitions for the profiled table.
 * @param rowCount - The total or sampled row count evaluated.
 * @param sampled - Indicates whether the results were derived from a sampled dataset.
 * @param samplePercent - The percentage of rows sampled, if applicable.
 * @returns The structured {@link TableStats} object.
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
