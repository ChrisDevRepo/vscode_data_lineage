/**
 * @module DacpacExtractor
 * Orchestrates the extraction of database metadata and lineage from SQL Server .dacpac files.
 *
 * This module provides a high-performance, two-phase extraction pipeline:
 * 1. **Phase 1 (Lightweight):** Quickly parses the `model.xml` to build a schema preview and object catalog.
 * 2. **Phase 2 (Full):** Performs deep extraction of columns, DDL, and dependencies, optionally filtered by schema.
 *
 * Key features:
 * - Direct parsing of the dacpac ZIP structure using `jszip`.
 * - Fast XML processing of `model.xml` via `fast-xml-parser`.
 * - Reconstruction of object-level dependencies and column-level metadata.
 * - Mapping of DAC Data Schema Providers to human-readable platform names.
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import {
  DatabaseModel,
  ObjectType,
  SchemaInfo,
  SchemaPreview,
  ELEMENT_TYPE_MAP,
  TRACKED_ELEMENT_TYPES,
  XmlElement,
  XmlProperty,
  XmlRelationship,
  XmlEntry,
  XmlReference,
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
import { buildModel, parseName, normalizeName } from './modelBuilder';
import { stripBrackets, schemaKey, compileExclusionPattern } from '../utils/sql';

/**
 * Extracts a complete DatabaseModel from a .dacpac file buffer.
 * Performs a full, unfiltered extraction of all tracked objects.
 *
 * @param buffer - The raw ArrayBuffer of the .dacpac file.
 * @returns A Promise resolving to the extracted DatabaseModel.
 * @throws {Error} If the buffer is not a valid ZIP archive, or if `model.xml` is missing or corrupted.
 */
export async function extractDacpac(buffer: ArrayBuffer): Promise<DatabaseModel> {
  const xml = await extractModelXml(buffer);
  const { elements, dspName } = parseElements(xml);
  const dbPlatform = parseDspPlatform(dspName);

  const objects = extractObjects(elements);
  const allObjects = extractObjectsLightweight(elements);
  const deps = extractDependencies(elements);
  const model = buildModel(objects, deps, allObjects);

  const warnings: string[] = [];
  if (elements.length === 0) {
    warnings.push('This dacpac appears to be empty.');
  } else if (model.nodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found in this file.');
  }

  return {
    ...model,
    warnings: warnings.length > 0 ? warnings : undefined,
    dbPlatform: dbPlatform || undefined,
  };
}

/**
 * Extracts a lightweight preview of the database schemas from a .dacpac file buffer.
 * This Phase 1 extraction counts schemas and object types without parsing body scripts,
 * columns, or deep dependencies.
 *
 * @param buffer - The raw ArrayBuffer of the .dacpac file.
 * @returns A Promise resolving to the schema preview and the pre-parsed XML elements for Phase 2.
 */
export async function extractSchemaPreview(buffer: ArrayBuffer): Promise<{
  preview: SchemaPreview;
  elements: XmlElement[];
  dspName: string;
}> {
  const xml = await extractModelXml(buffer);
  const { elements, dspName } = parseElements(xml);
  const preview = computeSchemaPreviewFromElements(elements);
  return { preview, elements, dspName };
}

/**
 * Performs a Phase 2 full extraction filtered to a specific set of schemas.
 * Uses pre-parsed XML elements from Phase 1 to significantly improve performance.
 *
 * @param elements - The array of pre-parsed XML elements from Phase 1.
 * @param selectedSchemas - A Set of schema names to include (case-insensitive).
 * @param dspName - Optional Data Schema Provider (DSP) name.
 * @returns The resulting DatabaseModel containing only the filtered objects.
 */
export function extractDacpacFiltered(
  elements: XmlElement[],
  selectedSchemas: Set<string>,
  dspName?: string,
): DatabaseModel {
  const lowerSchemas = new Set(Array.from(selectedSchemas).map(s => s.toLowerCase()));
  const filtered = elements.filter(el => {
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(el['@_Type'])) return false;
    const { schema } = parseName(name);
    return lowerSchemas.has(schema.toLowerCase());
  });

  const allObjects = extractObjectsLightweight(elements);
  const objects = extractObjects(filtered, elements);
  const deps = extractDependencies(filtered);
  const model = buildModel(objects, deps, allObjects);
  const dbPlatform = dspName ? parseDspPlatform(dspName) : undefined;

  const warnings: string[] = [];
  if (model.nodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found for selected schemas.');
  }
  return {
    ...model,
    warnings: warnings.length > 0 ? warnings : undefined,
    dbPlatform: dbPlatform || undefined,
  };
}

/**
 * Internal logic to compute schema-level statistics from parsed XML elements.
 */
function computeSchemaPreviewFromElements(elements: XmlElement[]): SchemaPreview {
  const schemaMap = new Map<string, SchemaInfo>();
  const seen = new Set<string>();
  let totalObjects = 0;

  for (const el of elements) {
    const type = el['@_Type'];
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;

    const id = normalizeName(name);
    if (seen.has(id)) continue;
    seen.add(id);

    const { schema } = parseName(name);
    const objType = ELEMENT_TYPE_MAP[type];

    const key = schemaKey(schema);
    let info = schemaMap.get(key);
    if (!info) {
      info = createEmptySchemaInfo(schema);
      schemaMap.set(key, info);
    }
    info.nodeCount++;
    info.types[objType]++;
    totalObjects++;
  }

  const schemas = Array.from(schemaMap.values()).sort((a, b) => b.nodeCount - a.nodeCount);
  const warnings: string[] = [];
  if (elements.length === 0) {
    warnings.push('This dacpac appears to be empty.');
  } else if (totalObjects === 0) {
    warnings.push('No tables, views, or stored procedures found in this file.');
  }

  return { schemas, totalObjects, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Filters an existing DatabaseModel in memory to include only objects from specific schemas.
 *
 * @param model - The DatabaseModel to filter.
 * @param selectedSchemas - Set of schema names to retain.
 * @param maxNodes - Maximum number of nodes to return.
 * @returns A new DatabaseModel instance containing the filtered subset.
 */
export function filterBySchemas(
  model: DatabaseModel,
  selectedSchemas: Set<string>,
  maxNodes = DEFAULT_CONFIG.maxNodes
): DatabaseModel {
  const lowerSelected = new Set(Array.from(selectedSchemas).map(s => s.toLowerCase()));
  const schemaNodes = model.nodes.filter((n) => lowerSelected.has(n.schema.toLowerCase()));
  const schemaNodeIds = new Set(schemaNodes.map(n => n.id));
  
  const connectedVirtualIds = new Set<string>();
  for (const e of model.edges) {
    if (schemaNodeIds.has(e.target)) connectedVirtualIds.add(e.source);
    if (schemaNodeIds.has(e.source)) connectedVirtualIds.add(e.target);
  }
  const virtualNodes = model.nodes.filter((n) =>
    (n.externalType === 'file' || n.externalType === 'db') && connectedVirtualIds.has(n.id)
  );
  const filtered = [...schemaNodes, ...virtualNodes];
  const limited = filtered.slice(0, maxNodes);
  const nodeIds = new Set(limited.map((n) => n.id));

  const edges = model.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  );

  return {
    nodes: limited,
    edges,
    schemas: model.schemas.filter((s) => lowerSelected.has(s.name.toLowerCase())),
    catalog: model.catalog,
    neighborIndex: model.neighborIndex,
    parseStats: model.parseStats,
    warnings: model.warnings,
  };
}

/**
 * Extracts a lightweight catalog of all tracked objects from XML elements.
 */
function extractObjectsLightweight(elements: XmlElement[]): ExtractedObject[] {
  const seen = new Set<string>();
  const objects: ExtractedObject[] = [];
  for (const el of elements) {
    const type = el['@_Type'];
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;
    const id = normalizeName(name);
    if (seen.has(id)) continue;
    seen.add(id);
    objects.push({ fullName: name, type: ELEMENT_TYPE_MAP[type] });
  }
  return objects;
}

/**
 * Loads the dacpac buffer into JSZip and retrieves the `model.xml` content.
 */
async function extractModelXml(buffer: ArrayBuffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('end of central directory') || msg.includes('is this a zip file'))
      throw new Error('Not a valid .dacpac file (invalid ZIP archive)');
    if (msg.includes('End of data reached') || msg.includes('Corrupted zip'))
      throw new Error('File appears to be corrupted or truncated');
    throw new Error(`Invalid .dacpac file: ${msg || 'unknown error'}`);
  }
  const modelFile = zip.file('model.xml');
  if (!modelFile) throw new Error('model.xml not found in .dacpac');
  return modelFile.async('string');
}

/**
 * Parses the raw XML string into a structured object using `fast-xml-parser`.
 */
function parseElements(xml: string): { elements: XmlElement[]; dspName: string } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'Element' || name === 'Entry' || name === 'Property' || name === 'Relationship' || name === 'Annotation',
    parseTagValue: true,
    trimValues: true,
    processEntities: false,
  });

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('Failed to parse model.xml — the file may be corrupted');
  }
  const model = doc?.DataSchemaModel?.Model;
  if (!model) throw new Error('Invalid model.xml: missing DataSchemaModel/Model');

  return { elements: asArray(model.Element), dspName: doc.DataSchemaModel?.['@_DspName'] ?? '' };
}

/**
 * Maps the DspName attribute from a dacpac's DataSchemaModel element to a human-readable platform string.
 *
 * @param dsp - The Data Schema Provider name string (e.g., 'Sql160DatabaseSchemaProvider').
 * @returns A user-friendly database platform name, or the raw provider string if unrecognized.
 */
export function parseDspPlatform(dsp: string): string {
  if (!dsp) return '';
  if (dsp.includes('SqlDwUnified'))       return 'Fabric Data Warehouse';
  if (dsp.includes('SqlDbFabric'))        return 'SQL Database in Fabric';
  if (dsp.includes('SqlDwDatabase'))      return 'Synapse Dedicated Pool';
  if (dsp.includes('SqlManagedInstance')) return 'Azure SQL Managed Instance';
  if (dsp.includes('SqlHyperscale'))      return 'Azure SQL Hyperscale';
  if (dsp.includes('SqlAzureV12'))        return 'Azure SQL Database';

  const verMap: [string, string][] = [
    ['Sql170', 'SQL Server 2025'], ['Sql160', 'SQL Server 2022'],
    ['Sql150', 'SQL Server 2019'], ['Sql140', 'SQL Server 2017'],
    ['Sql130', 'SQL Server 2016'], ['Sql120', 'SQL Server 2014'],
    ['Sql110', 'SQL Server 2012'], ['Sql100', 'SQL Server 2008'],
    ['Sql90',  'SQL Server 2005'], ['Sql80',  'SQL Server 2000'],
  ];
  for (const [key, label] of verMap) if (dsp.includes(key)) return label;
  
  const m = dsp.match(/\.(\w+?)DatabaseSchemaProvider$/);
  return m ? m[1] : dsp;
}

/**
 * Extracts deep metadata (DDL, columns, constraints) for tracked objects.
 */
function extractObjects(elements: XmlElement[], constraintElements?: XmlElement[]): ExtractedObject[] {
  const objects: ExtractedObject[] = [];
  const seen = new Set<string>();
  const constraintMaps = extractConstraintMaps(constraintElements ?? elements);

  for (const el of elements) {
    const type = el['@_Type'];
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;

    const id = normalizeName(name);
    if (seen.has(id)) continue;
    seen.add(id);

    const objType = ELEMENT_TYPE_MAP[type];
    const { schema, objectName } = parseName(name);
    const bodyScript = getBodyScript(el, type, schema, objectName);

    const COLUMN_BEARING_DACPAC_TYPES = new Set([
      'SqlTable', 'SqlExternalTable', 'SqlView',
      'SqlInlineTableValuedFunction', 'SqlMultiStatementTableValuedFunction',
    ]);
    let columns: ColumnDef[] | undefined;
    let fks: ForeignKeyInfo[] | undefined;
    if (COLUMN_BEARING_DACPAC_TYPES.has(type)) {
      columns = extractColumnsFromXml(el);
      if (columns && (type === 'SqlTable' || type === 'SqlExternalTable')) {
        fks = enrichColumnsWithConstraints(columns, normalizeName(name), constraintMaps);
      }
    }

    objects.push({
      fullName: name,
      type: objType,
      bodyScript,
      columns,
      fks,
      ...(type === 'SqlExternalTable' && { externalType: 'et' as const }),
    });
  }

  return objects;
}

/**
 * Extracts object-level dependencies between XML elements.
 */
function extractDependencies(elements: XmlElement[]): ExtractedDependency[] {
  const deps: ExtractedDependency[] = [];

  for (const el of elements) {
    const name = el['@_Name'];
    const type = el['@_Type'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;

    const bodyDeps = extractBodyDependencies(el);
    for (const dep of bodyDeps) {
      deps.push({ sourceName: name, targetName: dep });
    }
  }

  return deps;
}

/**
 * Extracts column definitions for tables, views, and functions from the XML model.
 */
function extractColumnsFromXml(el: XmlElement): ColumnDef[] {
  const cols: ColumnDef[] = [];
  const rels = asArray(el.Relationship);

  for (const rel of rels) {
    if (rel['@_Name'] !== 'Columns') continue;
    for (const entry of asArray(rel.Entry)) {
      for (const colEl of asArray(entry.Element)) {
        const colName = stripBrackets((colEl['@_Name'] ?? '').split('.').pop() ?? '');
        const props = asArray(colEl.Property);
        const isNullable = props.find(p => p['@_Name'] === 'IsNullable')?.['@_Value'] !== 'False';
        const isIdentity = props.find(p => p['@_Name'] === 'IsIdentity')?.['@_Value'] === 'True';
        const isComputed = colEl['@_Type'] === 'SqlComputedColumn';

        let typeName = '?';
        let length: string | undefined;
        let precision: string | undefined;
        let scale: string | undefined;

        if (!isComputed) {
          for (const colRel of asArray(colEl.Relationship)) {
            if (colRel['@_Name'] !== 'TypeSpecifier') continue;
            for (const tsEntry of asArray(colRel.Entry)) {
              for (const tsEl of asArray(tsEntry.Element)) {
                const tsProps = asArray(tsEl.Property);
                length = tsProps.find(p => p['@_Name'] === 'Length')?.['@_Value'];
                precision = tsProps.find(p => p['@_Name'] === 'Precision')?.['@_Value'];
                scale = tsProps.find(p => p['@_Name'] === 'Scale')?.['@_Value'];
                for (const typeRel of asArray(tsEl.Relationship)) {
                  if (typeRel['@_Name'] !== 'Type') continue;
                  for (const typeEntry of asArray(typeRel.Entry)) {
                    for (const ref of asArray(typeEntry.References as XmlReference | XmlReference[] | undefined)) {
                      typeName = ref['@_Name'] ? stripBrackets(ref['@_Name']) : '?';
                    }
                  }
                }
              }
            }
          }
        }

        cols.push(buildColumnDef(colName, typeName, isNullable, isIdentity, isComputed, length, precision, scale));
      }
    }
  }

  return cols;
}

/**
 * Utility to extract `@_Name` values from a specific Relationship.
 */
function getRelRefs(el: XmlElement, relName: string): string[] {
  const rel = asArray(el.Relationship).find(r => r['@_Name'] === relName);
  if (!rel) return [];
  return asArray(rel.Entry).flatMap(e =>
    asArray(e.References as XmlReference | XmlReference[] | undefined).map(r => r['@_Name'] ?? '').filter(Boolean)
  );
}

/**
 * Mapping of SQL Server Foreign Key delete actions from numeric IDs to strings.
 */
const FK_DELETE_ACTION: Record<string, string> = { '1': 'CASCADE', '2': 'SET NULL', '3': 'SET DEFAULT' };

/**
 * Extracts comprehensive constraint metadata (UQ, CK, FK, PK) for the entire model.
 */
function extractConstraintMaps(elements: XmlElement[]): ConstraintMaps {
  const uqColMap      = new Map<string, string>();
  const ckColMap      = new Map<string, string>();
  const fkMap         = new Map<string, ForeignKeyInfo[]>();
  const pkOrdinalMap  = new Map<string, number>();

  for (const el of elements) {
    const type = el['@_Type'];

    if (type === 'SqlUniqueConstraint') {
      const tableRef = getRelRefs(el, 'DefiningTable')[0];
      if (!tableRef) continue;
      const tableKey = normalizeName(tableRef);
      const ann = asArray(el.Annotation).find(a => a['@_Type'] === 'SqlInlineConstraintAnnotation');
      const constraintName = ann ? parseName(ann['@_Name'] ?? '').objectName : 'UQ';
      const colSpecRel = asArray(el.Relationship).find(r => r['@_Name'] === 'ColumnSpecifications');
      for (const entry of asArray(colSpecRel?.Entry)) {
        for (const specEl of asArray(entry.Element)) {
          const colRef = getRelRefs(specEl as XmlElement, 'Column')[0];
          if (!colRef) continue;
          const colName = stripBrackets(colRef.split('.').pop() ?? '');
          uqColMap.set(`${tableKey}.${colName.toLowerCase()}`, constraintName);
        }
      }

    } else if (type === 'SqlCheckConstraint') {
      const tableRef = getRelRefs(el, 'DefiningTable')[0];
      if (!tableRef) continue;
      const tableKey = normalizeName(tableRef);
      const constraintName = parseName(el['@_Name'] ?? '').objectName;
      if (!constraintName) continue;
      const ckColRefs = getRelRefs(el, 'CheckExpressionDependencies');
      if (ckColRefs.length === 1) {
        const colName = stripBrackets(ckColRefs[0].split('.').pop() ?? '');
        if (colName) ckColMap.set(`${tableKey}.${colName.toLowerCase()}`, constraintName);
      }

    } else if (type === 'SqlForeignKeyConstraint') {
      const tableRef = getRelRefs(el, 'DefiningTable')[0];
      if (!tableRef) continue;
      const tableKey = normalizeName(tableRef);
      const constraintName = parseName(el['@_Name'] ?? '').objectName;
      if (!constraintName) continue;
      const foreignTableRef = getRelRefs(el, 'ForeignTable')[0];
      if (!foreignTableRef) continue;
      const { schema: refSchema, objectName: refTable } = parseName(foreignTableRef);
      const parentCols  = getRelRefs(el, 'Columns').map(r => stripBrackets(r.split('.').pop() ?? '')).filter(Boolean);
      const refColsList = getRelRefs(el, 'ForeignColumns').map(r => stripBrackets(r.split('.').pop() ?? '')).filter(Boolean);
      if (parentCols.length === 0 || parentCols.length !== refColsList.length) continue;
      const deleteVal = asArray(el.Property).find(p => p['@_Name'] === 'DeleteAction')?.['@_Value'] ?? '';
      const onDelete = FK_DELETE_ACTION[deleteVal] ?? 'NO ACTION';
      const list = fkMap.get(tableKey) ?? [];
      list.push({ name: constraintName, columns: parentCols, refSchema, refTable, refColumns: refColsList, onDelete });
      fkMap.set(tableKey, list);

    } else if (type === 'SqlPrimaryKeyConstraint') {
      const tableRef = getRelRefs(el, 'DefiningTable')[0];
      if (!tableRef) continue;
      const tableKey = normalizeName(tableRef);
      const colSpecRel = asArray(el.Relationship).find(r => r['@_Name'] === 'ColumnSpecifications');
      let ordinal = 1;
      for (const entry of asArray(colSpecRel?.Entry)) {
        for (const specEl of asArray(entry.Element)) {
          const colRef = getRelRefs(specEl as XmlElement, 'Column')[0];
          if (!colRef) continue;
          const colName = stripBrackets(colRef.split('.').pop() ?? '');
          if (colName) pkOrdinalMap.set(`${tableKey}.${colName.toLowerCase()}`, ordinal++);
        }
      }
    }
  }

  return { uqColMap, ckColMap, fkMap, pkOrdinalMap };
}

/**
 * Relationship types that indicate object-to-object dependencies in dacpac XML.
 */
const DEPENDENCY_RELATIONSHIPS = new Set([
  'BodyDependencies',
  'QueryDependencies',
  'ExpressionDependencies',
  'CheckExpressionDependencies',
]);

/**
 * Extracts dependencies from an element's script or body.
 */
function extractBodyDependencies(el: XmlElement): string[] {
  const deps: string[] = [];
  collectDeps(el, deps);
  return deps;
}

/**
 * Recursively collects object-level dependency references from XML relationships.
 */
function collectDeps(el: XmlElement, deps: string[]): void {
  const rels = asArray(el.Relationship);
  for (const rel of rels) {
    const entries = asArray(rel.Entry);
    if (DEPENDENCY_RELATIONSHIPS.has(rel['@_Name'])) {
      for (const entry of entries) {
        const refs = asArray(entry.References as XmlReference | XmlReference[] | undefined);
        for (const ref of refs) {
          if (ref['@_ExternalSource']) continue;
          const refName = ref['@_Name'];
          if (!refName) continue;
          if (isObjectLevelRef(refName)) {
            deps.push(refName);
          }
        }
      }
    }
    for (const entry of entries) {
      for (const child of asArray(entry.Element as XmlElement | XmlElement[] | undefined)) {
        collectDeps(child, deps);
      }
    }
  }
}

/**
 * Retrieves the full SQL body script for an element, synthesizing a header if necessary.
 */
function getBodyScript(el: XmlElement, type: string, schema: string, objectName: string): string | undefined {
  const annotations = asArray(el.Annotation);
  for (const ann of annotations) {
    if (ann['@_Type'] === 'SysCommentsObjectAnnotation') {
      const annProps = asArray(ann.Property);
      for (const prop of annProps) {
        if (prop['@_Name'] === 'HeaderContents') {
          const header = extractPropertyValue(prop);
          const bodyScript = getDirectBodyScript(el, type);
          if (header && bodyScript) {
            return `${header}\n${bodyScript}`;
          }
        }
      }
    }
  }

  const bodyScript = getDirectBodyScript(el, type);
  if (!bodyScript) return undefined;

  const keyword = getSqlKeyword(type);
  if (keyword) {
    return `CREATE ${keyword} [${schema}].[${objectName}]\nAS\n${bodyScript}`;
  }
  return bodyScript;
}

/**
 * Maps a dacpac element type to its SQL keyword equivalent.
 */
function getSqlKeyword(type: string): string | undefined {
  if (type === 'SqlProcedure') return 'PROCEDURE';
  if (type === 'SqlView') return 'VIEW';
  if (type.includes('Function')) return 'FUNCTION';
  return undefined;
}

/**
 * Extracts the raw script content from dacpac properties or function body elements.
 */
function getDirectBodyScript(el: XmlElement, type: string): string | undefined {
  const props = asArray(el.Property);
  for (const prop of props) {
    const pName = prop['@_Name'];
    if (pName === 'BodyScript' || pName === 'QueryScript') {
      return extractPropertyValue(prop);
    }
  }

  if (type.includes('Function')) {
    const rels = asArray(el.Relationship);
    for (const rel of rels) {
      if (rel['@_Name'] === 'FunctionBody') {
        const entries = asArray(rel.Entry);
        for (const entry of entries) {
          const innerEls = asArray(entry.Element);
          for (const inner of innerEls) {
            const innerProps = asArray(inner.Property);
            for (const p of innerProps) {
              if (p['@_Name'] === 'BodyScript') {
                return extractPropertyValue(p);
              }
            }
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Extracts and decodes a property value, handling XML character references.
 */
function extractPropertyValue(prop: XmlProperty): string | undefined {
  let val: string | undefined;
  if (prop['@_Value']) val = prop['@_Value'];
  else if (typeof prop.Value === 'string') val = prop.Value;
  else if (prop.Value && typeof prop.Value === 'object' && '#text' in prop.Value) {
    val = (prop.Value as any)['#text'];
  }
  if (val) {
    val = val.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\uFFFD';
    });
    val = val.replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\uFFFD';
    });
  }
  return val;
}

/**
 * Checks if a reference is object-level (schema.object) rather than column-level.
 */
function isObjectLevelRef(name: string): boolean {
  const parts = stripBrackets(name).split('.');
  return parts.length === 2 && !parts[1].startsWith('@');
}

/**
 * Ensures the provided value is treated as an array.
 */
function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Removes nodes from a DatabaseModel that match specified exclusion patterns.
 *
 * @param model - The DatabaseModel to filter.
 * @param patterns - Array of regex pattern strings.
 * @param onWarning - Callback for invalid regex patterns.
 * @returns A new DatabaseModel with matching nodes and edges removed.
 */
export function applyExclusionPatterns(model: DatabaseModel, patterns: string[], onWarning?: (msg: string) => void): DatabaseModel {
  if (!patterns || patterns.length === 0) return model;

  const regexes = patterns.map((p) => {
    try {
      return compileExclusionPattern(p);
    } catch (e) {
      onWarning?.(`Invalid exclude pattern "${p}": ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }).filter(Boolean) as RegExp[];

  if (regexes.length === 0) return model;

  const nodes = model.nodes.filter((n) => {
    const name = `${n.schema}.${n.name}`;
    return !regexes.some((r) => r.test(name) || r.test(n.fullName));
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const excludedNodes = model.nodes.filter((n) => !nodeIds.has(n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const excludedIds = new Set(excludedNodes.map((n) => n.id));
  const excludedNameById = new Map(excludedNodes.map((n) => [n.id, `${n.schema}.${n.name}`]));
  let parseStats = model.parseStats;
  if (parseStats && excludedIds.size > 0) {
    const allEdges = model.edges;

    const nameToIdMap = new Map<string, string>();
    for (const n of nodes) nameToIdMap.set(`${n.schema}.${n.name}`.toLowerCase(), n.id);
    for (const n of excludedNodes) {
      const key = `${n.schema}.${n.name}`.toLowerCase();
      if (!nameToIdMap.has(key)) nameToIdMap.set(key, n.id);
    }

    const adjacency = new Map<string, string[]>();
    for (const e of allEdges) {
      if (excludedIds.has(e.target)) {
        let arr = adjacency.get(e.source);
        if (!arr) { arr = []; adjacency.set(e.source, arr); }
        arr.push(e.target);
      }
      if (excludedIds.has(e.source)) {
        let arr = adjacency.get(e.target);
        if (!arr) { arr = []; adjacency.set(e.target, arr); }
        arr.push(e.source);
      }
    }

    parseStats = {
      ...parseStats,
      spDetails: parseStats.spDetails.map((sp) => {
        const spId = nameToIdMap.get(sp.name.toLowerCase());
        if (!spId) return sp;
        const neighbors = adjacency.get(spId);
        if (!neighbors) return sp;
        const lost = neighbors.map(id => excludedNameById.get(id)!).filter(Boolean);
        return lost.length > 0 ? { ...sp, excluded: lost } : sp;
      }),
    };
  }

  return { ...model, nodes, edges, parseStats };
}
