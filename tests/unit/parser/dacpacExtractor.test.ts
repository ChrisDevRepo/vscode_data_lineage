/**
 * Tests for dacpac extraction, filtering, edge integrity, and error handling.
 */

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered, parseDspPlatform } from '../../../src/engine/dacpacExtractor';
import { loadParseRules, testPath, loadAdventureWorksModel } from '../helpers/testUtils';

describe('DACPAC Extractor', () => {
  loadParseRules();

/** Builds a minimal in-memory dacpac with a single procedure referencing an external file (OPENROWSET). */
async function makeExternalRefDacpac(): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('model.xml', `<?xml version="1.0"?>
    <DataSchemaModel DspName="Microsoft.Data.Tools.Schema.Sql.Sql160DatabaseSchemaProvider">
      <Model>
        <Element Type="SqlProcedure" Name="[dbo].[LoadExternal]">
          <Property Name="BodyScript" Value="SELECT * FROM OPENROWSET(BULK 'https://storage.example/orders.csv', FORMAT='CSV') AS rows" />
        </Element>
      </Model>
    </DataSchemaModel>`);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes;
}

// ─── Extraction ─────────────────────────────────────────────────────────────

async function testExtraction() {
  console.log('\n── DACPAC Extraction ──');
  const model = await loadAdventureWorksModel();

  expect(model.nodes.length > 0, `Extracted ${model.nodes.length} nodes`).toBe(true);
  expect(model.edges.length > 0, `Extracted ${model.edges.length} edges`).toBe(true);
  expect(model.schemas.length > 0, `Found ${model.schemas.length} schemas`).toBe(true);

  // A count floor, not a smoke check: `> 0` still passes if a parse rule regresses and the
  // real-world edge set collapses. The exact per-procedure edges are pinned in
  // testNamedProcedureEdges below; this guards the model as a whole.
  expect(model.edges.length, 'Edge count fell below the AdventureWorks floor').toBeGreaterThanOrEqual(169);

  // All 4 object types present
  for (const type of ['table', 'view', 'procedure', 'function'] as const) {
    expect(model.nodes.some(n => n.type === type), `Has ${type} nodes`).toBe(true);
  }

  // Catalog and neighborIndex populated
  expect(Object.keys(model.catalog).length >= model.nodes.length, 'Catalog populated').toBe(true);
  expect(Object.keys(model.neighborIndex).length > 0, 'NeighborIndex populated').toBe(true);

  return model;
}

// ─── Named Procedure Edges ──────────────────────────────────────────────────

/**
 * Pins the exact edge set the SQL-body parser derives for two AdventureWorks procedures.
 *
 * @remarks
 * `testExtraction` only proves the model has *some* edges. These two procedures were chosen
 * because between them they exercise every extraction category on real dacpac bodies: reads
 * (`FROM`/`JOIN`), writes (`INSERT`/`UPDATE`), a table that is both read and written in the same
 * body, and `EXEC` calls. A regression in any parse rule changes one of these sets.
 */
async function testNamedProcedureEdges() {
  console.log('\n── Named Procedure Edges ──');
  const model = await loadAdventureWorksModel();

  const edgesFor = (procId: string): string[] =>
    model.edges
      .filter(e => e.source === procId || e.target === procId)
      .map(e => `${e.source}|${e.type}|${e.target}`)
      .sort();

  // Reads three tables, writes two (cleanedorders is both), and logs via EXEC.
  expect(edgesFor('[ai].[spcleanorders]')).toEqual([
    '[ai].[cleanedorders]|body|[ai].[spcleanorders]',
    '[ai].[customermaster]|body|[ai].[spcleanorders]',
    '[ai].[raworderimport]|body|[ai].[spcleanorders]',
    '[ai].[spcleanorders]|body|[ai].[cleanedorders]',
    '[ai].[spcleanorders]|body|[ai].[errorlog]',
    '[ai].[spcleanorders]|exec|[ai].[splogaudit]',
  ]);

  // UPDATE targets only, plus an error-handler EXEC — no read edges at all.
  expect(edgesFor('[humanresources].[uspupdateemployeehireinfo]')).toEqual([
    '[humanresources].[uspupdateemployeehireinfo]|body|[humanresources].[employee]',
    '[humanresources].[uspupdateemployeehireinfo]|body|[humanresources].[employeepayhistory]',
    '[humanresources].[uspupdateemployeehireinfo]|exec|[dbo].[usplogerror]',
  ]);
}

// ─── Edge Integrity ─────────────────────────────────────────────────────────

function testEdgeIntegrity(model: Awaited<ReturnType<typeof extractDacpac>>) {
  console.log('\n── Edge Integrity ──');

  const nodeIds = new Set(model.nodes.map(n => n.id));

  // All edge endpoints should reference existing nodes
  const danglingEdges = model.edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  expect(danglingEdges.length === 0, `No dangling edges (found ${danglingEdges.length})`).toBe(true);

  // No self-loops
  const selfLoops = model.edges.filter(e => e.source === e.target);
  expect(selfLoops.length === 0, `No self-loops (found ${selfLoops.length})`).toBe(true);

  // No duplicate edges
  const edgeKeys = model.edges.map(e => `${e.source}→${e.target}`);
  const uniqueEdges = new Set(edgeKeys);
  expect(uniqueEdges.size === edgeKeys.length, `No duplicate edges (${edgeKeys.length} total, ${uniqueEdges.size} unique)`).toBe(true);
}

// ─── Fabric SDK Dacpac ──────────────────────────────────────────────────────

async function testFabricDacpac() {
  console.log('\n── Fabric SDK Dacpac ──');
  const fabricPath = testPath('AdventureWorks_sdk-style.dacpac');
  const buffer = readFileSync(fabricPath);
  const model = await extractDacpac(buffer);

  const views = model.nodes.filter(n => n.type === 'view');
  const tables = model.nodes.filter(n => n.type === 'table');
  const procs = model.nodes.filter(n => n.type === 'procedure');
  const funcs = model.nodes.filter(n => n.type === 'function');

  expect(views.length > 0, `Found ${views.length} views`).toBe(true);
  expect(tables.length > 0, `Found ${tables.length} tables`).toBe(true);
  expect(procs.length > 0, `Found ${procs.length} procedures`).toBe(true);
  expect(funcs.length > 0, `Found ${funcs.length} functions`).toBe(true);

  // Views must have edges (QueryDependencies)
  const viewIds = new Set(views.map(n => n.id));
  const viewEdges = model.edges.filter(e => viewIds.has(e.target));
  expect(viewEdges.length > 0, `Views have ${viewEdges.length} incoming edges (QueryDependencies works)`).toBe(true);

  // Views with table refs should be connected (vw_deprecated_report has no table refs by design)
  const viewsWithEdges = new Set(viewEdges.map(e => e.target));
  const noTableViews = new Set(['[legacy].[vw_deprecated_report]']);
  const viewsMissing = views.filter(v => !viewsWithEdges.has(v.id) && !noTableViews.has(v.fullName));
  expect(viewsMissing.length === 0, viewsMissing.length === 0
    ? 'All views with table refs are connected'
    : `Disconnected views: ${viewsMissing.map(v => v.fullName).join(', ')}`).toBe(true);

  // Procs must also have edges (BodyDependencies still works)
  const procIds = new Set(procs.map(n => n.id));
  const procEdges = model.edges.filter(e => procIds.has(e.target));
  expect(procEdges.length > 0, `Procedures have ${procEdges.length} incoming edges (BodyDependencies works)`).toBe(true);

  // Edge integrity
  const nodeIds = new Set(model.nodes.map(n => n.id));
  const dangling = model.edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  expect(dangling.length === 0, `No dangling edges (found ${dangling.length})`).toBe(true);
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
  expect(decimalOk, 'Out-of-range decimal entity (&#9999999;) does not crash with RangeError').toBe(true);

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
  expect(hexOk, 'Out-of-range hex entity (&#xFFFFFF;) does not crash with RangeError').toBe(true);

  // Test 3: Valid entity parses without error
  const xmlValid = `<root><item>test &#65; value</item></root>`;
  let validOk = false;
  try {
    parser.parse(xmlValid);
    validOk = true;
  } catch {
    validOk = false;
  }
  expect(validOk, 'Valid entity &#65; parses without error').toBe(true);

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
  expect(entDecOk, 'processEntities + out-of-range decimal does not RangeError').toBe(true);

  let entHexOk = false;
  try {
    parserWithEntities.parse(`<root>&#xFFFFFF;</root>`);
    entHexOk = true;
  } catch (e: unknown) {
    entHexOk = !(e instanceof RangeError);
  }
  expect(entHexOk, 'processEntities + out-of-range hex does not RangeError').toBe(true);
}

// ─── Import Error Handling ──────────────────────────────────────────────────

async function testImportErrorHandling() {
  console.log('\n── Import Error Handling ──');
  const JSZip = (await import('jszip')).default;

  // Non-ZIP file → friendly error
  try {
    await extractDacpac(new TextEncoder().encode('this is not a zip file'));
    expect(false, 'Non-ZIP should throw').toBe(true);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    expect(msg.includes('Not a valid .dacpac file'), `Non-ZIP error is user-friendly: "${msg}"`).toBe(true);
    expect(!msg.includes('https://'), 'No raw URL in error message').toBe(true);
  }

  // Empty file → friendly error
  try {
    await extractDacpac(new ArrayBuffer(0));
    expect(false, 'Empty file should throw').toBe(true);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    expect(msg.includes('corrupted or truncated') || msg.includes('Not a valid'), `Empty file error is user-friendly: "${msg}"`).toBe(true);
  }

  // ZIP without model.xml → existing clear error
  const zip = new JSZip();
  zip.file('other.xml', '<root/>');
  const noModelBuf = await zip.generateAsync({ type: 'arraybuffer' });
  try {
    await extractDacpac(noModelBuf);
    expect(false, 'ZIP without model.xml should throw').toBe(true);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    expect(msg.includes('model.xml not found'), `Missing model.xml error: "${msg}"`).toBe(true);
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
  expect(emptyModel.nodes.length === 0, 'Empty dacpac has 0 nodes').toBe(true);
  expect(emptyModel.warnings !== undefined && emptyModel.warnings.length > 0, 'Empty dacpac has warnings').toBe(true);
  expect(emptyModel.warnings![0].includes('No tables, views, or stored procedures'), `Warning explains why: "${emptyModel.warnings![0]}"`).toBe(true);

  // Successful extraction → no warnings
  const model = await loadAdventureWorksModel();
  expect(model.warnings === undefined, 'Successful extraction has no warnings').toBe(true);
}

// ─── Constraint extraction (UQ / CK / FK) ───────────────────────────────────

async function testConstraints() {
  console.log('\n── Table Design Constraints (dacpac) ──');
  const model = await loadAdventureWorksModel();

  // [HumanResources].[Employee] has FK_Employee_Person_BusinessEntityID (→ Person.Person)
  // and CK_Employee_BirthDate on the BirthDate column
  const employee = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  expect(!!employee, 'HumanResources.Employee node found').toBe(true);
  expect((employee?.fks?.length ?? 0) > 0, 'Employee has FK constraints').toBe(true);
  expect(employee!.fks!.some(fk => fk.name === 'FK_Employee_Person_BusinessEntityID'), 'Employee has FK_Employee_Person_BusinessEntityID').toBe(true);
  expect(employee!.fks!.some(fk => fk.refTable === 'Person'), 'FK references Person table').toBe(true);
  expect(employee!.columns!.some(c => c.check !== undefined && c.check !== ''), 'Employee has CK flag on a column').toBe(true);

  // [Production].[Document] has a UQ constraint on rowguid
  const document = model.nodes.find(n => n.schema === 'Production' && n.name === 'Document');
  expect(!!document, 'Production.Document node found').toBe(true);
  expect(document!.columns!.some(c => c.unique !== undefined && c.unique !== ''), 'Document has UQ flag on a column').toBe(true);

  // A table without FKs has empty fks array (not undefined)
  const noFkTable = model.nodes.find(n => n.type === 'table' && n.fks !== undefined && n.fks.length === 0);
  expect(!!noFkTable, 'Table with no FKs has empty fks array').toBe(true);

  // Phase 2 (extractDacpacFiltered): FK constraints must survive schema filtering.
  const buffer2 = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { elements } = await extractSchemaPreview(buffer2);
  const filteredModel = extractDacpacFiltered(elements, new Set(['HumanResources', 'Person']));
  const empFiltered = filteredModel.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  expect(!!empFiltered, 'Phase 2: HumanResources.Employee found after schema filter').toBe(true);
  expect((empFiltered?.fks?.length ?? 0) > 0, 'Phase 2: Employee has FK constraints (not dropped by filter)').toBe(true);
  const addrFiltered = filteredModel.nodes.find(n => n.schema === 'Person' && n.name === 'Address');
  expect(!!addrFiltered, 'Phase 2: Person.Address found after schema filter').toBe(true);
  expect((addrFiltered?.fks?.length ?? 0) > 0, 'Phase 2: Person.Address has FK constraints (not dropped by filter)').toBe(true);

  // SDK-style dacpac: no constraints extracted (Fabric DW has no FK/UQ/CK)
  const fabricPath = testPath('AdventureWorks_sdk-style.dacpac');
  const fabricBuf = readFileSync(fabricPath);
  const fabricModel = await extractDacpac(fabricBuf);
  const fabricTable = fabricModel.nodes.find(n => n.type === 'table');
  expect(!!fabricTable, 'SDK-style dacpac has at least one table').toBe(true);
  expect(fabricTable?.columns !== undefined, 'SDK-style table has columns').toBe(true);
}

// ─── parseDspPlatform — all known DSP substrings ─────────────────────────────

function testParseDspPlatform() {
  console.log('\n── parseDspPlatform ──');

  // Empty / falsy inputs
  expect(parseDspPlatform(''), 'Empty string returns empty').toBe('');

  // Cloud platforms — must match before on-prem version strings
  expect(parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlDwUnifiedDatabaseSchemaProvider'), 'SqlDwUnified → Fabric Data Warehouse').toBe('Fabric Data Warehouse');
  expect(parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlDbFabricDatabaseSchemaProvider'), 'SqlDbFabric → SQL Database in Fabric').toBe('SQL Database in Fabric');
  expect(parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlDwDatabaseSchemaProvider'), 'SqlDwDatabase → Synapse Dedicated Pool').toBe('Synapse Dedicated Pool');
  expect(parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlManagedInstanceDatabaseSchemaProvider'), 'SqlManagedInstance → Azure SQL Managed Instance').toBe('Azure SQL Managed Instance');
  expect(parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlHyperscaleDatabaseSchemaProvider'), 'SqlHyperscale → Azure SQL Hyperscale').toBe('Azure SQL Hyperscale');
  expect(parseDspPlatform('Microsoft.Data.Tools.Schema.Sql.SqlAzureV12DatabaseSchemaProvider'), 'SqlAzureV12 → Azure SQL Database').toBe('Azure SQL Database');

  // On-prem SQL Server — representative versions (latest, middle, earliest)
  const onPremCases: [string, string][] = [
    ['Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider', 'SQL Server 2025'],
    ['Microsoft.Data.Tools.Schema.Sql.Sql130DatabaseSchemaProvider', 'SQL Server 2016'],
    ['Microsoft.Data.Tools.Schema.Sql.Sql80DatabaseSchemaProvider',  'SQL Server 2000'],
  ];
  for (const [dsp, expected] of onPremCases) {
    expect(parseDspPlatform(dsp), `${dsp.split('.').pop()} → ${expected}`).toBe(expected);
  }

  // Specificity: SqlAzureV12 must not be matched by Sql120 (they share no substring)
  expect(parseDspPlatform('SqlAzureV12DatabaseSchemaProvider'), 'Bare SqlAzureV12 still matches').toBe('Azure SQL Database');

  // Unknown provider: extract Pascal-case name from namespace
  expect(parseDspPlatform('Vendor.MyTool.Schema.SqlFutureDatabaseSchemaProvider'), 'Unknown provider: extract readable part before DatabaseSchemaProvider').toBe('SqlFuture');

  // Completely unknown — no regex match: return raw DSP
  expect(parseDspPlatform('some-unknown-provider'), 'Completely unknown: return raw string').toBe('some-unknown-provider');
}

// ─── Bridge: dbPlatform flows into DatabaseModel ─────────────────────────────

async function testDbPlatformInModel() {
  console.log('\n── Bridge: dbPlatform in DatabaseModel ──');

  // Azure SQL (classic AdventureWorks) → 'Azure SQL Database'
  const awModel = await loadAdventureWorksModel();
  expect(awModel.dbPlatform, 'AdventureWorks dacpac: dbPlatform = SQL Server 2025').toBe('SQL Server 2025');

  // Fabric (SDK-style) → 'Fabric Data Warehouse'
  const fabricBuf = readFileSync(testPath('AdventureWorks_sdk-style.dacpac'));
  const fabricModel = await extractDacpac(fabricBuf);
  expect(fabricModel.dbPlatform, 'SDK-style dacpac: dbPlatform = Fabric Data Warehouse').toBe('Fabric Data Warehouse');

  // Phase 2 (extractDacpacFiltered): dspName passed through → dbPlatform preserved
  const awBuf = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { elements, dspName } = await extractSchemaPreview(awBuf);
  expect(dspName.includes('Sql170'), `Phase 1 dspName contains Sql170 (got: "${dspName}")`).toBe(true);
  const filteredModel = extractDacpacFiltered(elements, new Set(['HumanResources', 'Person']), dspName);
  expect(filteredModel.dbPlatform, 'Phase 2 filtered model: dbPlatform preserved from dspName').toBe('SQL Server 2025');

  // Phase 2 without dspName → dbPlatform undefined (no platform info available)
  const filteredNoPlat = extractDacpacFiltered(elements, new Set(['HumanResources']));
  expect(filteredNoPlat.dbPlatform === undefined || filteredNoPlat.dbPlatform === '',
    'Phase 2 without dspName: dbPlatform absent').toBe(true);

  // Provenance is stamped, not inferred. A dacpac reports 'dacpac' whether or not it
  // resolved a platform — the previous `dbPlatform ? 'database' : 'dacpac'` heuristic in
  // tools.ts told the AI that every DSP-carrying dacpac was a live database.
  expect(awModel.source, 'Full dacpac extract: source = dacpac').toBe('dacpac');
  expect(fabricModel.source, 'SDK-style dacpac: source = dacpac').toBe('dacpac');
  expect(filteredModel.source, 'Phase 2 filtered dacpac: source = dacpac').toBe('dacpac');
  expect(filteredNoPlat.source,
    'Phase 2 dacpac without platform: source still dacpac, not inferred from dbPlatform').toBe('dacpac');
}

// ─── Bridge: pkOrdinal flows into ColumnDef ──────────────────────────────────

async function testPkOrdinalInModel() {
  console.log('\n── Bridge: pkOrdinal in ColumnDef ──');
  const model = await loadAdventureWorksModel();

  // HumanResources.Employee: single-column PK (BusinessEntityID)
  const employee = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  expect(employee !== undefined, 'HumanResources.Employee found').toBe(true);
  const beid = employee!.columns?.find(c => c.name === 'BusinessEntityID');
  expect(beid !== undefined, 'BusinessEntityID column found').toBe(true);
  expect(beid!.pkOrdinal, 'BusinessEntityID: pkOrdinal = 1 (single PK)').toBe(1);

  // Non-PK column on the same table has no pkOrdinal
  const natId = employee!.columns?.find(c => c.name === 'NationalIDNumber');
  expect(natId !== undefined, 'NationalIDNumber column found').toBe(true);
  expect(natId!.pkOrdinal === undefined, 'NationalIDNumber: no pkOrdinal (not a PK column)').toBe(true);

  // Composite PK table: find any table with 2+ pkOrdinal columns
  const compositePkTable = model.nodes.find(n =>
    n.type === 'table' &&
    n.columns !== undefined &&
    n.columns.filter(c => c.pkOrdinal !== undefined).length >= 2,
  );
  expect(compositePkTable !== undefined, 'At least one table with composite PK found').toBe(true);
  const pkCols = compositePkTable!.columns!.filter(c => c.pkOrdinal !== undefined);
  const ordinals = pkCols.map(c => c.pkOrdinal!).sort((a, b) => a - b);
  expect(ordinals[0], `Composite PK: first ordinal is 1 (table: ${compositePkTable!.name})`).toBe(1);
  expect(ordinals[1], `Composite PK: second ordinal is 2 (table: ${compositePkTable!.name})`).toBe(2);
  expect(ordinals.every((v, i) => v === i + 1), 'Composite PK: ordinals are 1-based and sequential').toBe(true);

  // Views never have PK constraints — verify no pkOrdinal on any view column
  const anyView = model.nodes.find(n => n.type === 'view' && n.columns !== undefined);
  if (anyView) {
    const viewPkCols = anyView.columns!.filter(c => c.pkOrdinal !== undefined);
    expect(viewPkCols.length, `View ${anyView.name}: no pkOrdinal columns (views have no PK)`).toBe(0);
  }

  // Procedures have no columns at all — verify columns is absent/empty
  const anyProc = model.nodes.find(n => n.type === 'procedure');
  expect(anyProc !== undefined, 'At least one procedure found').toBe(true);
  const procPkCols = anyProc!.columns?.filter(c => c.pkOrdinal !== undefined) ?? [];
  expect(procPkCols.length, 'Procedure: no pkOrdinal columns').toBe(0);
}

// ─── Bridge: Phase 1 → Phase 2 sequencing ────────────────────────────────────

async function testPhase1Phase2Bridge() {
  console.log('\n── Bridge: Phase 1 → Phase 2 data flow ──');

  // Phase 1 returns elements + dspName ready for bridge caching
  const buf = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { preview, elements, dspName } = await extractSchemaPreview(buf);

  // preview is well-formed
  expect(preview.schemas.length > 0, 'Phase 1: schemas list populated').toBe(true);
  expect(preview.totalObjects > 0, 'Phase 1: totalObjects > 0').toBe(true);
  expect(typeof dspName === 'string' && dspName.length > 0, 'Phase 1: dspName is non-empty string').toBe(true);

  // elements are cached for Phase 2
  expect(Array.isArray(elements) && elements.length > 0, 'Phase 1: elements array non-empty (bridge cache)').toBe(true);

  // Phase 2 uses the cached elements — must produce same node/edge count as full extractDacpac
  const allSchemas = new Set(preview.schemas.map(s => s.name));
  const phase2Model = extractDacpacFiltered(elements, allSchemas, dspName);
  const fullModel = await loadAdventureWorksModel();

  expect(phase2Model.nodes.length,
    `Phase 2 with all schemas: same node count as full extract (${fullModel.nodes.length})`).toBe(fullModel.nodes.length);
  expect(phase2Model.edges.length,
    `Phase 2 with all schemas: same edge count as full extract (${fullModel.edges.length})`).toBe(fullModel.edges.length);
  expect(phase2Model.dbPlatform,
    'Phase 2: dbPlatform matches full extract').toBe(fullModel.dbPlatform);

  // Schema subset: Phase 2 with one schema produces fewer nodes
  const hrOnly = extractDacpacFiltered(elements, new Set(['HumanResources']), dspName);
  expect(hrOnly.nodes.length < fullModel.nodes.length,
    'Phase 2 schema subset: fewer nodes than full model').toBe(true);
  expect(hrOnly.nodes.every(n => n.schema === 'HumanResources' || n.externalType !== undefined),
    'Phase 2 schema subset: only HumanResources nodes (+ virtual externals)').toBe(true);
  expect(hrOnly.dbPlatform,
    'Phase 2 schema subset: dbPlatform still set from dspName').toBe('SQL Server 2025');

  // Phase 2 with empty schema set produces empty model (no crash)
  const emptyModel = extractDacpacFiltered(elements, new Set(), dspName);
  expect(emptyModel.nodes.length, 'Phase 2 empty schema set: 0 nodes (no crash)').toBe(0);
}

// ─── Extraction options (externalRefsEnabled / maxNodes) on the file path ────

async function testDacpacExtractionOptions() {
  console.log('\n── DACPAC Extraction Options ──');
  const buffer = await makeExternalRefDacpac();

  const enabled = await extractDacpac(buffer, undefined, undefined, { externalRefsEnabled: true, maxNodes: 2 });
  expect(enabled.nodes.some(n => n.type === 'external' && n.externalType === 'file'),
    'Full extract: externalRefsEnabled=true creates virtual file node').toBe(true);

  const disabled = await extractDacpac(buffer, undefined, undefined, { externalRefsEnabled: false, maxNodes: 2 });
  expect(!disabled.nodes.some(n => n.type === 'external' && n.externalType === 'file'),
    'Full extract: externalRefsEnabled=false suppresses virtual file node').toBe(true);

  const capped = await extractDacpac(buffer, undefined, undefined, { externalRefsEnabled: true, maxNodes: 1 });
  expect(!capped.nodes.some(n => n.type === 'external' && n.externalType === 'file'),
    'Full extract: maxNodes caps virtual file nodes').toBe(true);

  const { elements, dspName } = await extractSchemaPreview(buffer);
  const filteredEnabled = extractDacpacFiltered(elements, new Set(['dbo']), dspName, undefined, undefined, {
    externalRefsEnabled: true,
    maxNodes: 2,
  });
  expect(filteredEnabled.nodes.some(n => n.type === 'external' && n.externalType === 'file'),
    'Filtered extract: externalRefsEnabled=true creates virtual file node').toBe(true);

  const filteredDisabled = extractDacpacFiltered(elements, new Set(['dbo']), dspName, undefined, undefined, {
    externalRefsEnabled: false,
    maxNodes: 2,
  });
  expect(!filteredDisabled.nodes.some(n => n.type === 'external' && n.externalType === 'file'),
    'Filtered extract: externalRefsEnabled=false suppresses virtual file node').toBe(true);
}

// ─── Full-catalog (allObjects) resolution under a schema filter ─────────────

/**
 * Covers the `allObjects`-defined branch of `buildModel` — `buildCatalog(allObjects ?? objects)`
 * and `buildFullCatalog(allObjects)`.
 *
 * The DMV lane does not supply `allObjects`, so the DACPAC lane is the only producer of a catalog
 * wider than the rendered node set — this is the sole coverage for that branch. Asserts that an
 * object outside the selected schemas is still resolvable for display and still reachable
 * through `neighborIndex`, without being rendered as a node.
 */
async function testCrossSchemaCatalogUnderFilter() {
  console.log('\n── Full catalog resolution under schema filter ──');

  const buf = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  const { elements } = await extractSchemaPreview(buf);
  const model = extractDacpacFiltered(elements, new Set(['HumanResources']));

  // Only the selected schema is rendered.
  expect(model.nodes.length > 0, 'Filtered model has nodes').toBe(true);
  expect(model.nodes.every(n => n.schema === 'HumanResources'),
    'Only HumanResources nodes rendered').toBe(true);

  // The catalog is a strict superset — it retains objects the filter excluded.
  const renderedIds = new Set(model.nodes.map(n => n.id));
  const outOfFilter = Object.entries(model.catalog).filter(([id]) => !renderedIds.has(id));
  expect(outOfFilter.length > 0,
    `Catalog retains objects outside the filter (got ${outOfFilter.length})`).toBe(true);

  // Those entries carry catalog-original casing and a real type — this is what the
  // dependency details panel renders, so a lowercased or untyped entry is a user-visible bug.
  const [, sampleEntry] = outOfFilter[0];
  expect(typeof sampleEntry.schema === 'string' && sampleEntry.schema.length > 0,
    `Out-of-filter catalog entry has a schema (got: ${JSON.stringify(sampleEntry.schema)})`).toBe(true);
  expect(typeof sampleEntry.name === 'string' && sampleEntry.name.length > 0,
    `Out-of-filter catalog entry has a name (got: ${JSON.stringify(sampleEntry.name)})`).toBe(true);
  expect(['table', 'view', 'procedure', 'function', 'external'].includes(sampleEntry.type),
    `Out-of-filter catalog entry has a valid type (got: ${sampleEntry.type})`).toBe(true);
  expect(outOfFilter.some(([, e]) => e.schema !== e.schema.toLowerCase()),
    'At least one out-of-filter entry preserves mixed-case schema/name from the catalog').toBe(true);

  // A cross-schema reference stays reachable through neighborIndex even though the
  // referenced object is not rendered, and the reverse mapping is present.
  const crossRefs = Object.entries(model.neighborIndex)
    .filter(([id]) => renderedIds.has(id))
    .flatMap(([id, nb]) => nb.out.filter(t => !renderedIds.has(t)).map(t => [id, t] as const));
  expect(crossRefs.length > 0,
    `Rendered nodes keep out-edges to out-of-filter objects (got ${crossRefs.length})`).toBe(true);

  const [sourceId, targetId] = crossRefs[0];
  expect(model.catalog[targetId] !== undefined,
    `Out-of-filter neighbor ${targetId} is resolvable in the catalog`).toBe(true);
  expect(model.neighborIndex[targetId]?.in.includes(sourceId),
    `Reverse neighbor entry: ${targetId}.in includes ${sourceId}`).toBe(true);
}

// ─── Run all tests ──────────────────────────────────────────────────────────

  it('extracts the AdventureWorks model', async () => { await testExtraction(); });
  it('derives the expected edges for named AdventureWorks procedures', async () => {
    await testNamedProcedureEdges();
  });
  it('preserves edge integrity', async () => {
    await testEdgeIntegrity(await loadAdventureWorksModel());
  });
  it('extracts Fabric DACPACs', testFabricDacpac);
  it('handles numeric XML entities safely', testNumericEntitySecurity);
  it('reports import errors', testImportErrorHandling);
  it('extracts constraints', testConstraints);
  it('maps DSP platforms', testParseDspPlatform);
  it('records database platforms in the model', testDbPlatformInModel);
  it('records primary-key ordinals', testPkOrdinalInModel);
  it('bridges phase-one and phase-two extraction', testPhase1Phase2Bridge);
  it('retains the cross-schema catalog under filtering', testCrossSchemaCatalogUnderFilter);
  it('honors DACPAC extraction options', testDacpacExtractionOptions);

  // Node pools file reads up to 32KB, so `readFile` on a small dacpac returns a view at a nonzero
  // offset into a 64KB buffer. Passing `.buffer` there yields unrelated bytes and a bogus
  // "corrupted or truncated" error. The offset is built explicitly because the pooled offset is
  // allocation-order dependent, which made the same defect an intermittent suite failure.
  it('extracts from a byte view at a nonzero offset', async () => {
    const file = readFileSync(testPath('AdventureWorks_sdk-style.dacpac'));
    const padded = new Uint8Array(64 * 1024);
    padded.set(file, 104);
    const model = await extractDacpac(padded.subarray(104, 104 + file.length));
    expect(model.nodes.length > 0, `Offset view extracts ${model.nodes.length} nodes`).toBe(true);
  });
});
