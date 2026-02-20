/**
 * Tests for dacpac extraction, filtering, edge integrity, and error handling.
 * Execute with: npx tsx test/dacpacExtractor.test.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { extractDacpac, filterBySchemas } from '../src/engine/dacpacExtractor';
import { parseSqlBody, loadRules } from '../src/engine/sqlBodyParser';
import type { ParseRulesConfig } from '../src/engine/sqlBodyParser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DACPAC_PATH = resolve(__dirname, './AdventureWorks.dacpac');

// Load built-in rules from single source of truth (assets/defaultParseRules.yaml)
const rulesYaml = readFileSync(resolve(__dirname, '../assets/defaultParseRules.yaml'), 'utf-8');
loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

// ─── Extraction ─────────────────────────────────────────────────────────────

async function testExtraction() {
  console.log('\n── DACPAC Extraction ──');
  const buffer = readFileSync(DACPAC_PATH);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);

  assert(model.nodes.length > 0, `Extracted ${model.nodes.length} nodes`);
  assert(model.edges.length > 0, `Extracted ${model.edges.length} edges`);
  assert(model.schemas.length > 0, `Found ${model.schemas.length} schemas: ${model.schemas.map(s => s.name).join(', ')}`);

  // Check node types
  const tables = model.nodes.filter(n => n.type === 'table');
  const views = model.nodes.filter(n => n.type === 'view');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  const funcs = model.nodes.filter(n => n.type === 'function');

  assert(tables.length > 0, `Found ${tables.length} tables`);
  assert(views.length > 0, `Found ${views.length} views`);
  assert(procs.length > 0, `Found ${procs.length} procedures`);
  assert(funcs.length > 0, `Found ${funcs.length} functions`);

  // Check schemas match expected
  const schemaNames = model.schemas.map(s => s.name);
  assert(schemaNames.includes('DBO'), 'Schema "dbo" found');
  assert(schemaNames.includes('SALES'), 'Schema "SALES" found');

  // Check specific known objects
  const nodeNames = model.nodes.map(n => n.fullName);
  assert(nodeNames.some(n => n.includes('ErrorLog')), 'ErrorLog table found');
  assert(nodeNames.some(n => n.includes('vProductAndDescription')), 'vProductAndDescription view found');
  assert(nodeNames.some(n => n.includes('uspLogError')), 'uspLogError procedure found');

  return model;
}

// ─── Schema Filtering ───────────────────────────────────────────────────────

async function testFiltering(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Schema Filtering ──');

  const salesLT = filterBySchemas(model, new Set(['SALES']));
  assert(salesLT.nodes.every(n => n.schema === 'SALES'), 'All filtered nodes are SALES schema');
  assert(salesLT.nodes.length > 0, `SALES has ${salesLT.nodes.length} nodes`);
  assert(salesLT.nodes.length < model.nodes.length, 'Filtered set is smaller than full set');

  const dbo = filterBySchemas(model, new Set(['DBO']));
  assert(dbo.nodes.every(n => n.schema === 'DBO'), 'All filtered nodes are dbo schema');

  // Max nodes cap
  const capped = filterBySchemas(model, new Set(['DBO', 'SALES']), 5);
  assert(capped.nodes.length <= 5, `Capped at ${capped.nodes.length} nodes (max 5)`);
}

// ─── Edge Integrity ─────────────────────────────────────────────────────────

async function testEdgeIntegrity(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Edge Integrity ──');

  const nodeIds = new Set(model.nodes.map(n => n.id));

  // All edge endpoints should reference existing nodes
  const danglingEdges = model.edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  assert(danglingEdges.length === 0, `No dangling edges (found ${danglingEdges.length})`);

  // No self-loops
  const selfLoops = model.edges.filter(e => e.source === e.target);
  assert(selfLoops.length === 0, `No self-loops (found ${selfLoops.length})`);

  // No duplicate edges
  const edgeKeys = model.edges.map(e => `${e.source}→${e.target}`);
  const uniqueEdges = new Set(edgeKeys);
  assert(uniqueEdges.size === edgeKeys.length, `No duplicate edges (${edgeKeys.length} total, ${uniqueEdges.size} unique)`);
}

// ─── Fabric SDK Dacpac ──────────────────────────────────────────────────────

async function testFabricDacpac() {
  console.log('\n── Fabric SDK Dacpac ──');
  const fabricPath = resolve(__dirname, './AdventureWorks_sdk-style.dacpac');
  const buffer = readFileSync(fabricPath);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);

  const views = model.nodes.filter(n => n.type === 'view');
  const tables = model.nodes.filter(n => n.type === 'table');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  const funcs = model.nodes.filter(n => n.type === 'function');

  assert(views.length > 0, `Found ${views.length} views`);
  assert(tables.length > 0, `Found ${tables.length} tables`);
  assert(procs.length > 0, `Found ${procs.length} procedures`);
  assert(funcs.length > 0, `Found ${funcs.length} functions`);

  // Views must have edges (QueryDependencies)
  const viewIds = new Set(views.map(n => n.id));
  const viewEdges = model.edges.filter(e => viewIds.has(e.target));
  assert(viewEdges.length > 0, `Views have ${viewEdges.length} incoming edges (QueryDependencies works)`);

  // Views with table refs should be connected (vw_deprecated_report has no table refs by design)
  const viewsWithEdges = new Set(viewEdges.map(e => e.target));
  const noTableViews = new Set(['[legacy].[vw_deprecated_report]']);
  const viewsMissing = views.filter(v => !viewsWithEdges.has(v.id) && !noTableViews.has(v.fullName));
  assert(viewsMissing.length === 0, viewsMissing.length === 0
    ? 'All views with table refs are connected'
    : `Disconnected views: ${viewsMissing.map(v => v.fullName).join(', ')}`);

  // Procs must also have edges (BodyDependencies still works)
  const procIds = new Set(procs.map(n => n.id));
  const procEdges = model.edges.filter(e => procIds.has(e.target));
  assert(procEdges.length > 0, `Procedures have ${procEdges.length} incoming edges (BodyDependencies works)`);

  // Edge integrity
  const nodeIds = new Set(model.nodes.map(n => n.id));
  const dangling = model.edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  assert(dangling.length === 0, `No dangling edges (found ${dangling.length})`);
}

// ─── Type-Aware Direction ───────────────────────────────────────────────────

async function testTypeAwareDirection() {
  console.log('\n── Type-Aware Direction: XML type matches regex direction ──');

  // Proves: for every dep where both XML and regex agree, the object-type-based
  // direction inference matches what regex determined. If this holds for the
  // overlap set, the fallback is correct for XML-only deps too.

  const { XMLParser } = await import('fast-xml-parser');
  const JSZip = (await import('jszip')).default;

  const ELEMENT_TYPE_MAP: Record<string, string> = {
    SqlTable: 'table', SqlView: 'view', SqlProcedure: 'procedure',
    SqlScalarFunction: 'function', SqlInlineTableValuedFunction: 'function',
    SqlMultiStatementTableValuedFunction: 'function', SqlTableValuedFunction: 'function',
  };

  function normName(name: string): string {
    const parts = name.replace(/\[|\]/g, '').split('.');
    if (parts.length >= 2) return `[${parts[0]}].[${parts[1]}]`.toLowerCase();
    return `[dbo].[${parts[0]}]`.toLowerCase();
  }

  function isObjectLevelRef(name: string): boolean {
    const parts = name.replace(/\[|\]/g, '').split('.');
    return parts.length === 2 && !parts[1].startsWith('@');
  }

  function extractPropVal(prop: any): string | undefined {
    if (prop['@_Value'] !== undefined) return String(prop['@_Value']);
    if (prop.Value !== undefined) {
      if (typeof prop.Value === 'string') return prop.Value;
      if (typeof prop.Value === 'object' && prop.Value['#text']) return String(prop.Value['#text']);
    }
    return undefined;
  }

  function asArr<T>(val: T | T[] | undefined): T[] {
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
  }

  const dacpacs = [
    { label: 'Classic', path: resolve(__dirname, './AdventureWorks.dacpac') },
    { label: 'SDK-style', path: resolve(__dirname, './AdventureWorks_sdk-style.dacpac') },
  ];

  for (const { label, path } of dacpacs) {
    const buf = readFileSync(path);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('model.xml')!.async('string');
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_',
      isArray: (n: string) => ['Element', 'Entry', 'Property', 'Relationship', 'Annotation'].includes(n),
      parseTagValue: true, trimValues: true,
    });
    const doc = parser.parse(xml);
    const elements: any[] = asArr(doc?.DataSchemaModel?.Model?.Element);

    // Build catalog with types
    const catalog = new Set<string>();
    const catalogType = new Map<string, string>();
    for (const el of elements) {
      const t = el['@_Type'];
      const n = el['@_Name'];
      if (!n) continue;
      const objType = ELEMENT_TYPE_MAP[t];
      if (objType) { const id = normName(n); catalog.add(id); catalogType.set(id, objType); }
    }

    let totalChecked = 0;
    let matches = 0;
    let expectedMismatches = 0;  // table WRITEs — handled by regex, never reach type-aware path
    const mismatches: string[] = [];

    for (const el of elements) {
      if (el['@_Type'] !== 'SqlProcedure') continue;
      const spName = el['@_Name'];
      if (!spName) continue;
      const spId = normName(spName);

      // XML BodyDependencies
      const xmlDeps = new Set<string>();
      for (const rel of asArr(el.Relationship)) {
        if (rel['@_Name'] !== 'BodyDependencies' && rel['@_Name'] !== 'QueryDependencies') continue;
        for (const entry of asArr(rel.Entry)) {
          for (const ref of asArr(entry.References)) {
            if (ref['@_ExternalSource']) continue;
            const rn = ref['@_Name'];
            if (!rn || !isObjectLevelRef(rn)) continue;
            const norm = normName(rn);
            if (norm !== spId && catalog.has(norm)) xmlDeps.add(norm);
          }
        }
      }

      // Body script
      let bodyScript: string | undefined;
      for (const ann of asArr(el.Annotation)) {
        if (ann['@_Type'] === 'SysCommentsObjectAnnotation') {
          for (const prop of asArr(ann.Property)) {
            if (prop['@_Name'] === 'HeaderContents') {
              const header = extractPropVal(prop);
              for (const p of asArr(el.Property)) {
                if (p['@_Name'] === 'BodyScript') {
                  const val = extractPropVal(p);
                  if (header && val) bodyScript = `${header}\n${val}`;
                }
              }
            }
          }
        }
      }
      if (!bodyScript) {
        for (const p of asArr(el.Property)) {
          if (p['@_Name'] === 'BodyScript') bodyScript = extractPropVal(p);
        }
      }
      if (!bodyScript) continue;

      // Regex parse
      const parsed = parseSqlBody(bodyScript);
      const regexSources = new Set<string>();
      const regexTargets = new Set<string>();
      const regexExec = new Set<string>();
      const regexAll = new Set<string>();

      for (const s of parsed.sources) { const n = normName(s); if (n !== spId && catalog.has(n)) { regexAll.add(n); regexSources.add(n); } }
      for (const t of parsed.targets) { const n = normName(t); if (n !== spId && catalog.has(n)) { regexAll.add(n); regexTargets.add(n); } }
      for (const e of parsed.execCalls) { const n = normName(e); if (n !== spId && catalog.has(n)) { regexAll.add(n); regexExec.add(n); } }

      // For each dep in both XML and regex: compare type-inferred direction vs regex direction
      for (const dep of xmlDeps) {
        if (!regexAll.has(dep)) continue;  // XML-only, skip (that's the fallback case)
        totalChecked++;

        const depType = catalogType.get(dep) || 'unknown';
        const typeInferred = depType === 'procedure' ? 'EXEC' : 'READ';
        const regexDir = regexExec.has(dep) ? 'EXEC' : regexTargets.has(dep) ? 'WRITE' : 'READ';

        if (typeInferred === regexDir) {
          matches++;
        } else if (regexDir === 'WRITE' && depType === 'table') {
          // Expected: table WRITEs are in regex outboundIds, so excluded from type-aware path
          expectedMismatches++;
        } else {
          mismatches.push(`${spName} → ${dep}: type=${depType} inferred=${typeInferred} regex=${regexDir}`);
        }
      }
    }

    const pct = totalChecked > 0 ? ((matches + expectedMismatches) / totalChecked * 100).toFixed(1) : '0';
    assert(mismatches.length === 0,
      `${label}: type-aware direction matches regex for ${matches}/${totalChecked} deps (${pct}%, ${expectedMismatches} table-WRITEs handled by regex)`);

    if (mismatches.length > 0) {
      for (const m of mismatches) console.log(`    MISMATCH: ${m}`);
    }
  }
}

// ─── Security: Numeric Entity DoS (CVE-2026-25128) ─────────────────────────

async function testNumericEntitySecurity() {
  console.log('\n── Security: Numeric Entity DoS (CVE-2026-25128) ──');

  // Craft a minimal dacpac-like XML with out-of-range numeric entities
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true,
  });

  // Test 1: Out-of-range decimal entity — must NOT throw RangeError
  const xmlDecimal = `<root><item>test &#9999999; value</item></root>`;
  let decimalOk = false;
  try {
    parser.parse(xmlDecimal);
    decimalOk = true;
  } catch (e: unknown) {
    if (e instanceof RangeError) {
      decimalOk = false;
    } else {
      // Other errors are acceptable (not DoS)
      decimalOk = true;
    }
  }
  assert(decimalOk, 'Out-of-range decimal entity (&#9999999;) does not crash with RangeError');

  // Test 2: Out-of-range hex entity — must NOT throw RangeError
  const xmlHex = `<root><item>test &#xFFFFFF; value</item></root>`;
  let hexOk = false;
  try {
    parser.parse(xmlHex);
    hexOk = true;
  } catch (e: unknown) {
    if (e instanceof RangeError) {
      hexOk = false;
    } else {
      hexOk = true;
    }
  }
  assert(hexOk, 'Out-of-range hex entity (&#xFFFFFF;) does not crash with RangeError');

  // Test 3: Valid entity parses without error
  const xmlValid = `<root><item>test &#65; value</item></root>`;
  let validOk = false;
  try {
    parser.parse(xmlValid);
    validOk = true;
  } catch {
    validOk = false;
  }
  assert(validOk, 'Valid entity &#65; parses without error');

  // Test 4: processEntities mode (this is where v4.x was vulnerable)
  const parserWithEntities = new XMLParser({
    processEntities: true,
    htmlEntities: true,
  });

  let entDecOk = false;
  try {
    parserWithEntities.parse(`<root>&#9999999;</root>`);
    entDecOk = true;
  } catch (e: unknown) {
    entDecOk = !(e instanceof RangeError);
  }
  assert(entDecOk, 'processEntities + out-of-range decimal does not RangeError');

  let entHexOk = false;
  try {
    parserWithEntities.parse(`<root>&#xFFFFFF;</root>`);
    entHexOk = true;
  } catch (e: unknown) {
    entHexOk = !(e instanceof RangeError);
  }
  assert(entHexOk, 'processEntities + out-of-range hex does not RangeError');
}

// ─── Import Error Handling ──────────────────────────────────────────────────

async function testImportErrorHandling() {
  console.log('\n── Import Error Handling ──');
  const JSZip = (await import('jszip')).default;

  // Non-ZIP file → friendly error
  try {
    await extractDacpac(new TextEncoder().encode('this is not a zip file').buffer as ArrayBuffer);
    assert(false, 'Non-ZIP should throw');
  } catch (err: unknown) {
    const msg = (err as Error).message;
    assert(msg.includes('Not a valid .dacpac file'), `Non-ZIP error is user-friendly: "${msg}"`);
    assert(!msg.includes('https://'), 'No raw URL in error message');
  }

  // Empty file → friendly error
  try {
    await extractDacpac(new ArrayBuffer(0));
    assert(false, 'Empty file should throw');
  } catch (err: unknown) {
    const msg = (err as Error).message;
    assert(msg.includes('corrupted or truncated') || msg.includes('Not a valid'), `Empty file error is user-friendly: "${msg}"`);
  }

  // ZIP without model.xml → existing clear error
  const zip = new JSZip();
  zip.file('other.xml', '<root/>');
  const noModelBuf = await zip.generateAsync({ type: 'arraybuffer' });
  try {
    await extractDacpac(noModelBuf);
    assert(false, 'ZIP without model.xml should throw');
  } catch (err: unknown) {
    const msg = (err as Error).message;
    assert(msg.includes('model.xml not found'), `Missing model.xml error: "${msg}"`);
  }

  // Valid dacpac with no tracked elements → warnings populated
  const emptyZip = new JSZip();
  emptyZip.file('model.xml', `<?xml version="1.0"?>
    <DataSchemaModel>
      <Model>
        <Element Type="SqlDatabaseOptions" Name="Options"/>
      </Model>
    </DataSchemaModel>`);
  const emptyBuf = await emptyZip.generateAsync({ type: 'arraybuffer' });
  const emptyModel = await extractDacpac(emptyBuf);
  assert(emptyModel.nodes.length === 0, 'Empty dacpac has 0 nodes');
  assert(emptyModel.warnings !== undefined && emptyModel.warnings.length > 0, 'Empty dacpac has warnings');
  assert(emptyModel.warnings![0].includes('No tables, views, or stored procedures'), `Warning explains why: "${emptyModel.warnings![0]}"`);

  // Successful extraction → no warnings
  const buffer = readFileSync(DACPAC_PATH);
  const model = await extractDacpac(buffer.buffer as ArrayBuffer);
  assert(model.warnings === undefined, 'Successful extraction has no warnings');
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('═══ DACPAC Extractor Tests ═══');

  try {
    const model = await testExtraction();
    await testFiltering(model);
    await testEdgeIntegrity(model);
    await testFabricDacpac();
    await testTypeAwareDirection();
    await testNumericEntitySecurity();
    await testImportErrorHandling();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
    failed++;
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
