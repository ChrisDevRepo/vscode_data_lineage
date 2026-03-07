import {
  DacpacModel,
  SchemaInfo,
  SchemaPreview,
  DMV_TYPE_MAP,
  ExtractedObject,
  ExtractedDependency,
  ColumnDef,
  ForeignKeyInfo,
  buildColumnDef,
} from './types';
import { buildModel, normalizeName } from './modelBuilder';
import type { SimpleExecuteResult, DbCellValue } from '../types/mssql';
import { schemaKey } from '../utils/sql';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface DmvResults {
  nodes: SimpleExecuteResult;
  columns: SimpleExecuteResult;
  dependencies: SimpleExecuteResult;
  /** Phase 1 all-objects result: full cross-schema catalog for dependency resolution. */
  allObjects?: SimpleExecuteResult;
  /** Phase 2 constraints result: FK, UQ, CK metadata for table design view. */
  constraints?: SimpleExecuteResult;
}

/**
 * Phase 1: Build SchemaPreview from the schema-preview query result.
 * Maps (schema_name, type_code, object_count) rows → SchemaInfo[].
 * Schema names are preserved in their catalog-original casing.
 */
export function buildSchemaPreview(result: SimpleExecuteResult): SchemaPreview {
  const colIdx = buildColumnIndex(result);
  const schemaMap = new Map<string, SchemaInfo>();
  let totalObjects = 0;

  for (const row of result.rows) {
    const schemaName = cellValue(row, colIdx, 'schema_name'); // preserve catalog casing
    const typeCode = cellValue(row, colIdx, 'type_code').trim();
    const count = parseInt(cellValue(row, colIdx, 'object_count'), 10) || 0;
    const objType = DMV_TYPE_MAP[typeCode];
    if (!objType) continue;

    const key = schemaKey(schemaName);
    let info = schemaMap.get(key);
    if (!info) {
      info = { name: schemaName, nodeCount: 0, types: { table: 0, view: 0, procedure: 0, function: 0, external: 0 } };
      schemaMap.set(key, info);
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
  const allObjects = results.allObjects ? extractAllObjects(results.allObjects) : undefined;
  const model = buildModel(objects, deps, allObjects);

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No user objects found in database.');
  }

  return { ...model, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─── Column Contract Validation ─────────────────────────────────────────────

const REQUIRED_COLUMNS: Record<string, string[]> = {
  'schema-preview': ['schema_name', 'type_code', 'object_count'],
  'all-objects': ['schema_name', 'object_name', 'type_code'],
  nodes: ['schema_name', 'object_name', 'type_code', 'body_script'],
  columns: ['schema_name', 'table_name', 'ordinal', 'column_name',
    'type_name', 'max_length', 'precision', 'scale',
    'is_nullable', 'is_identity', 'is_computed'],
  constraints: ['schema_name', 'table_name', 'constraint_type', 'constraint_name',
    'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete'],
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

// ─── Constraint Maps ────────────────────────────────────────────────────────

interface ConstraintMaps {
  /** Key: "schema.table.column" (lowercase) → UQ constraint name */
  uqColMap: Map<string, string>;
  /** Key: "schema.table.column" (lowercase) → CK constraint name */
  ckColMap: Map<string, string>;
  /** Key: "schema.table" (lowercase) → FK list */
  fkMap: Map<string, ForeignKeyInfo[]>;
}

/**
 * Parse the combined constraints result set into three lookup maps.
 * Rows are discriminated by constraint_type ('FK' | 'UQ' | 'CK').
 * FK rows accumulate per-column entries then get merged into ForeignKeyInfo objects.
 */
function buildConstraintMaps(result: SimpleExecuteResult): ConstraintMaps {
  const colIdx = buildColumnIndex(result);
  const uqColMap = new Map<string, string>();
  const ckColMap = new Map<string, string>();

  // Accumulate FK column pairs keyed by "schema.table.constraint" (lowercase)
  // Each entry holds the in-progress ForeignKeyInfo being built
  const fkPartial = new Map<string, ForeignKeyInfo>();
  const fkMap = new Map<string, ForeignKeyInfo[]>();

  for (const row of result.rows) {
    const schemaName = cellValue(row, colIdx, 'schema_name');
    const tableName  = cellValue(row, colIdx, 'table_name');
    const ctype      = cellValue(row, colIdx, 'constraint_type');
    const cname      = cellValue(row, colIdx, 'constraint_name');
    const colName    = cellValue(row, colIdx, 'column_name');

    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const colKey   = `${tableKey}.${colName}`.toLowerCase();

    if (ctype === 'UQ') {
      // First UQ entry for a column wins (multiple UQ constraints on same column is unusual)
      if (!uqColMap.has(colKey)) uqColMap.set(colKey, cname);

    } else if (ctype === 'CK') {
      if (!ckColMap.has(colKey)) ckColMap.set(colKey, cname);

    } else if (ctype === 'FK') {
      const refSchema = cellValue(row, colIdx, 'ref_schema');
      const refTable  = cellValue(row, colIdx, 'ref_table');
      const refCol    = cellValue(row, colIdx, 'ref_column');
      const onDelete  = cellValue(row, colIdx, 'on_delete');

      const fkKey = `${tableKey}.${cname}`.toLowerCase();
      let fk = fkPartial.get(fkKey);
      if (!fk) {
        fk = { name: cname, columns: [], refSchema, refTable, refColumns: [], onDelete };
        fkPartial.set(fkKey, fk);
        // Register in fkMap in order of first appearance
        if (!fkMap.has(tableKey)) fkMap.set(tableKey, []);
        fkMap.get(tableKey)!.push(fk);
      }
      fk.columns.push(colName);
      fk.refColumns.push(refCol);
    }
  }

  return { uqColMap, ckColMap, fkMap };
}

// ─── Extract: DMV Rows → Intermediate Format ────────────────────────────────

function extractObjects(results: DmvResults): ExtractedObject[] {
  const nodeColIdx = buildColumnIndex(results.nodes);
  const colColIdx = buildColumnIndex(results.columns);

  // Build constraint maps if the constraints query was executed
  const constraintMaps = results.constraints
    ? buildConstraintMaps(results.constraints)
    : null;

  // Pre-build column data for tables (grouped by schema.table, lowercase key)
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

    // For tables (and external tables) without body: attach column metadata for design view
    let columns: ColumnDef[] | undefined;
    let fks: ForeignKeyInfo[] | undefined;
    if (!bodyScript && (objType === 'table' || objType === 'external')) {
      const tableKey = `${schemaName}.${objectName}`.toLowerCase();
      columns = tableColumns.get(tableKey);

      // Enrich columns with UQ/CK flags from constraint maps (lookup key only — no re-fetch)
      if (columns && constraintMaps) {
        for (const col of columns) {
          const ck = `${tableKey}.${col.name}`.toLowerCase();
          col.unique = constraintMaps.uqColMap.get(ck) ?? '';
          col.check  = constraintMaps.ckColMap.get(ck) ?? '';
        }
        fks = constraintMaps.fkMap.get(tableKey) ?? [];
      }
    }

    objects.push({
      fullName,
      type: objType,
      bodyScript: bodyScript || undefined,
      columns,
      fks,
      ...(objType === 'external' && { externalKind: 'et' as const }),
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

    // Only schema-qualified references are supported (schema.object minimum).
    // Unqualified references (referenced_schema_name IS NULL in DMV) are rejected —
    // SQL Server's default-schema resolution is caller-dependent and not reliable.
    if (!depSchema) continue;

    deps.push({
      sourceName: `[${refSchema}].[${refName}]`,
      targetName: `[${depSchema}].[${depName}]`,
    });
  }

  return deps;
}

/**
 * Extract lightweight stubs from the all-objects query result.
 * Used to build the full cross-schema catalog for reference classification.
 * Schema names are preserved in catalog-original casing (no uppercasing).
 */
function extractAllObjects(result: SimpleExecuteResult): ExtractedObject[] {
  const colIdx = buildColumnIndex(result);
  const seen = new Set<string>();
  const objects: ExtractedObject[] = [];

  for (const row of result.rows) {
    const schemaName = cellValue(row, colIdx, 'schema_name');
    const objectName = cellValue(row, colIdx, 'object_name');
    const typeCode = cellValue(row, colIdx, 'type_code').trim();
    const objType = DMV_TYPE_MAP[typeCode];
    if (!objType) continue;

    const fullName = `[${schemaName}].[${objectName}]`;
    const id = normalizeName(fullName);
    if (seen.has(id)) continue;
    seen.add(id);

    objects.push({ fullName, type: objType });
  }

  return objects;
}
