/** Checked identifier metadata preserves case-sensitive twins; legacy and explicit CI stay canonical. */
import { describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';
import type { ExtractedObject } from '../../../src/engine/types';
const twins: ExtractedObject[]=[{fullName:'[dbo].[CaseTab]',type:'table',columns:[{name:'Upper',type:'int',nullable:'No',extra:''}]},{fullName:'[dbo].[casetab]',type:'table',columns:[{name:'lower',type:'int',nullable:'No',extra:''}]},{fullName:'[dbo].[Reader]',type:'view'}];
describe('checked identifier comparison',()=>{
 it('preserves exact CS nodes, catalog, directed dependencies and column ownership',()=>{
  const model=buildModel(twins,[{sourceName:'[dbo].[Reader]',targetName:'[dbo].[CaseTab]'},{sourceName:'[dbo].[Reader]',targetName:'[dbo].[casetab]'}],twins,undefined,true,undefined,true);
  expect(model.identifierCaseSensitive).toBe(true);
  expect(model.nodes.map(n=>n.id)).toEqual(['[dbo].[CaseTab]','[dbo].[casetab]','[dbo].[Reader]']);
  expect(Object.keys(model.catalog)).toEqual(['[dbo].[CaseTab]','[dbo].[casetab]','[dbo].[Reader]']);
  expect(model.edges.map(e=>[e.source,e.target])).toEqual([['[dbo].[CaseTab]','[dbo].[Reader]'],['[dbo].[casetab]','[dbo].[Reader]']]);
  expect(model.nodes[0].columns?.map(c=>c.name)).toEqual(['Upper']);expect(model.nodes[1].columns?.map(c=>c.name)).toEqual(['lower']);
 });
 it('default and explicit CI merge code casing as the same object',()=>{
  for(const flag of [undefined,false]){
   const model=buildModel(twins,[],twins,undefined,true,undefined,flag);
   expect(model.nodes.map(n=>n.id)).toEqual(['[dbo].[casetab]','[dbo].[reader]']);
   expect(normalizeName('[DBO].[CaseTab]')).toBe('[dbo].[casetab]');
  }
 });
 it('CS resolver accepts exact quoted identity and rejects guessed case and malformed input',()=>{
  const map=new Map([['[dbo].[CaseTab]',{}],['[dbo].[casetab]',{}]]);
  expect(resolveModelNodeId('dbo.CaseTab',map,true)).toBe('[dbo].[CaseTab]');
  expect(resolveModelNodeId('[dbo].[casetab]',map,true)).toBe('[dbo].[casetab]');
  expect(resolveModelNodeId('[DBO].[CaseTab]',map,true)).toBeNull();
  expect(resolveModelNodeId('',map,true)).toBeNull();
  expect(resolveModelNodeId('dbo.CaseTab',new Map([['[dbo].[casetab]',{}]]))).toBe('[dbo].[casetab]');
 });
});

import JSZip from 'jszip';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered, filterBySchemas } from '../../../src/engine/dacpacExtractor';
import { buildModelFromDmv, buildSchemaPreview } from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult } from '../../../src/types/mssql';
import { loadParseRules } from '../helpers/testUtils';
loadParseRules();
function rows(names:string[], values:string[][]):SimpleExecuteResult{return {columnInfo:names.map(columnName=>({columnName,dataType:'string',dataTypeName:'varchar'})),rowCount:values.length,rows:values.map(row=>row.map(displayValue=>({displayValue,isNull:displayValue===''}))) };}
function dmv(style?:string,collation='Latin1_General_100_CS_AS',platformInfo?:SimpleExecuteResult){
 return buildModelFromDmv({nodes:rows(['schema_name','object_name','type_code','body_script'],[['dbo','CaseTab','U',''],['dbo','casetab','U','']]),columns:rows(['schema_name','table_name','ordinal','column_name','type_name','max_length','precision','scale','is_nullable','is_identity','is_computed'],[['dbo','CaseTab','1','Upper','int','4','10','0','0','0','0'],['dbo','casetab','1','lower','int','4','10','0','0','0','0']]),dependencies:rows(['referencing_schema','referencing_name','referenced_schema','referenced_name'],[]),...(platformInfo?{platformInfo}:style===undefined?{}:{platformInfo:rows(['identifier_collation','identifier_comparison_style'],[[collation,style]])})});
}
it('DMV requires checked catalog comparison metadata, preserving CS metadata ownership',()=>{
 const cs=dmv('196608');expect(cs.identifierCaseSensitive).toBe(true);expect(cs.nodes.map(n=>n.id)).toEqual(['[dbo].[CaseTab]','[dbo].[casetab]']);expect(cs.nodes.map(n=>n.columns?.map(c=>c.name))).toEqual([['Upper'],['lower']]);
 for(const model of [dmv(),dmv('196609'),dmv(''),dmv('garbled'),dmv('0','')])expect(model.nodes).toHaveLength(1);
});
async function archive(rootFlag?:string,catalog?:string,azure=false,containment?:string,additionalElements=''){
 const zip=new JSZip();zip.file('model.xml',`<DataSchemaModel DspName="Microsoft.Data.Tools.Schema.Sql.${azure?'SqlAzureV12':'Sql170'}DatabaseSchemaProvider" ${rootFlag===undefined?'':`CollationCaseSensitive="${rootFlag}"`}><Model><Element Type="SqlDatabaseOptions"><Property Name="Collation" Value="Latin1_General_100_CS_AS"/>${catalog===undefined?'':`<Property Name="CatalogCollation" Value="${catalog}"/>`}${containment===undefined?'':`<Property Name="Containment" Value="${containment}"/>`}</Element><Element Type="SqlTable" Name="[dbo].[CaseTab]"/><Element Type="SqlTable" Name="[dbo].[casetab]"/>${additionalElements}</Model></DataSchemaModel>`);return zip.generateAsync({type:'uint8array'});
}
it('DACPAC checked model comparator survives full and phase-two extraction; missing/CI metadata does not infer twins',async()=>{
 const buffer=await archive('True');const model=await extractDacpac(buffer);expect(model.identifierCaseSensitive).toBe(true);expect(model.nodes.map(n=>n.id)).toEqual(['[dbo].[CaseTab]','[dbo].[casetab]']);
 const preview=await extractSchemaPreview(buffer);expect(preview.preview.totalObjects).toBe(2);expect(preview.preview.identifierCaseSensitive).toBe(true);
 expect(extractDacpacFiltered(preview.elements,new Set(['dbo']),preview.dspName,undefined,undefined,{identifierCaseSensitive:preview.identifierCaseSensitive}).nodes).toHaveLength(2);
 for(const flag of [undefined,'False','true','garbled'])expect((await extractDacpac(await archive(flag))).nodes).toHaveLength(1);
});
it('Azure DACPAC fixed CI catalog overrides CS data; unknown catalog fails closed to CI',async()=>{
 for(const catalog of [undefined,'1','2','garbled'])expect((await extractDacpac(await archive('True',catalog,true))).nodes).toHaveLength(1);
 expect((await extractDacpac(await archive('True','0',true))).nodes).toHaveLength(2);
});
it('SQL parser and body-only dependency resolution retain checked CS object spelling',()=>{
 const model=buildModel([...twins.slice(0,2),{fullName:'[dbo].[Reader]',type:'view',bodyScript:'CREATE VIEW dbo.Reader AS SELECT * FROM dbo.CaseTab UNION ALL SELECT * FROM dbo.casetab'}],[],twins,undefined,true,undefined,true);
 expect(model.edges.map(e=>[e.source,e.target])).toEqual([['[dbo].[CaseTab]','[dbo].[Reader]'],['[dbo].[casetab]','[dbo].[Reader]']]);
});

it('DMV schema preview separates CS schema twins only with checked catalog metadata',()=>{
 const result=rows(['schema_name','type_code','object_count'],[['Sales','U','1'],['sales','U','2']]);
 expect(buildSchemaPreview(result).schemas).toHaveLength(1);
 const platform=rows(['identifier_collation','identifier_comparison_style'],[['Latin1_General_100_CS_AS','196608']]);
 expect(buildSchemaPreview(result,platform).schemas.map(s=>s.name)).toEqual(['sales','Sales']);
 expect(buildSchemaPreview(result,platform).identifierCaseSensitive).toBe(true);
 expect(buildSchemaPreview(result).identifierCaseSensitive).not.toBe(true);
});
it('CS procedure metadata does not turn the read twin into a write through case-insensitive fallback',()=>{
 const model=buildModel([...twins.slice(0,2),{fullName:'[dbo].[Writer]',type:'procedure',bodyScript:'insert into dbo.CaseTab (Upper) select lower from dbo.casetab'}],[{sourceName:'[dbo].[Writer]',targetName:'[dbo].[CaseTab]'},{sourceName:'[dbo].[Writer]',targetName:'[dbo].[casetab]'}],twins,undefined,true,undefined,true);
 expect(model.edges.some(e=>e.source==='[dbo].[Writer]'&&e.target==='[dbo].[casetab]')).toBe(false);
 expect(model.edges.some(e=>e.source==='[dbo].[casetab]'&&e.target==='[dbo].[Writer]')).toBe(true);
 expect(model.edges.some(e=>e.source==='[dbo].[Writer]'&&e.target==='[dbo].[CaseTab]')).toBe(true);
});

it('CS resolver preserves emitted canonical identities with literal closing brackets',()=>{
 const canonical='[we]]ird].[t]]x]';const nodes=new Map([[canonical,{}]]);
 expect(resolveModelNodeId(canonical,nodes,true)).toBe(canonical);
 expect(resolveModelNodeId('[we]]ird].[t]]x]',nodes,true)).toBe(canonical);
});
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { normalizeColName } from '../../../src/utils/sql';
it('checked CS CTE aliases keep distinct update targets while SQL keywords remain case insensitive',()=>{
 const sql='with c as (select * from dbo.CaseTab), C as (select * from dbo.casetab) update c set x=1';
 expect(parseSqlBody(sql,undefined,true).targets).toEqual(['[dbo].[CaseTab]']);
 expect(parseSqlBody(sql.replace('update c set','update C set'),undefined,true).targets).toEqual(['[dbo].[casetab]']);
});

it('default and explicit CI CTE aliases resolve capitalization variants to the existing lowercase target',()=>{
 const sql='with MixedAlias as (select * from dbo.CaseTab) update MIXEDALIAS set x=1';
 expect(parseSqlBody(sql).targets).toEqual(['[dbo].[casetab]']);
 expect(parseSqlBody(sql,undefined,false).targets).toEqual(['[dbo].[casetab]']);
});

describe.each([false, true])('DBA-style SQL under identifierCaseSensitive=%s', (cs) => {
  const key = (name: string) => normalizeName(name, cs);

  it.each([
    { raw: 'V]x', quoted: '[V]]x]' },
    { raw: 'V"x', quoted: '"V""x"' },
    { raw: 'V.x', quoted: '[V.x]' },
    { raw: 'V[x', quoted: '[V[x]' },
  ])('keeps literal delimiters in catalog column $raw', ({ raw, quoted }) => {
    const expected = cs ? raw : raw.toLowerCase();
    expect(normalizeColName(raw, cs)).toBe(expected);
    expect(normalizeColName(quoted, cs)).toBe(expected);
    const stripped = raw.replace(/[\[\]"]/g, '');
    if (stripped !== raw) expect(normalizeColName(stripped, cs)).not.toBe(expected);
  });
  const statements = [
    { name: 'JOIN with mixed keyword casing', sql: 'sElEcT s.Value fRoM Sales.Source s lEfT jOiN Sales.Target t ON s.Value=t.Value', reads: ['Sales.Source', 'Sales.Target'], writes: [], calls: [] },
    { name: 'INSERT SELECT', sql: 'iNsErT iNtO Sales.Target (Value) sElEcT Value fRoM Sales.Source', reads: ['Sales.Source'], writes: ['Sales.Target'], calls: [] },
    { name: 'UPDATE from a qualified target', sql: 'uPdAtE Sales.Target sEt Value=1', reads: [], writes: ['Sales.Target'], calls: [] },
    { name: 'MERGE USING', sql: 'mErGe iNtO Sales.Target AS t uSiNg Sales.Source AS s ON t.Value=s.Value WHEN MATCHED THEN UPDATE SET t.Value=s.Value;', reads: ['Sales.Source'], writes: ['Sales.Target'], calls: [] },
    { name: 'SELECT INTO', sql: 'sElEcT Value iNtO Sales.Target fRoM Sales.Source', reads: ['Sales.Source'], writes: ['Sales.Target'], calls: [] },
    { name: 'CTAS', sql: 'cReAtE tAbLe Sales.Target WITH (DISTRIBUTION=ROUND_ROBIN) aS sElEcT Value fRoM Sales.Source', reads: ['Sales.Source'], writes: ['Sales.Target'], calls: [] },
    { name: 'OUTPUT INTO', sql: 'uPdAtE Sales.Target SET Value=1 oUtPuT inserted.Value iNtO Sales.Audit', reads: [], writes: ['Sales.Target', 'Sales.Audit'], calls: [] },
    { name: 'EXECUTE with a return variable', sql: 'eXeCuTe @result = Sales.Callee @Value=1', reads: [], writes: [], calls: ['Sales.Callee'] },
    { name: 'APPLY and scalar function calls', sql: 'sElEcT Sales.Scalar(s.Value) fRoM Sales.Source s oUtEr aPpLy Sales.Rows(s.Value) r', reads: ['Sales.Source', 'Sales.Rows', 'Sales.Scalar'], writes: [], calls: [] },
    { name: 'DELETE retains read dependency without a column write', sql: 'dElEtE fRoM Sales.Target WHERE Value=1', reads: ['Sales.Target'], writes: [], calls: [] },
    { name: 'BULK INSERT', sql: "bUlK iNsErT Sales.Target FROM 'synthetic.csv'", reads: [], writes: ['Sales.Target'], calls: [] },
    { name: 'COPY INTO', sql: "cOpY iNtO Sales.Target FROM 'https://example.invalid/synthetic.csv'", reads: [], writes: ['Sales.Target'], calls: [] },
  ];

  it.each(statements)('$name keeps source, write and execution identities', ({ sql, reads, writes, calls }) => {
    const parsed = parseSqlBody(sql, undefined, cs);
    expect(parsed.sources.sort()).toEqual(reads.map(key).sort());
    expect(parsed.targets.sort()).toEqual(writes.map(key).sort());
    expect(parsed.execCalls.sort()).toEqual(calls.map(key).sort());
  });

  it.each(['Sales.Mixed', '[Sales].[Mixed]', '"Sales"."Mixed"', '[Sales].Mixed'])(
    'binds equivalent identifier delimiters in %s', (reference) => {
      const objects: ExtractedObject[] = [
        { fullName: '[Sales].[Mixed]', type: 'table' },
        { fullName: '[dbo].[Reader]', type: 'view', bodyScript: `sElEcT * fRoM ${reference}` },
      ];
      const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
      expect(model.edges.map(e => [e.source, e.target])).toEqual([[key('Sales.Mixed'), key('dbo.Reader')]]);
    },
  );

  it.each([{ type: 'SqlView', keyword: 'VIEW' }, { type: 'SqlProcedure', keyword: 'PROCEDURE' }])(
    'quotes escaped metadata names in synthesized $keyword SQL', async ({ type, keyword }) => {
      const fullName = '[Dirty]]Schema].[Read]]Name.v1]';
      const element = `<Element Type="${type}" Name="${fullName}"><Property Name="BodyScript"><Value><![CDATA[SELECT * FROM dbo.CaseTab]]></Value></Property></Element>`;
      const model = await extractDacpac(await archive(cs ? 'True' : 'False', undefined, false, undefined, element));
      expect(model.nodes.find(node => node.id === key(fullName))?.bodyScript).toBe(`CREATE ${keyword} ${fullName}\nAS\nSELECT * FROM dbo.CaseTab`);
      expect(model.edges.some(edge => edge.source === key('dbo.CaseTab') && edge.target === key(fullName))).toBe(true);
    },
  );

  it.each(['sales.Mixed', 'Sales.mixed', 'SALES.MIXED'])(
    'compares catalog spelling against differently cased SQL %s', (reference) => {
      const objects: ExtractedObject[] = [
        { fullName: '[Sales].[Mixed]', type: 'table' },
        { fullName: '[dbo].[Reader]', type: 'view', bodyScript: `SELECT * FROM ${reference}` },
      ];
      const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
      expect(model.edges.map(e => [e.source, e.target])).toEqual(cs ? [] : [[key('Sales.Mixed'), key('dbo.Reader')]]);
      expect(model.parseStats?.droppedRefs).toEqual(cs ? [`dbo.Reader → ${key(reference)}`] : []);
      expect(resolveModelNodeId(reference, new Map(model.nodes.map(n => [n.id, n])), cs)).toBe(cs ? null : key('Sales.Mixed'));
    },
  );

  it('preserves schema and object twins while comments and strings add no dependencies', () => {
    const references = ['Sales.Mixed', 'sales.Mixed', 'Sales.mixed'];
    const objects: ExtractedObject[] = [
      ...references.map(fullName => ({ fullName, type: 'table' as const })),
      { fullName: 'dbo.Reader', type: 'view', bodyScript: `
        -- SELECT * FROM Sales.MIXED
        SeLeCt 'FROM SALES.Mixed' AS Note FROM Sales.Mixed AS a
        /* SELECT * FROM SALES.MIXED */
        JoIn sales.Mixed AS b ON 1=1
        JoIn [Sales].[mixed] AS c ON 1=1
        WHERE a.Value = 'don''t JOIN SALES.Mixed';` },
    ];
    const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
    const expected = [...new Set(references.map(key))];
    expect(Object.keys(model.catalog).sort()).toEqual([...expected, key('dbo.Reader')].sort());
    expect(model.edges.map(e => [e.source, e.target]).sort()).toEqual(expected.map(id => [id, key('dbo.Reader')]).sort());
    expect(model.schemas.map(s => s.name).sort()).toEqual(cs ? ['Sales', 'dbo', 'sales'] : ['Sales', 'dbo']);
    expect(model.parseStats?.droppedRefs).toEqual([]);
  });

  it('uses exact CS schema selection in both initial extraction and loaded-model filters', async () => {
    const zip = new JSZip();
    zip.file('model.xml', `<DataSchemaModel DspName="Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider" CollationCaseSensitive="${cs ? 'True' : 'False'}"><Model>
      <Element Type="SqlTable" Name="[Sales].[Upper]"/><Element Type="SqlTable" Name="[sales].[Lower]"/>
    </Model></DataSchemaModel>`);
    const buffer = await zip.generateAsync({ type: 'uint8array' });
    const model = await extractDacpac(buffer);
    const preview = await extractSchemaPreview(buffer);
    const selected = new Set(['Sales']);
    const extracted = extractDacpacFiltered(preview.elements, selected, preview.dspName, undefined, undefined, { identifierCaseSensitive: preview.identifierCaseSensitive });
    const expected = (cs ? ['Sales.Upper'] : ['Sales.Upper', 'sales.Lower']).map(key).sort();
    for (const filtered of [extracted, filterBySchemas(model, selected)]) {
      expect(filtered.nodes.map(node => node.id).sort()).toEqual(expected);
      expect(Object.keys(filtered.catalog).sort()).toEqual(['Sales.Upper', 'sales.Lower'].map(key).sort());
      expect(filtered.identifierCaseSensitive === true).toBe(cs);
    }
  });

  it.each(['[Odd.Schema].[Order Part.v1]', '[Odd.Schema].[Order]]Part.v1]'])(
    'does not lose qualified identifier boundaries in %s', (fullName) => {
      const objects: ExtractedObject[] = [
        { fullName, type: 'table' },
        { fullName: 'dbo.Reader', type: 'view', bodyScript: `SELECT * FROM ${fullName}` },
      ];
      const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
      expect(model.edges.map(e => [e.source, e.target])).toEqual([[key(fullName), key('dbo.Reader')]]);
      expect(model.parseStats?.droppedRefs).toEqual([]);
    },
  );

  it('preserves escaped quotes when converting double-quoted SQL identifiers', () => {
    const objects: ExtractedObject[] = [
      { fullName: '[Sales].[Order"Part]', type: 'table' },
      { fullName: 'dbo.Reader', type: 'view', bodyScript: 'SELECT * FROM "Sales"."Order""Part"' },
    ];
    const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
    expect(model.edges.map(e => [e.source, e.target])).toEqual([[key(objects[0].fullName), key('dbo.Reader')]]);
  });

  it('keeps dotted and escaped remote names in SQL and metadata references', () => {
    const remote = '[Archive.DB].[Odd.Schema].[Order]]Part.v1]';
    for (const bodyScript of [`SELECT * FROM ${remote}`, 'SELECT 1']) {
      const objects: ExtractedObject[] = [{ fullName: 'dbo.Reader', type: 'view', bodyScript }];
      const deps = bodyScript === 'SELECT 1' ? [{ sourceName: 'dbo.Reader', targetName: remote }] : [];
      const model = buildModel(objects, deps, objects, 'CurrentDB', true, undefined, cs);
      expect(model.edges.map(e => [e.source, e.target])).toEqual([[key(remote), key('dbo.Reader')]]);
      const database = model.nodes.find(n => n.externalType === 'db')?.externalDatabase;
      expect(cs ? database : database?.toLowerCase()).toBe(cs ? 'Archive.DB' : 'archive.db');
    }
  });

  it.each(['[CurrentDB].[Sales].[Mixed]', '[CurrentDB].[sales].[mixed]'])(
    'binds current-database three-part reads and writes under source policy: %s', (reference) => {
      const objects: ExtractedObject[] = [
        { fullName: 'Sales.Mixed', type: 'table' },
        { fullName: 'dbo.Reader', type: 'view', bodyScript: `SELECT * FROM ${reference}` },
        { fullName: 'dbo.Writer', type: 'procedure', bodyScript: `INSERT INTO ${reference} (Value) VALUES (1)` },
      ];
      const model = buildModel(objects, [], objects, 'CurrentDB', true, undefined, cs);
      expect(model.edges.map(e => [e.source, e.target]).sort()).toEqual(cs && reference.includes('[sales]') ? [] : [
        [key('Sales.Mixed'), key('dbo.Reader')], [key('dbo.Writer'), key('Sales.Mixed')],
      ].sort());
      expect(model.nodes.some(node => node.type === 'external')).toBe(false);
    },
  );

  it('does not invent a loaded node or remote node for an unknown current-database object', () => {
    const objects: ExtractedObject[] = [{ fullName: 'dbo.Reader', type: 'view', bodyScript: 'SELECT * FROM CurrentDB.Sales.Unknown' }];
    const model = buildModel(objects, [], objects, 'CurrentDB', true, undefined, cs);
    expect(model.edges).toEqual([]);
    expect(model.nodes.map(node => node.id)).toEqual([key('dbo.Reader')]);
  });

  it('resolves CTE chains with mixed casing only under CI', () => {
    const sql = 'WITH Mixed AS (SELECT * FROM Sales.Source), Next AS (SELECT * FROM MIXED) UPDATE NEXT SET Value=1';
    expect(parseSqlBody(sql, undefined, cs).targets).toEqual(cs ? [] : [key('Sales.Source')]);
  });

  it('resolves equivalent quoted CTE aliases without folding exact CS casing', () => {
    const sql = 'WITH [Mixed] AS (SELECT * FROM Sales.Source) UPDATE Mixed SET Value=1';
    expect(parseSqlBody(sql, undefined, cs).targets).toEqual([key('Sales.Source')]);
  });

  it.each([
    { sql: 'UPDATE src SET Value=1 FROM Sales.Source AS SRC', target: cs ? [] : ['Sales.Source'] },
    { sql: 'UPDATE [Src] SET Value=1 FROM Sales.Source AS Src', target: ['Sales.Source'] },
    { sql: 'UPDATE t SET Value=1 FROM Sales.Source s JOIN Sales.Target t ON s.Value=t.Value', target: ['Sales.Target'] },
    { sql: 'UPDATE t SET Value=1 FROM Sales.Source JOIN Sales.Target t ON 1=1', target: ['Sales.Target'] },
    { sql: 'UPDATE Missing SET Value=1 FROM Sales.Source AS Present', target: [] },
    { sql: 'UPDATE A SET Value=1 FROM [Sales;Dept].[Source] AS A;', target: ['[Sales;Dept].[Source]'] },
    { sql: 'UPDATE A SET Value=1 FROM "Sales;Dept"."Source" AS A;', target: ['[Sales;Dept].[Source]'] },
  ])('binds UPDATE aliases using catalog policy: $sql', ({ sql, target }) => {
    expect(parseSqlBody(sql, undefined, cs).targets).toEqual(target.map(key));
  });

  it('resolves the write target after more than ten thousand UPDATE bindings', () => {
    const joins = Array.from({ length: 10_001 }, (_, index) => `JOIN Sales.Detail${index} AS d${index} ON 1=1`).join('\n');
    const parsed = parseSqlBody(`UPDATE TargetAlias SET Value=1 FROM Sales.Source AS s\n${joins}\nJOIN Sales.Target AS TargetAlias ON 1=1;`, undefined, cs);
    expect(parsed.targets).toEqual([key('Sales.Target')]);
    expect(parsed.sources).toHaveLength(10_003);
    expect(parsed.sources).toContain(key('Sales.Target'));
    expect(parseSqlBody('UPDATE TargetAlias SET Value=1 FROM Sales.Source AS s JOIN Sales.Target AS TargetAlias ON 1=1;', undefined, cs).targets).toEqual([key('Sales.Target')]);
  });

  it('keeps a dot inside a system-looking user schema as an identifier segment', () => {
    const objects: ExtractedObject[] = [
      { fullName: '[sys.Report].[Source]', type: 'table' },
      { fullName: 'dbo.Reader', type: 'view', bodyScript: 'SELECT * FROM [sys.Report].[Source]' },
    ];
    const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
    expect(model.edges.map(edge => [edge.source, edge.target])).toEqual([[key(objects[0].fullName), key('dbo.Reader')]]);
  });

  it.each(['Sys', 'tempdb'])('uses a checked CS catalog identity for system-looking user schema %s', (schema) => {
    const objects: ExtractedObject[] = [
      { fullName: `${schema}.Source`, type: 'table' },
      { fullName: 'dbo.Reader', type: 'view', bodyScript: `SELECT * FROM ${schema}.Source` },
    ];
    const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
    expect(model.edges.map(edge => [edge.source, edge.target])).toEqual(cs ? [[key(objects[0].fullName), key('dbo.Reader')]] : []);
    const filtered = buildModel(objects.slice(1), [], objects, undefined, false, undefined, cs);
    expect(filtered.neighborIndex[key('dbo.Reader')]?.in ?? []).toEqual(cs ? [key(objects[0].fullName)] : []);
  });
});

it('CS SQL escapes prevent a literal closing bracket from selecting a differently named object', () => {
  const objects: ExtractedObject[] = [
    { fullName: '[dbo].[a]]b]', type: 'table', columns: [{ name: 'First', type: 'int', nullable: 'No', extra: '' }] },
    { fullName: '[dbo].[a]]]]b]', type: 'table', columns: [{ name: 'Second', type: 'money', nullable: 'No', extra: '' }] },
    { fullName: 'dbo.Reader', type: 'view', bodyScript: 'SELECT * FROM [dbo].[a]]b]' },
  ];
  const model = buildModel(objects, [{ sourceName: 'dbo.Reader', targetName: '[dbo].[a]]]]b]' }], objects, undefined, false, undefined, true);
  expect(model.nodes.map(node => node.id)).toEqual(['[dbo].[a]]b]', '[dbo].[a]]]]b]', '[dbo].[Reader]']);
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  expect(resolveModelNodeId('[dbo].[a]]b]', nodes, true)).toBe('[dbo].[a]]b]');
  expect(resolveModelNodeId('[dbo].[a]]]]b]', nodes, true)).toBe('[dbo].[a]]]]b]');
  expect(model.edges.map(edge => edge.source).sort()).toEqual(['[dbo].[a]]b]', '[dbo].[a]]]]b]'].sort());
  expect(model.nodes[0].columns?.[0].name).toBe('First');
  expect(model.nodes[1].columns?.[0].name).toBe('Second');
});

describe('identifier comparison follows checked catalog metadata', () => {
  it.each(['196608', '196609', 'garbled'])(
    'keeps schema, table, function and column twins separate only with checked CS metadata %s', (style) => {
      const model = buildModelFromDmv({
        platformInfo: rows(['identifier_collation', 'identifier_comparison_style'], [['Latin1_General_100_CS_AS', style]]),
        nodes: rows(['schema_name', 'object_name', 'type_code', 'body_script'], [
          ['Sales', 'Source', 'U', ''], ['sales', 'source', 'U', ''],
          ['Sales', 'Read', 'IF', 'CREATE FUNCTION Sales.Read() RETURNS TABLE AS RETURN SELECT Value FROM Sales.Source'],
          ['sales', 'read', 'IF', 'CREATE FUNCTION sales.read() RETURNS TABLE AS RETURN SELECT value FROM sales.source'],
          ['dbo', 'Writer', 'P', 'INSERT INTO Sales.Source (Value) SELECT Value FROM Sales.Read() UNION ALL SELECT value FROM sales.read()'],
        ]),
        columns: rows(['schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'], [
          ['Sales', 'Source', '1', 'Value', 'int', '4', '10', '0', '0', '0', '0'],
          ['Sales', 'Source', '2', 'value', 'money', '8', '19', '4', '0', '0', '0'],
          ['sales', 'source', '1', 'value', 'varchar', '20', '0', '0', '0', '0', '0'],
          ['Sales', 'Read', '1', 'Value', 'int', '4', '10', '0', '0', '0', '0'],
          ['sales', 'read', '1', 'value', 'varchar', '20', '0', '0', '0', '0', '0', '0'],
        ]),
        dependencies: rows(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], []),
      });
      const cs = style === '196608';
      const key = (name: string) => normalizeName(name, cs);
      expect(model.nodes).toHaveLength(cs ? 5 : 3);
      expect(model.schemas.map(schema => schema.name).sort()).toEqual(cs ? ['Sales', 'dbo', 'sales'] : ['Sales', 'dbo']);
      const edges = [['Sales.Source', 'Sales.Read'], ['sales.source', 'sales.read'], ['Sales.Read', 'dbo.Writer'], ['sales.read', 'dbo.Writer'], ['dbo.Writer', 'Sales.Source']];
      expect(model.edges.map(edge => `${edge.source}→${edge.target}`).sort()).toEqual([...new Set(edges.map(([from, to]) => `${key(from)}→${key(to)}`))].sort());
      if (cs) {
        expect(model.nodes.find(node => node.id === key('Sales.Source'))?.columns?.map(column => [column.name, column.type])).toEqual([['Value', 'int'], ['value', 'money']]);
        expect(model.nodes.find(node => node.id === key('sales.source'))?.columns?.map(column => [column.name, column.type])).toEqual([['value', 'varchar(20)']]);
        expect(model.nodes.filter(node => node.type === 'function').map(node => node.columns?.[0].name)).toEqual(['Value', 'value']);
      }
    },
  );

  it.each(['-1', '1.5', 'NaN', '196608 trailing', '4294967296', '9007199254740993'])(
    'keeps legacy CI for invalid DMV comparison style %s', (style) => {
      expect(dmv(style).identifierCaseSensitive).not.toBe(true);
      expect(dmv(style).nodes).toHaveLength(1);
    },
  );

  it('does not infer catalog comparison from server or data collation fields', () => {
    const platform = rows(['database_collation', 'server_collation'], [['Latin1_General_100_CS_AS', 'Latin1_General_100_CS_AS']]);
    expect(dmv(undefined, undefined, platform).nodes).toHaveLength(1);
    expect(dmv('0', 'Latin1_General_100_BIN2').nodes).toHaveLength(2);
    expect(dmv('196609', 'Latin1_General_100_CS_AS').nodes).toHaveLength(1);
  });

  it('keeps CI when the effective catalog metadata is absent or contradictory', () => {
    for (const values of [[], [['Latin1_General_100_CS_AS', '196608'], ['Latin1_General_100_CI_AS', '196609']]]) {
      const platform = rows(['identifier_collation', 'identifier_comparison_style'], values);
      expect(dmv(undefined, undefined, platform).nodes).toHaveLength(1);
      expect(buildSchemaPreview(rows(['schema_name', 'type_code', 'object_count'], [['Sales', 'U', '1'], ['sales', 'U', '1']]), platform).schemas).toHaveLength(1);
    }
  });

  it.each([
    { containment: '0', catalog: undefined, cs: true },
    { containment: '1', catalog: undefined, cs: false },
    { containment: '1', catalog: '1', cs: false },
    { containment: 'garbled', catalog: undefined, cs: false },
  ])('uses contained DACPAC catalog comparison for $containment/$catalog', async ({ containment, catalog, cs }) => {
    const buffer = await archive('True', catalog, false, containment);
    const model = await extractDacpac(buffer);
    expect(model.nodes).toHaveLength(cs ? 2 : 1);
    const preview = await extractSchemaPreview(buffer);
    expect(extractDacpacFiltered(preview.elements, new Set(['dbo']), preview.dspName, undefined, undefined, { identifierCaseSensitive: preview.identifierCaseSensitive }).nodes).toHaveLength(cs ? 2 : 1);
  });

  it('does not allow caller options to override missing checked DACPAC metadata', async () => {
    const model = await extractDacpac(await archive(undefined, '0', true), undefined, undefined, { identifierCaseSensitive: true });
    expect(model.nodes).toHaveLength(1);
    expect(model.identifierCaseSensitive).not.toBe(true);
  });

  it('keeps CI when a DACPAC has contradictory catalog options', async () => {
    const zip = await JSZip.loadAsync(await archive('True', '0', true));
    const xml = await zip.file('model.xml')!.async('string');
    zip.file('model.xml', xml.replace('<Property Name="CatalogCollation" Value="0"/>', '<Property Name="CatalogCollation" Value="0"/><Property Name="CatalogCollation" Value="1"/>'));
    const buffer = await zip.generateAsync({ type: 'uint8array' });
    expect((await extractDacpac(buffer)).nodes).toHaveLength(1);
    expect((await extractSchemaPreview(buffer)).preview.identifierCaseSensitive).not.toBe(true);
  });
});

it.each([
  { cs: false, owner: '[dbo].[Mixed]' },
  { cs: true, owner: '[dbo].[Mixed]' },
  { cs: false, owner: '[Odd.Schema].[Order]]Part.v1]' },
  { cs: true, owner: '[Odd.Schema].[Order]]Part.v1]' },
])('DACPAC computed columns bind owner and column case under checked CS=$cs: $owner', async ({ cs, owner }) => {
  const simple = (owner: string, name: string, type: string) => `<Entry><Element Type="SqlSimpleColumn" Name="${owner}.[${name}]">
    <Relationship Name="TypeSpecifier"><Entry><Element Type="SqlTypeSpecifier">
      <Relationship Name="Type"><Entry><References ExternalSource="BuiltIns" Name="[${type}]"/></Entry></Relationship>
    </Element></Entry></Relationship></Element></Entry>`;
  const computed = (name: string, expression: string, reference: string) => `<Entry><Element Type="SqlComputedColumn" Name="${owner}.[${name}]">
    <Property Name="ExpressionScript" Value="[${expression}]"/>
    <Relationship Name="ExpressionDependencies"><Entry><References Name="${reference}"/></Entry></Relationship>
  </Element></Entry>`;
  const zip = new JSZip();
  zip.file('model.xml', `<DataSchemaModel DspName="Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider" CollationCaseSensitive="${cs ? 'True' : 'False'}"><Model>
    <Element Type="SqlTable" Name="${owner}"><Relationship Name="Columns">
      ${simple(owner, 'Value', 'int')}
      ${cs ? simple(owner, 'value', 'money') : ''}
      ${computed('Exact', 'Value', `${owner}.[Value]`)}
      ${computed('WrongColumnCase', 'VALUE', `${owner}.[VALUE]`)}
      ${computed('WrongOwnerCase', 'Value', `${owner.toUpperCase()}.[Value]`)}
      ${cs ? computed('LowerCaseTwin', 'value', `${owner}.[value]`) : ''}
    </Relationship></Element>
  </Model></DataSchemaModel>`);
  const model = await extractDacpac(await zip.generateAsync({ type: 'uint8array' }));
  const types = new Map(model.nodes[0].columns?.map(column => [column.name, column.type]));
  expect(types.get('Exact')).toBe('int');
  expect(types.get('WrongColumnCase')).toBe(cs ? '—' : 'int');
  expect(types.get('WrongOwnerCase')).toBe(cs ? '—' : 'int');
  if (cs) expect(types.get('LowerCaseTwin')).toBe('money');
});
