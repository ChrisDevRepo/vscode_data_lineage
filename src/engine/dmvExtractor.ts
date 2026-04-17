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
 * Represents the collection of raw query results from SQL Server Dynamic Management Views (DMVs)
 * and system catalog tables.
 * 
 * Used as the primary input for the extraction engine to build the database model
 * and resolve schema dependencies.
 */
export interface DmvResults {
  /**
   * Result set containing core object definitions (tables, views, procedures) and their body scripts.
   */
  nodes: SimpleExecuteResult;
  /**
   * Result set containing column metadata (types, lengths, nullability) for tables, views, and table-valued functions.
   */
  columns: SimpleExecuteResult;
  /**
   * Result set containing raw cross-object dependency edges extracted from `sys.sql_expression_dependencies`.
   */
  dependencies: SimpleExecuteResult;
  /**
   * Phase 1 all-objects result: Full cross-schema catalog used for dependency resolution and classification.
   */
  allObjects?: SimpleExecuteResult;
  /**
   * Phase 2 constraints result: Foreign Key (FK), Unique (UQ), and Check (CK) constraints metadata.
   */
  constraints?: SimpleExecuteResult;
  /**
   * Optional Phase 1 platform-info result: `EngineEdition` and `ProductMajorVersion` to determine the database platform.
   */
  platformInfo?: SimpleExecuteResult;
}

/**
 * Processes the raw schema-preview query results to build a lightweight summary of the database schema.
 *
 * This function maps `(schema_name, type_code, object_count)` rows into a structured array of `SchemaInfo` objects.
 * Schema names are preserved in their catalog-original casing.
 *
 * @param result - The raw query execution result containing schema object aggregates.
 * @returns A structured `SchemaPreview` summarizing the schemas, total object count, and potential warnings.
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
 * Constructs a comprehensive `DatabaseModel` from raw DMV query results.
 *
 * This function orchestrates the extraction of objects, dependencies, and constraints,
 * and passes them to the `buildModel` engine to resolve edges and infer external references.
 *
 * @param results - The aggregate raw DMV results, including nodes, columns, and dependencies.
 * @param currentDatabase - Optional context of the current database name to resolve local 3-part names.
 * @param externalRefsEnabled - Determines whether unresolved dependencies should be modeled as external nodes. Defaults to `true`.
 * @param maxNodes - The safety limit for maximum allowable nodes in the graph. Defaults to `DEFAULT_CONFIG.maxNodes`.
 * @returns A fully resolved `DatabaseModel` containing the graph structure and structural metadata.
 */
export function buildModelFromDmv(
  results: DmvResults,
  currentDatabase?: string,
  externalRefsEnabled = true,
  maxNodes = DEFAULT_CONFIG.maxNodes
): DatabaseModel {
  const objects = extractObjects(results);
  const deps = extractDependencies(results);
  const allObjects = results.allObjects ? extractAllObjects(results.allObjects) : undefined;
  const model = buildModel(objects, deps, allObjects, currentDatabase, externalRefsEnabled, maxNodes);
  const dbPlatform = results.platformInfo ? mapEnginePlatform(results.platformInfo) : undefined;

  const warnings: string[] = [];
  if (objects.length === 0) {
    warnings.push('No user objects found in database.');
  }

  return { ...model, warnings: warnings.length > 0 ? warnings : undefined, dbPlatform };
}

/**
 * Maps the SQL Server `SERVERPROPERTY('EngineEdition')` and `ProductMajorVersion`
 * to a human-readable platform string (e.g., "Azure SQL Database" or "SQL Server 2022").
 *
 * @param result - The raw query execution result containing platform information.
 * @returns A string representing the database platform, or `undefined` if parsing fails.
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
 * Expected columns for each specific DMV query to ensure structural integrity
 * before processing the results.
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
 * Validates the structure of a given query result against its expected required columns.
 *
 * @param name - The identifier of the query (e.g., 'nodes', 'columns', 'constraints').
 * @param result - The raw query result to validate.
 * @returns An array of missing column names. An empty array indicates successful validation.
 */
export function validateQueryResult(name: string, result: SimpleExecuteResult): string[] {
  const required = REQUIRED_COLUMNS[name];
  if (!required) return [];
  const actual = new Set(result.columnInfo.map(c => c.columnName.toLowerCase()));
  return required.filter(c => !actual.has(c));
}

/**
 * Safely extracts a string value from a database cell using a pre-computed column index map.
 *
 * @param row - The raw database row.
 * @param colIndex - A map correlating lowercase column names to their array indices.
 * @param name - The lowercase name of the target column.
 * @returns The string representation of the cell value, or an empty string if null/undefined.
 */
function cellValue(row: DbCellValue[], colIndex: Map<string, number>, name: string): string {
  const idx = colIndex.get(name);
  if (idx === undefined) return '';
  const cell = row[idx];
  return cell && !cell.isNull ? cell.displayValue : '';
}

/**
 * Builds a fast-lookup map for column names to their array index in the query result.
 * Column names are normalized to lowercase to ensure case-insensitive mapping.
 *
 * @param result - The raw query execution result.
 * @returns A Map linking lowercase column names to their 0-based index.
 */
function buildColumnIndex(result: SimpleExecuteResult): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < result.columnInfo.length; i++) {
    map.set(result.columnInfo[i].columnName.toLowerCase(), i);
  }
  return map;
}

/**
 * Parses the combined constraints result set into dedicated lookup maps for
 * Foreign Keys (FK), Unique constraints (UQ), and Check constraints (CK).
 *
 * Rows are discriminated by `constraint_type`. FK rows accumulate per-column entries
 * before being merged into comprehensive `ForeignKeyInfo` objects.
 *
 * @param result - The raw constraints query result.
 * @returns A structured `ConstraintMaps` containing maps for FKs, UQs, and CKs.
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

  // Defensive filtering: drop FKs with mismatched column counts
  for (const [tableKey, fks] of fkMap) {
    const valid = fks.filter(fk => fk.columns.length === fk.refColumns.length);
    if (valid.length !== fks.length) fkMap.set(tableKey, valid);
  }

  return { uqColMap, ckColMap, fkMap, pkOrdinalMap: new Map() };
}

/**
 * Extracts normalized database objects (e.g., tables, views, procedures) and their associated
 * columns from raw DMV node and column result sets.
 *
 * @param results - The comprehensive `DmvResults` containing node, column, and constraint data.
 * @returns An array of structurally normalized `ExtractedObject` entities.
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
 * Extracts topological dependencies between schema objects based on SQL Server's
 * `sys.sql_expression_dependencies`.
 *
 * Unqualified references (lacking a schema name) are rejected to ensure strict
 * dependency resolution.
 *
 * @param results - The comprehensive `DmvResults` containing dependency rows.
 * @returns An array of `ExtractedDependency` representing directional edges.
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
 * Extracts lightweight structural stubs from the all-objects query result.
 * This forms the foundational cross-schema catalog for reference classification.
 *
 * @param result - The raw all-objects query execution result.
 * @returns An array of strictly identified `ExtractedObject` entities without detailed metadata.
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
