/**
 * Tests for dacpac extraction, filtering, edge integrity, and error handling.
 * Execute with: npx tsx test/dacpacExtractor.test.ts
 */

import { readFileSync } from 'fs';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered, filterBySchemas, parseDspPlatform } from '../../src/engine/dacpacExtractor';
import { assert, assertEq, loadParseRules, testPath, printSummary, loadAdventureWorksModel } from './helpers/testUtils';

loadParseRules();

// ─── Extraction ─────────────────────────────────────────────────────────────

async function testExtraction() {
  console.log('\n── DACPAC Extraction ──');
  const model = await loadAdventureWorksModel();

  assert(model.nodes.length > 0, `Extracted ${model.nodes.length} nodes`);
  assert(model.edges.length > 0, `Extracted ${model.edges.length} edges`);
  assert(model.schemas.length > 0, `Found ${model.schemas.length} schemas`);

  // All 4 object types present
  for (const type of ['table', 'view', 'procedure', 'function'] as const) {
    assert(model.nodes.some(n => n.type === type), `Has ${type} nodes`);
  }

  // Catalog and neighborIndex populated
  assert(Object.keys(model.catalog).length >= model.nodes.length, 'Catalog populated');
  assert(model.neighborIndex !== undefined, 'NeighborIndex present');

  return model;
}

// ─── Schema Filtering ───────────────────────────────────────────────────────

async function testFiltering(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Schema Filtering ──');

  const salesLT = filterBySchemas(model, new Set(['Sales']));
  const isVirtual = (n: { externalType?: string }) => n.externalType === 'file' || n.externalType === 'db';
  assert(salesLT.nodes.every(n => n.schema === 'Sales' || isVirtual(n)), 'All filtered nodes are Sales schema (or virtual)');
  assert(salesLT.nodes.length > 0 && salesLT.nodes.length < model.nodes.length, 'Filtered set is smaller than full set');

  // Max nodes cap
  const capped = filterBySchemas(model, new Set(['dbo', 'Sales']), 5);
  assert(capped.nodes.length <= 5, `Capped at max 5 nodes`);
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
  const fabricPath = testPath('AdventureWorks_sdk-style.dacpac');
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
  const model = await loadAdventureWorksModel();
  assert(model.warnings === undefined, 'Successful extraction has no warnings');
}

// ─── Constraint extraction (UQ / CK / FK) ───────────────────────────────────

async function testConstraints() {
  console.log('\n── Table Design Constraints (dacpac) ──');
  const model = await loadAdventureWorksModel();

  // [HumanResources].[Employee] has FK_Employee_Person_BusinessEntityID (→ Person.Person)
  // and CK_Employee_BirthDate on the BirthDate column
  const employee = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  assert(!!employee, 'HumanResources.Employee node found');
  assert((employee?.fks?.length ?? 0) > 0, 'Employee has FK constraints');
  assert(employee!.fks!.some(fk => fk.name === 'FK_Employee_Person_BusinessEntityID'), 'Employee has FK_Employee_Person_BusinessEntityID');
  assert(employee!.fks!.some(fk => fk.refTable === 'Person'), 'FK references Person table');
  assert(employee!.columns!.some(c => c.check !== undefined && c.check !== ''), 'Employee has CK flag on a column');

  // [Production].[Document] has a UQ constraint on rowguid
  const document = model.nodes.find(n => n.schema === 'Production' && n.name === 'Document');
  assert(!!document, 'Production.Document node found');
  assert(document!.columns!.some(c => c.unique !== undefined && c.unique !== ''), 'Document has UQ flag on a column');

  // A table without FKs has empty fks array (not undefined)
  const noFkTable = model.nodes.find(n => n.type === 'table' && n.fks !== undefined && n.fks.length === 0);
  assert(!!noFkTable, 'Table with no FKs has empty fks array');

  // Phase 2 (extractDacpacFiltered): FK constraints must survive schema filtering.
  // Regression: FK elements (SqlForeignKeyConstraint) were excluded from TRACKED_ELEMENT_TYPES
  // so the filtered element list passed to extractObjects had no FK data → fkMap always empty.
  const buffer2 = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { elements } = await extractSchemaPreview(buffer2.buffer as ArrayBuffer);
  const filteredModel = extractDacpacFiltered(elements, new Set(['HumanResources', 'Person']));
  const empFiltered = filteredModel.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  assert(!!empFiltered, 'Phase 2: HumanResources.Employee found after schema filter');
  assert((empFiltered?.fks?.length ?? 0) > 0, 'Phase 2: Employee has FK constraints (not dropped by filter)');
  const addrFiltered = filteredModel.nodes.find(n => n.schema === 'Person' && n.name === 'Address');
  assert(!!addrFiltered, 'Phase 2: Person.Address found after schema filter');
  assert((addrFiltered?.fks?.length ?? 0) > 0, 'Phase 2: Person.Address has FK constraints (not dropped by filter)');

  // SDK-style dacpac: no constraints extracted (Fabric DW has no FK/UQ/CK)
  const fabricPath = testPath('AdventureWorks_sdk-style.dacpac');
  const fabricBuf = readFileSync(fabricPath);
  const fabricModel = await extractDacpac(fabricBuf.buffer as ArrayBuffer);
  const fabricTable = fabricModel.nodes.find(n => n.type === 'table');
  assert(!!fabricTable, 'SDK-style dacpac has at least one table');
  assert(fabricTable?.columns !== undefined, 'SDK-style table has columns');
}

// ─── parseDspPlatform — all known DSP substrings ─────────────────────────────

function testParseDspPlatform() {
  console.log('\n── parseDspPlatform ──');

  // Empty / falsy inputs
  assertEq(parseDspPlatform(''), '', 'Empty string returns empty');

  // Cloud platforms — must match before on-prem version strings
  assertEq(
    parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlDwUnifiedDatabaseSchemaProvider'),
    'Fabric Data Warehouse', 'SqlDwUnified → Fabric Data Warehouse',
  );
  assertEq(
    parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlDbFabricDatabaseSchemaProvider'),
    'SQL Database in Fabric', 'SqlDbFabric → SQL Database in Fabric',
  );
  assertEq(
    parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlDwDatabaseSchemaProvider'),
    'Synapse Dedicated Pool', 'SqlDwDatabase → Synapse Dedicated Pool',
  );
  assertEq(
    parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlManagedInstanceDatabaseSchemaProvider'),
    'Azure SQL Managed Instance', 'SqlManagedInstance → Azure SQL Managed Instance',
  );
  assertEq(
    parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlHyperscaleDatabaseSchemaProvider'),
    'Azure SQL Hyperscale', 'SqlHyperscale → Azure SQL Hyperscale',
  );
  assertEq(
    parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlAzureV12DatabaseSchemaProvider'),
    'Azure SQL Database', 'SqlAzureV12 → Azure SQL Database',
  );

  // On-prem SQL Server — representative versions (latest, middle, earliest)
  const onPremCases: [string, string][] = [
    ['Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider', 'SQL Server 2025'],
    ['Microsoft.Data.Tools.Schema.Sql.Sql130DatabaseSchemaProvider', 'SQL Server 2016'],
    ['Microsoft.Data.Tools.Schema.Sql.Sql80DatabaseSchemaProvider',  'SQL Server 2000'],
  ];
  for (const [dsp, expected] of onPremCases) {
    assertEq(parseDspPlatform(dsp), expected, `${dsp.split('.').pop()} → ${expected}`);
  }

  // Specificity: SqlAzureV12 must not be matched by Sql120 (they share no substring)
  // (SqlAzureV12 matched before loop, Sql120 loop entry can't interfere — verify)
  assertEq(
    parseDspPlatform('SqlAzureV12DatabaseSchemaProvider'),
    'Azure SQL Database', 'Bare SqlAzureV12 still matches',
  );

  // Unknown provider: extract Pascal-case name from namespace
  assertEq(
    parseDspPlatform('Vendor.MyTool.Schema.SqlFutureDatabaseSchemaProvider'),
    'SqlFuture', 'Unknown provider: extract readable part before DatabaseSchemaProvider',
  );

  // Completely unknown — no regex match: return raw DSP
  assertEq(
    parseDspPlatform('some-unknown-provider'),
    'some-unknown-provider', 'Completely unknown: return raw string',
  );
}

// ─── Bridge: dbPlatform flows into DatabaseModel ─────────────────────────────

async function testDbPlatformInModel() {
  console.log('\n── Bridge: dbPlatform in DatabaseModel ──');

  // Azure SQL (classic AdventureWorks) → 'Azure SQL Database'
  const awModel = await loadAdventureWorksModel();
  assertEq(awModel.dbPlatform, 'SQL Server 2025', 'AdventureWorks dacpac: dbPlatform = SQL Server 2025');

  // Fabric (SDK-style) → 'Fabric Data Warehouse'
  const fabricBuf = readFileSync(testPath('AdventureWorks_sdk-style.dacpac'));
  const fabricModel = await extractDacpac(fabricBuf.buffer as ArrayBuffer);
  assertEq(fabricModel.dbPlatform, 'Fabric Data Warehouse', 'SDK-style dacpac: dbPlatform = Fabric Data Warehouse');

  // Phase 2 (extractDacpacFiltered): dspName passed through → dbPlatform preserved
  const awBuf = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { elements, dspName } = await extractSchemaPreview(awBuf.buffer as ArrayBuffer);
  assert(dspName.includes('Sql170'), `Phase 1 dspName contains Sql170 (got: "${dspName}")`);
  const filteredModel = extractDacpacFiltered(elements, new Set(['HumanResources', 'Person']), dspName);
  assertEq(filteredModel.dbPlatform, 'SQL Server 2025', 'Phase 2 filtered model: dbPlatform preserved from dspName');

  // Phase 2 without dspName → dbPlatform undefined (no platform info available)
  const filteredNoPlat = extractDacpacFiltered(elements, new Set(['HumanResources']));
  assert(filteredNoPlat.dbPlatform === undefined || filteredNoPlat.dbPlatform === '',
    'Phase 2 without dspName: dbPlatform absent');
}

// ─── Bridge: pkOrdinal flows into ColumnDef ──────────────────────────────────

async function testPkOrdinalInModel() {
  console.log('\n── Bridge: pkOrdinal in ColumnDef ──');
  const model = await loadAdventureWorksModel();

  // HumanResources.Employee: single-column PK (BusinessEntityID)
  const employee = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  assert(employee !== undefined, 'HumanResources.Employee found');
  const beid = employee!.columns?.find(c => c.name === 'BusinessEntityID');
  assert(beid !== undefined, 'BusinessEntityID column found');
  assertEq(beid!.pkOrdinal, 1, 'BusinessEntityID: pkOrdinal = 1 (single PK)');

  // Non-PK column on the same table has no pkOrdinal
  const natId = employee!.columns?.find(c => c.name === 'NationalIDNumber');
  assert(natId !== undefined, 'NationalIDNumber column found');
  assert(natId!.pkOrdinal === undefined, 'NationalIDNumber: no pkOrdinal (not a PK column)');

  // Composite PK table: find any table with 2+ pkOrdinal columns
  const compositePkTable = model.nodes.find(n =>
    n.type === 'table' &&
    n.columns !== undefined &&
    n.columns.filter(c => c.pkOrdinal !== undefined).length >= 2,
  );
  assert(compositePkTable !== undefined, 'At least one table with composite PK found');
  const pkCols = compositePkTable!.columns!.filter(c => c.pkOrdinal !== undefined);
  const ordinals = pkCols.map(c => c.pkOrdinal!).sort((a, b) => a - b);
  assertEq(ordinals[0], 1, `Composite PK: first ordinal is 1 (table: ${compositePkTable!.name})`);
  assertEq(ordinals[1], 2, `Composite PK: second ordinal is 2 (table: ${compositePkTable!.name})`);
  assert(ordinals.every((v, i) => v === i + 1), 'Composite PK: ordinals are 1-based and sequential');

  // Views never have PK constraints — verify no pkOrdinal on any view column
  const anyView = model.nodes.find(n => n.type === 'view' && n.columns !== undefined);
  if (anyView) {
    const viewPkCols = anyView.columns!.filter(c => c.pkOrdinal !== undefined);
    assertEq(viewPkCols.length, 0, `View ${anyView.name}: no pkOrdinal columns (views have no PK)`);
  }

  // Procedures have no columns at all — verify columns is absent/empty
  const anyProc = model.nodes.find(n => n.type === 'procedure');
  assert(anyProc !== undefined, 'At least one procedure found');
  const procPkCols = anyProc!.columns?.filter(c => c.pkOrdinal !== undefined) ?? [];
  assertEq(procPkCols.length, 0, 'Procedure: no pkOrdinal columns');
}

// ─── Bridge: Phase 1 → Phase 2 sequencing ────────────────────────────────────

async function testPhase1Phase2Bridge() {
  console.log('\n── Bridge: Phase 1 → Phase 2 data flow ──');

  // Phase 1 returns elements + dspName ready for bridge caching
  const buf = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { preview, elements, dspName } = await extractSchemaPreview(buf.buffer as ArrayBuffer);

  // preview is well-formed
  assert(preview.schemas.length > 0, 'Phase 1: schemas list populated');
  assert(preview.totalObjects > 0, 'Phase 1: totalObjects > 0');
  assert(typeof dspName === 'string' && dspName.length > 0, 'Phase 1: dspName is non-empty string');

  // elements are cached for Phase 2
  assert(Array.isArray(elements) && elements.length > 0, 'Phase 1: elements array non-empty (bridge cache)');

  // Phase 2 uses the cached elements — must produce same node/edge count as full extractDacpac
  const allSchemas = new Set(preview.schemas.map(s => s.name));
  const phase2Model = extractDacpacFiltered(elements, allSchemas, dspName);
  const fullModel = await loadAdventureWorksModel();

  assertEq(phase2Model.nodes.length, fullModel.nodes.length,
    `Phase 2 with all schemas: same node count as full extract (${fullModel.nodes.length})`);
  assertEq(phase2Model.edges.length, fullModel.edges.length,
    `Phase 2 with all schemas: same edge count as full extract (${fullModel.edges.length})`);
  assertEq(phase2Model.dbPlatform, fullModel.dbPlatform,
    'Phase 2: dbPlatform matches full extract');

  // Schema subset: Phase 2 with one schema produces fewer nodes
  const hrOnly = extractDacpacFiltered(elements, new Set(['HumanResources']), dspName);
  assert(hrOnly.nodes.length < fullModel.nodes.length,
    'Phase 2 schema subset: fewer nodes than full model');
  assert(hrOnly.nodes.every(n => n.schema === 'HumanResources' || n.externalType !== undefined),
    'Phase 2 schema subset: only HumanResources nodes (+ virtual externals)');
  assertEq(hrOnly.dbPlatform, 'SQL Server 2025',
    'Phase 2 schema subset: dbPlatform still set from dspName');

  // Phase 2 with empty schema set produces empty model (no crash)
  const emptyModel = extractDacpacFiltered(elements, new Set(), dspName);
  assertEq(emptyModel.nodes.length, 0, 'Phase 2 empty schema set: 0 nodes (no crash)');
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('═══ DACPAC Extractor Tests ═══');

  try {
    const model = await testExtraction();
    await testFiltering(model);
    await testEdgeIntegrity(model);
    await testFabricDacpac();
    await testNumericEntitySecurity();
    await testImportErrorHandling();
    await testConstraints();
    testParseDspPlatform();
    await testDbPlatformInModel();
    await testPkOrdinalInModel();
    await testPhase1Phase2Bridge();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('DACPAC Extractor');
}

main();
