/**
 * @module DmvExtractor
 * Handles the transformation of raw SQL Server DMV (Dynamic Management View) results into a structured database model.
 *
 * This module is responsible for:
 * - Parsing and validating result sets from `sys.objects`, `sys.columns`, and `sys.sql_expression_dependencies`.
 * - Reconstructing complex constraints (FK, UQ, CK) from relational rows.
 * - Mapping SQL Server engine editions and versions to human-readable platform names.
 * - Building lightweight schema previews for Phase 1 exploration.
 */

import {
  DatabaseModel,
  SchemaInfo,
  SchemaPreview,
  DMV_TYPE_MAP,
  ExtractedObject,
  ExtractedDependency,
  ColumnDef,
  ForeignKeyInfo,
  ConstraintMaps,
  buildColumnDef,
  enrichColumnsWithConstraints,
  createEmptySchemaInfo,
  DEFAULT_CONFIG,
} from './types';
import { buildModel, normalizeName } from './modelBuilder';
import type { SimpleExecuteResult, DbCellValue } from '../types/mssql';
import { schemaKey } from '../utils/sql';

/**
 * Aggregates raw query results from various system catalog views.
 */
export interface DmvResults {
  /** Core object definitions (tables, views, procedures) and their body scripts. */
  nodes: SimpleExecuteResult;
  /** Column metadata including types, lengths, and nullability. */
  columns: SimpleExecuteResult;
  /** Raw cross-object dependency edges. */
  dependencies: SimpleExecuteResult;
  /** Full cross-schema catalog for dependency resolution. */
  allObjects?: SimpleExecuteResult;
  /** metadata for Foreign Key, Unique, and Check constraints. */
  constraints?: SimpleExecuteResult;
  /** Server-level platform and version metadata. */
  platformInfo?: SimpleExecuteResult;
}

/**
 * Processes schema-preview query results to build a lightweight summary of the database.
 *
 * @param result - Raw query result containing schema object aggregates.
 * @returns A structured summary of schemas and object counts.
 */
export function buildSchemaPreview(result: SimpleExecuteResult): SchemaPreview {
  const colIdx = buildColumnIndex(result);
  const schemaMap = new Map<string, SchemaInfo>();
  let totalObjects = 0;

  for (const row of result.rows) {
    const schemaName = cellValue(row, colIdx, 'schema_name');
    const typeCode = cellValue(row, colIdx, 'type_code').trim();
    const count = parseInt(cellValue(row, colIdx, 'object_count'), 10) || 0;
    const objType = DMV_TYPE_MAP[typeCode];
    if (!objType) continue;

    const key = schemaKey(schemaName);
    let info = schemaMap.get(key);
    if (!info) {
      info = createEmptySchemaInfo(schemaName);
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

/**
 * Constructs a fully resolved DatabaseModel from DMV query results.
 *
 * @param results - Aggregate raw DMV results.
 * @param currentDatabase - Context of the current database for name resolution.
 * @param externalRefsEnabled - Whether to model unresolved dependencies as external nodes.
 * @param maxNodes - Safety limit for the number of nodes in the graph.
 * @returns A resolved DatabaseModel including the graph and metadata.
 */
export function buildModelFromDmv(
  results: DmvResults,
  currentDatabase?: string,
  externalRefsEnabled = true,
  maxNodes = DEFAULT_CONFIG.maxNodes,
  onDebugLog?: (msg: string) => void,
): DatabaseModel {
  const objects = extractObjects(results);
  const deps = extractDependencies(results);
  const allObjects = results.allObjects ? extractAllObjects(results.allObjects) : undefined;
  const model = buildModel(objects, deps, allObjects, currentDatabase, externalRefsEnabled, maxNodes, onDebugLog);
  const dbPlatform = results.platformInfo ? mapEnginePlatform(results.platformInfo) : undefined;

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No user objects found in database.');
  }

  return { ...model, warnings: warnings.length > 0 ? warnings : undefined, dbPlatform };
}

/**
 * Maps SQL Server engine metadata to human-readable platform strings.
 */
function mapEnginePlatform(result: SimpleExecuteResult): string | undefined {
  if (!result.rows.length) return undefined;
  const colIdx = buildColumnIndex(result);
  const row = result.rows[0];
  const engineEdition = parseInt(cellValue(row, colIdx, 'engine_edition'), 10);
  const majorVersion  = parseInt(cellValue(row, colIdx, 'major_version'), 10);
  const edition       = cellValue(row, colIdx, 'edition');
  
  switch (engineEdition) {
    case 5:  return 'Azure SQL Database';
    case 6:  return 'Synapse Dedicated Pool';
    case 8:  return 'Azure SQL Managed Instance';
    case 9:  return 'Azure SQL Edge';
    case 11: return 'Fabric Data Warehouse';
    case 12: return 'SQL Database in Fabric';
    default: {
      const versionYearMap: Record<number, string> = {
        8: '2000', 9: '2005', 10: '2008', 11: '2012',
        12: '2014', 13: '2016', 14: '2017', 15: '2019',
        16: '2022', 17: '2025',
      };
      const year = versionYearMap[majorVersion];
      return year ? `SQL Server ${year}` : (edition || undefined);
    }
  }
}

/**
 * Column requirements for various DMV queries to ensure data integrity.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  'schema-preview': ['schema_name', 'type_code', 'object_count'],
  'all-objects': ['schema_name', 'object_name', 'type_code'],
  nodes: ['schema_name', 'object_name', 'type_code', 'body_script'],
  columns: [
    'schema_name', 'table_name', 'ordinal', 'column_name',
    'type_name', 'max_length', 'precision', 'scale',
    'is_nullable', 'is_identity', 'is_computed'
  ],
  constraints: [
    'schema_name', 'table_name', 'constraint_type', 'constraint_name',
    'column_name', 'column_ordinal', 'ref_schema', 'ref_table', 'ref_column', 'on_delete'
  ],
  dependencies: ['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'],
};

/**
 * Validates a query result against its expected schema.
 *
 * @param name - Identifier of the query.
 * @param result - Raw result set to validate.
 * @returns List of missing columns.
 */
export function validateQueryResult(name: string, result: SimpleExecuteResult): string[] {
  const required = REQUIRED_COLUMNS[name];
  if (!required) return [];
  const actual = new Set(result.columnInfo.map(c => c.columnName.toLowerCase()));
  return required.filter(c => !actual.has(c));
}

/**
 * Safely extracts a cell value from a database row.
 */
function cellValue(row: DbCellValue[], colIndex: Map<string, number>, name: string): string {
  const idx = colIndex.get(name);
  if (idx === undefined) return '';
  const cell = row[idx];
  return cell && !cell.isNull ? cell.displayValue : '';
}

/**
 * Builds a fast-lookup map for column names to their array indices.
 */
function buildColumnIndex(result: SimpleExecuteResult): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < result.columnInfo.length; i++) {
    map.set(result.columnInfo[i].columnName.toLowerCase(), i);
  }
  return map;
}

/**
 * Reconstructs UQ, CK, and FK constraints from a flattened result set.
 */
function buildConstraintMaps(result: SimpleExecuteResult): ConstraintMaps {
  const colIdx = buildColumnIndex(result);
  const uqColMap = new Map<string, string>();
  const ckColMap = new Map<string, string>();

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
      if (!uqColMap.has(colKey)) uqColMap.set(colKey, cname);
    } else if (ctype === 'CK') {
      if (!ckColMap.has(colKey)) ckColMap.set(colKey, cname);
    } else if (ctype === 'FK') {
      const refSchema = cellValue(row, colIdx, 'ref_schema');
      const refTable  = cellValue(row, colIdx, 'ref_table');
      const refCol    = cellValue(row, colIdx, 'ref_column');
      const onDelete  = cellValue(row, colIdx, 'on_delete').replace(/_/g, ' ');

      const fkKey = `${tableKey}.${cname}`.toLowerCase();
      let fk = fkPartial.get(fkKey);
      if (!fk) {
        fk = { name: cname, columns: [], refSchema, refTable, refColumns: [], onDelete };
        fkPartial.set(fkKey, fk);
        if (!fkMap.has(tableKey)) fkMap.set(tableKey, []);
        fkMap.get(tableKey)!.push(fk);
      }
      fk.columns.push(colName);
      fk.refColumns.push(refCol);
    }
  }

  for (const [tableKey, fks] of fkMap) {
    const valid = fks.filter(fk => fk.columns.length === fk.refColumns.length);
    if (valid.length !== fks.length) fkMap.set(tableKey, valid);
  }

  return { uqColMap, ckColMap, fkMap, pkOrdinalMap: new Map() };
}

/**
 * Extracts normalized objects and their columns from raw result sets.
 */
function extractObjects(results: DmvResults): ExtractedObject[] {
  const nodeColIdx = buildColumnIndex(results.nodes);
  const colColIdx = buildColumnIndex(results.columns);

  const constraintMaps = results.constraints
    ? buildConstraintMaps(results.constraints)
    : null;

  const isTruthy = (v: string) => v === '1' || v.toLowerCase() === 'true';
  const objectColumns = new Map<string, ColumnDef[]>();
  
  for (const row of results.columns.rows) {
    const schema = cellValue(row, colColIdx, 'schema_name');
    const table = cellValue(row, colColIdx, 'table_name');
    const key = `${schema}.${table}`.toLowerCase();
    
    if (!objectColumns.has(key)) objectColumns.set(key, []);
    
    const col = buildColumnDef(
      cellValue(row, colColIdx, 'column_name'),
      cellValue(row, colColIdx, 'type_name'),
      isTruthy(cellValue(row, colColIdx, 'is_nullable')),
      isTruthy(cellValue(row, colColIdx, 'is_identity')),
      isTruthy(cellValue(row, colColIdx, 'is_computed')),
      cellValue(row, colColIdx, 'max_length'),
      cellValue(row, colColIdx, 'precision'),
      cellValue(row, colColIdx, 'scale'),
    );
    
    const pkOrdinalRaw = cellValue(row, colColIdx, 'pk_ordinal');
    if (pkOrdinalRaw) {
      const pk = parseInt(pkOrdinalRaw, 10);
      if (pk > 0) col.pkOrdinal = pk;
    }
    objectColumns.get(key)!.push(col);
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

    let columns: ColumnDef[] | undefined;
    let fks: ForeignKeyInfo[] | undefined;
    const objectKey = `${schemaName}.${objectName}`.toLowerCase();
    const cols = objectColumns.get(objectKey);
    
    if (cols) {
      columns = cols;
      if (constraintMaps && (objType === 'table' || objType === 'external')) {
        fks = enrichColumnsWithConstraints(columns, objectKey, constraintMaps);
      }
    }

    objects.push({
      fullName,
      type: objType,
      bodyScript: bodyScript || undefined,
      columns,
      fks,
      ...(objType === 'external' && { externalType: 'et' as const }),
    });
  }

  return objects;
}

/**
 * Extracts directional dependencies between objects based on sys.sql_expression_dependencies.
 */
function extractDependencies(results: DmvResults): ExtractedDependency[] {
  const depColIdx = buildColumnIndex(results.dependencies);
  const deps: ExtractedDependency[] = [];

  for (const row of results.dependencies.rows) {
    const refSchema = cellValue(row, depColIdx, 'referencing_schema');
    const refName = cellValue(row, depColIdx, 'referencing_name');
    const depSchema = cellValue(row, depColIdx, 'referenced_schema');
    const depName = cellValue(row, depColIdx, 'referenced_name');
    const depDatabase = cellValue(row, depColIdx, 'referenced_database');

    if (!depSchema) continue;

    const targetName = depDatabase
      ? `[${depDatabase}].[${depSchema}].[${depName}]`
      : `[${depSchema}].[${depName}]`;

    deps.push({
      sourceName: `[${refSchema}].[${refName}]`,
      targetName,
    });
  }

  return deps;
}

/**
 * Extracts a lightweight catalog of all objects from the full catalog query.
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
