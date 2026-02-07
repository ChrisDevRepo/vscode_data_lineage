import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import {
  DacpacModel,
  LineageNode,
  LineageEdge,
  SchemaInfo,
  ObjectType,
  ParseStats,
  ELEMENT_TYPE_MAP,
  TRACKED_ELEMENT_TYPES,
  XmlElement,
  XmlProperty,
  XmlRelationship,
  XmlEntry,
  XmlReference,
} from './types';
import { parseSqlBody } from './sqlBodyParser';

// ─── Public API ─────────────────────────────────────────────────────────────

export async function extractDacpac(buffer: ArrayBuffer): Promise<DacpacModel> {
  const xml = await extractModelXml(buffer);
  const elements = parseElements(xml);
  const { nodes, edges, stats } = buildNodesAndEdges(elements);
  const schemas = computeSchemas(nodes);
  return { nodes, edges, schemas, parseStats: stats };
}

export function filterBySchemas(
  model: DacpacModel,
  selectedSchemas: Set<string>,
  maxNodes = 150
): DacpacModel {
  const filtered = model.nodes.filter((n) => selectedSchemas.has(n.schema));
  const limited = filtered.slice(0, maxNodes);
  const nodeIds = new Set(limited.map((n) => n.id));

  // Keep edges where both ends are in the filtered set
  const edges = model.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  );

  return {
    nodes: limited,
    edges,
    schemas: model.schemas.filter((s) => selectedSchemas.has(s.name)),
    parseStats: model.parseStats,
  };
}

// ─── ZIP + XML ──────────────────────────────────────────────────────────────

async function extractModelXml(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
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
  });

  const doc = parser.parse(xml);
  const model = doc?.DataSchemaModel?.Model;
  if (!model) throw new Error('Invalid model.xml: missing DataSchemaModel/Model');

  return asArray(model.Element);
}

// ─── Node & Edge Extraction ────────────────────────────────────────────────

function buildNodesAndEdges(elements: XmlElement[]): {
  nodes: LineageNode[];
  edges: LineageEdge[];
  stats: ParseStats;
} {
  const nodes: LineageNode[] = [];
  const nodeIds = new Set<string>();
  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();

  for (const el of elements) {
    const type = el['@_Type'];
    const name = el['@_Name'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;

    const objType = ELEMENT_TYPE_MAP[type];
    const { schema, objectName } = parseName(name);
    const id = normalizeName(name);

    if (nodeIds.has(id)) continue;
    nodeIds.add(id);

    const bodyScript = getBodyScript(el, type, schema, objectName);

    nodes.push({
      id,
      schema,
      name: objectName,
      fullName: name,
      type: objType,
      bodyScript,
    });
  }

  // Second pass: extract edges from BodyDependencies + SP body parsing
  const stats: ParseStats = { parsedRefs: 0, resolvedEdges: 0, droppedRefs: [], spDetails: [] };
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (const el of elements) {
    const name = el['@_Name'];
    const type = el['@_Type'];
    if (!name || !TRACKED_ELEMENT_TYPES.has(type)) continue;

    const sourceId = normalizeName(name);

    // 1. XML BodyDependencies
    // For regex-parsed SPs, defer XML deps so we can exclude targets/exec
    // (XML deps are all dep→SP which is wrong direction for writes and exec calls)
    const xmlDeps = extractBodyDependencies(el);
    const node = nodeMap.get(sourceId);
    const willRegexParse = node?.bodyScript && type === 'SqlProcedure';

    if (!willRegexParse) {
      for (const dep of xmlDeps) {
        const targetId = normalizeName(dep);
        if (targetId !== sourceId && nodeIds.has(targetId)) {
          addEdge(edges, edgeKeys, targetId, sourceId, 'body');
        }
      }
    }

    // 2. Regex-based body parsing for SPs only (views/UDFs use dacpac XML deps)
    if (willRegexParse) {
      const parsed = parseSqlBody(node.bodyScript!);
      let spIn = 0, spOut = 0;
      const spUnrelated: string[] = [];

      // Collect target/exec IDs so we can exclude them from XML deps
      const outboundIds = new Set<string>();
      for (const dep of parsed.targets) outboundIds.add(normalizeName(dep));
      for (const dep of parsed.execCalls) outboundIds.add(normalizeName(dep));

      // Add XML deps only for sources (exclude targets/exec to prevent reverse edges)
      for (const dep of xmlDeps) {
        const depId = normalizeName(dep);
        if (depId !== sourceId && nodeIds.has(depId) && !outboundIds.has(depId)) {
          addEdge(edges, edgeKeys, depId, sourceId, 'body');
        }
      }

      for (const dep of parsed.sources) {
        const depId = normalizeName(dep);
        stats.parsedRefs++;
        if (depId !== sourceId && nodeIds.has(depId)) {
          addEdge(edges, edgeKeys, depId, sourceId, 'body');
          stats.resolvedEdges++;
          spIn++;
        } else if (depId !== sourceId) {
          spUnrelated.push(dep);
          stats.droppedRefs.push(`${name} → ${dep}`);
        }
      }
      for (const dep of parsed.targets) {
        const depId = normalizeName(dep);
        stats.parsedRefs++;
        if (depId !== sourceId && nodeIds.has(depId)) {
          addEdge(edges, edgeKeys, sourceId, depId, 'body');
          stats.resolvedEdges++;
          spOut++;
        } else if (depId !== sourceId) {
          spUnrelated.push(dep);
          stats.droppedRefs.push(`${name} → ${dep}`);
        }
      }
      for (const dep of parsed.execCalls) {
        const depId = normalizeName(dep);
        stats.parsedRefs++;
        if (depId !== sourceId && nodeIds.has(depId)) {
          addEdge(edges, edgeKeys, sourceId, depId, 'exec');
          stats.resolvedEdges++;
          spOut++;
        } else if (depId !== sourceId) {
          spUnrelated.push(dep + ' (exec)');
          stats.droppedRefs.push(`${name} → ${dep} (exec)`);
        }
      }

      // Per-SP logging + stats
      const spLabel = `${node.schema}.${node.name}`;
      stats.spDetails.push({ name: spLabel, inCount: spIn, outCount: spOut, unrelated: spUnrelated });

    }
  }

  return { nodes, edges, stats };
}

// ─── XML Helpers ────────────────────────────────────────────────────────────

function extractBodyDependencies(el: XmlElement): string[] {
  const deps: string[] = [];
  const rels = asArray(el.Relationship);

  for (const rel of rels) {
    if (rel['@_Name'] !== 'BodyDependencies' && rel['@_Name'] !== 'QueryDependencies') continue;
    const entries = asArray(rel.Entry);
    for (const entry of entries) {
      const refs = asArray(entry.References as XmlReference | XmlReference[] | undefined);
      for (const ref of refs) {
        // Skip BuiltIns (system types like [varchar], [int])
        if (ref['@_ExternalSource']) continue;
        const refName = ref['@_Name'];
        if (!refName) continue;
        // Only keep schema.object level refs (2 parts), skip column refs (3+ parts)
        if (isObjectLevelRef(refName)) {
          deps.push(refName);
        }
      }
    }
  }
  return deps;
}

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
  if (!bodyScript) {
    // For tables: build a design view from column metadata
    if (type === 'SqlTable') return buildTableDesign(el, schema, objectName);
    return undefined;
  }

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

/** Build a formatted table design view from dacpac column metadata */
function buildTableDesign(el: XmlElement, schema: string, objectName: string): string {
  const cols: { name: string; type: string; nullable: string; extra: string }[] = [];
  const rels = asArray(el.Relationship);

  for (const rel of rels) {
    if (rel['@_Name'] !== 'Columns') continue;
    for (const entry of asArray(rel.Entry)) {
      for (const colEl of asArray(entry.Element)) {
        const colName = (colEl['@_Name'] ?? '').split('.').pop()?.replace(/\[|\]/g, '') ?? '';
        const props = asArray(colEl.Property);
        const isNullable = props.find(p => p['@_Name'] === 'IsNullable')?.['@_Value'] !== 'False';
        const isIdentity = props.find(p => p['@_Name'] === 'IsIdentity')?.['@_Value'] === 'True';
        const isComputed = colEl['@_Type'] === 'SqlComputedColumn';

        // Computed columns have no stored type
        if (isComputed) {
          cols.push({
            name: colName,
            type: '(computed)',
            nullable: isNullable ? 'NULL' : 'NOT NULL',
            extra: 'COMPUTED',
          });
          continue;
        }

        // Resolve type from TypeSpecifier relationship
        let typeName = '?';
        for (const colRel of asArray(colEl.Relationship)) {
          if (colRel['@_Name'] !== 'TypeSpecifier') continue;
          for (const tsEntry of asArray(colRel.Entry)) {
            for (const tsEl of asArray(tsEntry.Element)) {
              // Get length/precision/scale
              const tsProps = asArray(tsEl.Property);
              const length = tsProps.find(p => p['@_Name'] === 'Length')?.['@_Value'];
              const precision = tsProps.find(p => p['@_Name'] === 'Precision')?.['@_Value'];
              const scale = tsProps.find(p => p['@_Name'] === 'Scale')?.['@_Value'];
              // Get base type name from nested Type relationship
              for (const typeRel of asArray(tsEl.Relationship)) {
                if (typeRel['@_Name'] !== 'Type') continue;
                for (const typeEntry of asArray(typeRel.Entry)) {
                  for (const ref of asArray(typeEntry.References as XmlReference | XmlReference[] | undefined)) {
                    const raw = ref['@_Name']?.replace(/\[|\]/g, '') ?? '?';
                    typeName = raw;
                    if (length) typeName += `(${length === '-1' ? 'max' : length})`;
                    else if (precision && scale) typeName += `(${precision},${scale})`;
                    else if (precision) typeName += `(${precision})`;
                  }
                }
              }
            }
          }
        }

        cols.push({
          name: colName,
          type: typeName,
          nullable: isNullable ? 'NULL' : 'NOT NULL',
          extra: isIdentity ? 'IDENTITY' : isComputed ? 'COMPUTED' : '',
        });
      }
    }
  }

  if (cols.length === 0) return `-- No column metadata for [${schema}].[${objectName}]`;

  // Build ASCII table
  const hasExtra = cols.some(c => c.extra);
  const hCol = 'Column', hType = 'Type', hNull = 'Nullable', hExtra = '';
  const wName = Math.max(hCol.length, ...cols.map(c => c.name.length));
  const wType = Math.max(hType.length, ...cols.map(c => c.type.length));
  const wNull = Math.max(hNull.length, ...cols.map(c => c.nullable.length));
  const wExtra = hasExtra ? Math.max(hExtra.length, ...cols.map(c => c.extra.length)) : 0;

  const sep = (f: string) => {
    let s = `-- +${f.repeat(wName + 2)}+${f.repeat(wType + 2)}+${f.repeat(wNull + 2)}+`;
    if (hasExtra) s += `${f.repeat(wExtra + 2)}+`;
    return s;
  };
  const row = (n: string, t: string, nu: string, ex: string) => {
    let s = `-- | ${n.padEnd(wName)} | ${t.padEnd(wType)} | ${nu.padEnd(wNull)} |`;
    if (hasExtra) s += ` ${ex.padEnd(wExtra)} |`;
    return s;
  };

  const out: string[] = [];
  out.push(`-- TABLE: [${schema}].[${objectName}]`);
  out.push(sep('-'));
  out.push(row(hCol, hType, hNull, hExtra));
  out.push(sep('-'));
  for (const c of cols) out.push(row(c.name, c.type, c.nullable, c.extra));
  out.push(sep('-'));

  return out.join('\n');
}

function getDirectBodyScript(el: XmlElement, type: string): string | undefined {
  // Direct BodyScript property (SqlProcedure, SqlView)
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

// ─── Name Parsing ───────────────────────────────────────────────────────────

/** Parse "[schema].[object]" — schema is uppercased for case-insensitive consistency */
function parseName(fullName: string): { schema: string; objectName: string } {
  const parts = fullName.replace(/\[|\]/g, '').split('.');
  if (parts.length >= 2) {
    return { schema: parts[0].toUpperCase(), objectName: parts[1] };
  }
  return { schema: 'DBO', objectName: parts[0] };
}

/** Normalize to lowercase "[schema].[object]" for consistent matching */
function normalizeName(name: string): string {
  const parts = name.replace(/\[|\]/g, '').split('.');
  if (parts.length >= 2) {
    return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
  }
  return `[dbo].[${parts[0]}]`.toLowerCase();
}

/** Check if ref is object-level (2 parts) not column-level (3+ parts) */
function isObjectLevelRef(name: string): boolean {
  const parts = name.replace(/\[|\]/g, '').split('.');
  return parts.length === 2 && !parts[1].startsWith('@');
}

// ─── Schema Computation ────────────────────────────────────────────────────

export function computeSchemas(nodes: LineageNode[]): SchemaInfo[] {
  const map = new Map<string, SchemaInfo>();
  for (const node of nodes) {
    let info = map.get(node.schema);
    if (!info) {
      info = {
        name: node.schema,
        nodeCount: 0,
        types: { table: 0, view: 0, procedure: 0, function: 0 },
      };
      map.set(node.schema, info);
    }
    info.nodeCount++;
    info.types[node.type]++;
  }
  return Array.from(map.values()).sort((a, b) => b.nodeCount - a.nodeCount);
}

// ─── Exclusion Patterns ─────────────────────────────────────────────────────

export function applyExclusionPatterns(model: DacpacModel, patterns: string[]): DacpacModel {
  if (!patterns || patterns.length === 0) return model;

  const regexes = patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
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
    const allEdges = model.edges; // pre-exclusion edges
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

// ─── Utilities ──────────────────────────────────────────────────────────────

function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function addEdge(
  edges: LineageEdge[],
  edgeKeys: Set<string>,
  source: string,
  target: string,
  type: 'body' | 'exec'
) {
  const key = `${source}→${target}`;
  if (!edgeKeys.has(key)) {
    edgeKeys.add(key);
    edges.push({ source, target, type });
  }
}
