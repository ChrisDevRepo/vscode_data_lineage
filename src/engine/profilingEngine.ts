/**
 * Table profiling query generator and result parser.
 *
 * Generates type-aware, single-pass SQL aggregation queries for table statistics.
 * Supports Quick (distinct + null%) and Detail (+ min/max + len) modes.
 *
 * Target platforms: SQL Server 2022+, Azure SQL, Synapse Dedicated SQL Pool, Fabric DWH.
 */

import type { ColumnDef } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ColumnStats {
  name: string;
  type: string;
  distinctCount: number;
  nullCount: number | null;    // null = NOT NULL column, skipped
  nullPercent: number | null;
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
  skipped?: boolean;
}

export interface TableStats {
  rowCount: number;
  columns: ColumnStats[];
  sampled: boolean;
  samplePercent?: number;
}

export type StatsMode = 'quick' | 'detail';

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
  if (col.extra === 'COMPUTED' || col.type === '(computed)') return 'skip';
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
): ColumnAggregation[] {
  const result: ColumnAggregation[] = [];

  for (const col of cols) {
    const cat = classifyColumn(col);
    if (cat === 'skip') continue;

    const qn = qi(col.name);
    const fragments: string[] = [];
    const distinctFn = useApprox ? 'APPROX_COUNT_DISTINCT' : 'COUNT(DISTINCT';
    const distinctClose = useApprox ? ')' : ')';
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

    // Detail mode: additional aggregations based on type
    if (mode === 'detail') {
      if (cat === 'integer' || cat === 'decimal' || cat === 'datetime') {
        fragments.push(`MIN(${qn}) AS ${alias('min')}`);
        fragments.push(`MAX(${qn}) AS ${alias('max')}`);
      } else if (cat === 'string') {
        fragments.push(`MIN(LEN(${qn})) AS ${alias('minl')}`);
        fragments.push(`MAX(LEN(${qn})) AS ${alias('maxl')}`);
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
    const isFabric = engineEdition === 11;
    if (isFabric) {
      // Fabric DWH: no TABLESAMPLE, use TOP N
      topClause = `TOP ${sampleSize} `;
    } else {
      // SQL Server, Azure SQL, Synapse Dedicated: TABLESAMPLE PERCENT
      const pct = Math.min(100, Math.ceil((sampleSize / rowCount) * 100));
      tablesampleClause = ` TABLESAMPLE(${pct} PERCENT)`;
    }
  }

  return `SELECT ${topClause}${columnsAgg}\nFROM ${fullTable}${tablesampleClause}`;
}

/** Build DMV row count query for a table. */
export function buildRowCountQuery(schema: string, tableName: string): string {
  return `SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID('${qi(schema)}.${qi(tableName)}')
  AND p.index_id IN (0, 1)`;
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
        skipped: true,
      });
      continue;
    }

    const distinctRaw = row[`${col.name}__d`];
    const nullRaw = isNullable ? row[`${col.name}__n`] : undefined;
    const distinctCount = distinctRaw !== undefined ? parseInt(distinctRaw, 10) || 0 : 0;
    const nullCount = nullRaw !== undefined ? parseInt(nullRaw, 10) || 0 : null;
    const nullPercent = nullCount !== null && rowCount > 0 ? (nullCount / rowCount) * 100 : null;

    const entry: ColumnStats = {
      name: col.name,
      type: col.type,
      distinctCount,
      nullCount,
      nullPercent,
    };

    // Detail fields
    const minRaw = row[`${col.name}__min`];
    const maxRaw = row[`${col.name}__max`];
    if (minRaw !== undefined) entry.min = minRaw;
    if (maxRaw !== undefined) entry.max = maxRaw;

    const minlRaw = row[`${col.name}__minl`];
    const maxlRaw = row[`${col.name}__maxl`];
    if (minlRaw !== undefined) entry.minLength = parseInt(minlRaw, 10) || 0;
    if (maxlRaw !== undefined) entry.maxLength = parseInt(maxlRaw, 10) || 0;

    columns.push(entry);
  }

  return { rowCount, columns, sampled, samplePercent };
}
