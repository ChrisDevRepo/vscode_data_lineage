import {
  DacpacModel,
  DMV_TYPE_MAP,
  ExtractedObject,
  ExtractedDependency,
  ColumnDef,
} from './types';
import { buildModel, normalizeName } from './modelBuilder';
import type { SimpleExecuteResult, DbCellValue } from '../types/mssql';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface DmvResults {
  nodes: SimpleExecuteResult;
  columns: SimpleExecuteResult;
  dependencies: SimpleExecuteResult;
}

export function buildModelFromDmv(results: DmvResults): DacpacModel {
  const objects = extractObjects(results);
  const deps = extractDependencies(results);
  const model = buildModel(objects, deps);

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No user objects found in database.');
  }

  return { ...model, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─── Column Contract Validation ─────────────────────────────────────────────

const REQUIRED_COLUMNS: Record<string, string[]> = {
  nodes: ['schema_name', 'object_name', 'type_code', 'body_script'],
  columns: ['schema_name', 'table_name', 'ordinal', 'column_name',
    'type_name', 'max_length', 'precision', 'scale',
    'is_nullable', 'is_identity', 'is_computed'],
  dependencies: ['referencing_schema', 'referencing_name',
    'referenced_schema', 'referenced_name'],
};

export function validateQueryResult(name: string, result: SimpleExecuteResult): string[] {
  const required = REQUIRED_COLUMNS[name];
  if (!required) return [];
  const actual = new Set(result.columnInfo.map(c => c.columnName.toLowerCase()));
  return required.filter(c => !actual.has(c));
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function cellValue(row: DbCellValue[], colIndex: Map<string, number>, name: string): string {
  const idx = colIndex.get(name);
  if (idx === undefined) return '';
  const cell = row[idx];
  return cell && !cell.isNull ? cell.displayValue : '';
}

function buildColumnIndex(result: SimpleExecuteResult): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < result.columnInfo.length; i++) {
    map.set(result.columnInfo[i].columnName.toLowerCase(), i);
  }
  return map;
}

export function formatColumnType(
  typeName: string, maxLength: string, precision: string, scale: string
): string {
  const t = typeName.toLowerCase();

  // Types that never need length/precision
  if (['int', 'bigint', 'smallint', 'tinyint', 'bit', 'float', 'real',
    'money', 'smallmoney', 'date', 'datetime', 'datetime2', 'smalldatetime',
    'datetimeoffset', 'time', 'timestamp', 'uniqueidentifier', 'xml',
    'text', 'ntext', 'image', 'sql_variant', 'geography', 'geometry',
    'hierarchyid', 'sysname'].includes(t)) {
    return typeName;
  }

  // String/binary types: use max_length (-1 = max)
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(t)) {
    if (maxLength === '-1') return `${typeName}(max)`;
    // nvarchar/nchar store 2 bytes per char — display char count
    const len = (t.startsWith('n') && maxLength) ? String(Math.floor(parseInt(maxLength, 10) / 2)) : maxLength;
    return len ? `${typeName}(${len})` : typeName;
  }

  // Decimal/numeric: precision,scale
  if (['decimal', 'numeric'].includes(t)) {
    if (precision && scale) return `${typeName}(${precision},${scale})`;
    if (precision) return `${typeName}(${precision})`;
    return typeName;
  }

  return typeName;
}

// ─── Extract: DMV Rows → Intermediate Format ────────────────────────────────

function extractObjects(results: DmvResults): ExtractedObject[] {
  const nodeColIdx = buildColumnIndex(results.nodes);
  const colColIdx = buildColumnIndex(results.columns);

  // Pre-build column data for tables (grouped by schema.table)
  const tableColumns = new Map<string, ColumnDef[]>();
  for (const row of results.columns.rows) {
    const schema = cellValue(row, colColIdx, 'schema_name');
    const table = cellValue(row, colColIdx, 'table_name');
    const key = `${schema}.${table}`.toLowerCase();
    if (!tableColumns.has(key)) tableColumns.set(key, []);
    tableColumns.get(key)!.push({
      name: cellValue(row, colColIdx, 'column_name'),
      type: formatColumnType(
        cellValue(row, colColIdx, 'type_name'),
        cellValue(row, colColIdx, 'max_length'),
        cellValue(row, colColIdx, 'precision'),
        cellValue(row, colColIdx, 'scale'),
      ),
      nullable: cellValue(row, colColIdx, 'is_nullable') === '1' || cellValue(row, colColIdx, 'is_nullable').toLowerCase() === 'true' ? 'NULL' : 'NOT NULL',
      extra: cellValue(row, colColIdx, 'is_identity') === '1' || cellValue(row, colColIdx, 'is_identity').toLowerCase() === 'true'
        ? 'IDENTITY'
        : cellValue(row, colColIdx, 'is_computed') === '1' || cellValue(row, colColIdx, 'is_computed').toLowerCase() === 'true'
          ? 'COMPUTED'
          : '',
    });
  }

  const objects: ExtractedObject[] = [];
  const seen = new Set<string>();

  for (const row of results.nodes.rows) {
    const schemaName = cellValue(row, nodeColIdx, 'schema_name');
    const objectName = cellValue(row, nodeColIdx, 'object_name');
    const typeCode = cellValue(row, nodeColIdx, 'type_code').trim();
    const bodyScript = cellValue(row, nodeColIdx, 'body_script');

    const objType = DMV_TYPE_MAP[typeCode];
    if (!objType) continue;

    const fullName = `[${schemaName}].[${objectName}]`;
    const id = normalizeName(fullName);
    if (seen.has(id)) continue;
    seen.add(id);

    // For tables without body: attach column metadata for design view
    let columns: ColumnDef[] | undefined;
    if (!bodyScript && objType === 'table') {
      const colKey = `${schemaName}.${objectName}`.toLowerCase();
      columns = tableColumns.get(colKey);
    }

    objects.push({
      fullName,
      type: objType,
      bodyScript: bodyScript || undefined,
      columns,
    });
  }

  return objects;
}

function extractDependencies(results: DmvResults): ExtractedDependency[] {
  const depColIdx = buildColumnIndex(results.dependencies);
  const deps: ExtractedDependency[] = [];

  for (const row of results.dependencies.rows) {
    const refSchema = cellValue(row, depColIdx, 'referencing_schema');
    const refName = cellValue(row, depColIdx, 'referencing_name');
    const depSchema = cellValue(row, depColIdx, 'referenced_schema');
    const depName = cellValue(row, depColIdx, 'referenced_name');

    deps.push({
      sourceName: `[${refSchema}].[${refName}]`,
      targetName: `[${depSchema}].[${depName}]`,
    });
  }

  return deps;
}
