import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import {
  DacpacModel,
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
  buildColumnDef,
} from './types';
import { buildModel, parseName, normalizeName } from './modelBuilder';
import { stripBrackets } from '../utils/sql';

// ─── Public API ─────────────────────────────────────────────────────────────

export async function extractDacpac(buffer: ArrayBuffer): Promise<DacpacModel> {
  const xml = await extractModelXml(buffer);
  const elements = parseElements(xml);

  const objects = extractObjects(elements);
  const deps = extractDependencies(elements);
  const model = buildModel(objects, deps);

  // Override warnings for dacpac-specific messages
  const warnings: string[] = [];
  if (elements.length === 0) {
    warnings.push('This dacpac appears to be empty.');
  } else if (model.nodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found in this file.');
  }

  return { ...model, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Phase 1: Lightweight schema preview — counts schemas + types without extracting
 * body scripts, columns, or dependencies. Returns parsed elements for Phase 2 reuse.
 */
export async function extractSchemaPreview(buffer: ArrayBuffer): Promise<{
  preview: SchemaPreview;
  elements: XmlElement[];
}> {
  const xml = await extractModelXml(buffer);
  const elements = parseElements(xml);
  const preview = computeSchemaPreviewFromElements(elements);
  return { preview, elements };
}

/**
 * Phase 2: Full extraction filtered to selected schemas only.
 * Uses pre-parsed elements from Phase 1 to avoid re-unzipping and re-parsing XML.
 * Skips body script extraction and regex parsing for unselected schemas.
 */
export function extractDacpacFiltered(
  elements: XmlElement[],
  selectedSchemas: Set<string>,
): DacpacModel {
  // Pre-filter elements by schema (uppercased for consistent matching)
  const upperSchemas = new Set(Array.from(selectedSchemas).map(s => s.toUpperCase()));
  const filtered = elements.filter(el => {
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(el['@_Type'])) return false;
    const { schema } = parseName(name);
    return upperSchemas.has(schema);
  });

  const objects = extractObjects(filtered);
  const deps = extractDependencies(filtered);
  const model = buildModel(objects, deps);

  const warnings: string[] = [];
  if (model.nodes.length === 0) {
    warnings.push('No tables, views, or stored procedures found for selected schemas.');
  }
  return { ...model, warnings: warnings.length > 0 ? warnings : undefined };
}

function computeSchemaPreviewFromElements(elements: XmlElement[]): SchemaPreview {
  const schemaMap = new Map<string, SchemaInfo>();
  const seen = new Set<string>();
  let totalObjects = 0;

  for (const el of elements) {
    const type = el['@_Type'];
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;

    // Deduplicate by normalized ID (same as extractObjects)
    const id = normalizeName(name);
    if (seen.has(id)) continue;
    seen.add(id);

    const { schema } = parseName(name);
    const objType = ELEMENT_TYPE_MAP[type];

    let info = schemaMap.get(schema);
    if (!info) {
      info = { name: schema, nodeCount: 0, types: { table: 0, view: 0, procedure: 0, function: 0 } };
      schemaMap.set(schema, info);
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

export function filterBySchemas(
  model: DacpacModel,
  selectedSchemas: Set<string>,
  maxNodes = 150
): DacpacModel {
  const filtered = model.nodes.filter((n) => selectedSchemas.has(n.schema));
  const limited = filtered.slice(0, maxNodes);
  const nodeIds = new Set(limited.map((n) => n.id));

  const edges = model.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  );

  return {
    nodes: limited,
    edges,
    schemas: model.schemas.filter((s) => selectedSchemas.has(s.name)),
    parseStats: model.parseStats,
    warnings: model.warnings,
  };
}

// ─── ZIP + XML ──────────────────────────────────────────────────────────────

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

function parseElements(xml: string): XmlElement[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'Element' || name === 'Entry' || name === 'Property' || name === 'Relationship' || name === 'Annotation',
    parseTagValue: true,
    trimValues: true,
    processEntities: false, // dacpac model.xml never uses XML entities — disable to prevent entity expansion DoS
  });

  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('Failed to parse model.xml — the file may be corrupted');
  }
  const model = doc?.DataSchemaModel?.Model;
  if (!model) throw new Error('Invalid model.xml: missing DataSchemaModel/Model');

  return asArray(model.Element);
}

// ─── Extract: XML → Intermediate Format ─────────────────────────────────────

function extractObjects(elements: XmlElement[]): ExtractedObject[] {
  const objects: ExtractedObject[] = [];
  const seen = new Set<string>();

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

    // For tables without bodyScript: extract column metadata
    let columns: ColumnDef[] | undefined;
    if (!bodyScript && type === 'SqlTable') {
      columns = extractColumnsFromXml(el);
    }

    objects.push({ fullName: name, type: objType, bodyScript, columns });
  }

  return objects;
}

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

// ─── XML Column Extraction ──────────────────────────────────────────────────

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

        // Resolve type from TypeSpecifier relationship
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

// ─── XML Body Dependencies ──────────────────────────────────────────────────

function extractBodyDependencies(el: XmlElement): string[] {
  const deps: string[] = [];
  const rels = asArray(el.Relationship);

  for (const rel of rels) {
    if (rel['@_Name'] !== 'BodyDependencies' && rel['@_Name'] !== 'QueryDependencies') continue;
    const entries = asArray(rel.Entry);
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
  return deps;
}

// ─── XML Body Script Extraction ─────────────────────────────────────────────

function getBodyScript(el: XmlElement, type: string, schema: string, objectName: string): string | undefined {
  // Check for HeaderContents in SysCommentsObjectAnnotation (complete CREATE statement)
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

  // No HeaderContents found — synthesize a CREATE header from metadata
  const bodyScript = getDirectBodyScript(el, type);
  if (!bodyScript) return undefined;

  const keyword = getSqlKeyword(type);
  if (keyword) {
    return `CREATE ${keyword} [${schema}].[${objectName}]\nAS\n${bodyScript}`;
  }
  return bodyScript;
}

function getSqlKeyword(type: string): string | undefined {
  if (type === 'SqlProcedure') return 'PROCEDURE';
  if (type === 'SqlView') return 'VIEW';
  if (type.includes('Function')) return 'FUNCTION';
  return undefined;
}

function getDirectBodyScript(el: XmlElement, type: string): string | undefined {
  const props = asArray(el.Property);
  for (const prop of props) {
    const pName = prop['@_Name'];
    if (pName === 'BodyScript' || pName === 'QueryScript') {
      return extractPropertyValue(prop);
    }
  }

  // Nested in FunctionBody > SqlScriptFunctionImplementation (SqlScalarFunction)
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

function extractPropertyValue(prop: XmlProperty): string | undefined {
  let val: string | undefined;
  if (prop['@_Value']) val = prop['@_Value'];
  else if (typeof prop.Value === 'string') val = prop.Value;
  else if (prop.Value && typeof prop.Value === 'object' && '#text' in prop.Value) {
    val = prop.Value['#text'];
  }
  if (val) {
    // Decode XML numeric character references that may not be resolved by the parser
    // Validate code point range (0–0x10FFFF) to prevent RangeError DoS
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

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Check if ref is object-level (2 parts) not column-level (3+ parts) */
function isObjectLevelRef(name: string): boolean {
  const parts = stripBrackets(name).split('.');
  return parts.length === 2 && !parts[1].startsWith('@');
}

function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

// ─── Exclusion Patterns ─────────────────────────────────────────────────────

export function applyExclusionPatterns(model: DacpacModel, patterns: string[], onWarning?: (msg: string) => void): DacpacModel {
  if (!patterns || patterns.length === 0) return model;

  const regexes = patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
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

  // Tag spDetails with which neighbors were removed by exclusion
  const excludedIds = new Set(excludedNodes.map((n) => n.id));
  const excludedNameById = new Map(excludedNodes.map((n) => [n.id, `${n.schema}.${n.name}`]));
  let parseStats = model.parseStats;
  if (parseStats && excludedIds.size > 0) {
    const allEdges = model.edges;
    parseStats = {
      ...parseStats,
      spDetails: parseStats.spDetails.map((sp) => {
        const spId = nodes.find(n => `${n.schema}.${n.name}`.toLowerCase() === sp.name.toLowerCase())?.id
          ?? excludedNodes.find(n => `${n.schema}.${n.name}`.toLowerCase() === sp.name.toLowerCase())?.id;
        if (!spId) return sp;
        const lost = allEdges
          .filter((e) => (e.source === spId && excludedIds.has(e.target)) || (e.target === spId && excludedIds.has(e.source)))
          .map((e) => excludedNameById.get(e.source === spId ? e.target : e.source)!)
          .filter(Boolean);
        return lost.length > 0 ? { ...sp, excluded: lost } : sp;
      }),
    };
  }

  return { ...model, nodes, edges, parseStats };
}
