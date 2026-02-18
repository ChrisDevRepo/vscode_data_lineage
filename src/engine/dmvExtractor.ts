import {
  DacpacModel,
  SchemaInfo,
  SchemaPreview,
  DMV_TYPE_MAP,
  ExtractedObject,
  ExtractedDependency,
  ColumnDef,
  buildColumnDef,
} from './types';
import { buildModel, normalizeName } from './modelBuilder';
import type { SimpleExecuteResult, DbCellValue } from '../types/mssql';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface DmvResults {
  nodes: SimpleExecuteResult;
  columns: SimpleExecuteResult;
  dependencies: SimpleExecuteResult;
}

/**
 * Phase 1: Build SchemaPreview from the schema-preview query result.
 * Maps (schema_name, type_code, object_count) rows → SchemaInfo[].
 */
export function buildSchemaPreview(result: SimpleExecuteResult): SchemaPreview {
  const colIdx = buildColumnIndex(result);
  const schemaMap = new Map<string, SchemaInfo>();
  let totalObjects = 0;

  for (const row of result.rows) {
    const schemaName = cellValue(row, colIdx, 'schema_name').toUpperCase();
    const typeCode = cellValue(row, colIdx, 'type_code').trim();
    const count = parseInt(cellValue(row, colIdx, 'object_count'), 10) || 0;
    const objType = DMV_TYPE_MAP[typeCode];
    if (!objType) continue;

    let info = schemaMap.get(schemaName);
    if (!info) {
      info = { name: schemaName, nodeCount: 0, types: { table: 0, view: 0, procedure: 0, function: 0 } };
      schemaMap.set(schemaName, info);
    }
    info.nodeCount += count;
    info.types[objType] += count;
    totalObjects += count;
  }

  const schemas = Array.from(schemaMap.values()).sort((a, b) => b.nodeCount - a.nodeCount);
  const warnings: string[] = [];
  if (totalObjects === 0) {
    warnings.push('No user objects found in database.');
  }
  return { schemas, totalObjects, warnings: warnings.length > 0 ? warnings : undefined };
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
  'schema-preview': ['schema_name', 'type_code', 'object_count'],
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

// ─── Extract: DMV Rows → Intermediate Format ────────────────────────────────

function extractObjects(results: DmvResults): ExtractedObject[] {
  const nodeColIdx = buildColumnIndex(results.nodes);
  const colColIdx = buildColumnIndex(results.columns);

  // Pre-build column data for tables (grouped by schema.table)
  const isTruthy = (v: string) => v === '1' || v.toLowerCase() === 'true';
  const tableColumns = new Map<string, ColumnDef[]>();
  for (const row of results.columns.rows) {
    const schema = cellValue(row, colColIdx, 'schema_name');
    const table = cellValue(row, colColIdx, 'table_name');
    const key = `${schema}.${table}`.toLowerCase();
    if (!tableColumns.has(key)) tableColumns.set(key, []);
    tableColumns.get(key)!.push(buildColumnDef(
      cellValue(row, colColIdx, 'column_name'),
      cellValue(row, colColIdx, 'type_name'),
      isTruthy(cellValue(row, colColIdx, 'is_nullable')),
      isTruthy(cellValue(row, colColIdx, 'is_identity')),
      isTruthy(cellValue(row, colColIdx, 'is_computed')),
      cellValue(row, colColIdx, 'max_length'),
      cellValue(row, colColIdx, 'precision'),
      cellValue(row, colColIdx, 'scale'),
    ));
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
