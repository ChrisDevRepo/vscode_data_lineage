/** Supported parser/model corrections found by independent production review; no schema inference. */
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { extractExternalRefs, loadRules, parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { SQL_CODE, SQL_LINE_COMMENT, sqlCommentMask } from '../../../src/engine/shared/sqlSpans';
import { searchBodyScripts } from '../../../src/utils/modelSearch';
import { loadParseRules, rootPath } from '../helpers/testUtils';

beforeEach(() => { loadParseRules(); });
afterEach(() => { loadParseRules(); });

const subject = 'gen.Subject';
const key = (name: string, cs: boolean) => name.split('.').map(part => `[${cs ? part : part.toLowerCase()}]`).join('.');
const edge = (source: string, target: string, cs: boolean, removal = false) => ({ source: key(source, cs), target: key(target, cs), type: 'body', ...(removal ? { deleteOnly: true } : {}) });
const sorted = <T>(items: T[]) => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function graph(sql: string, tables: string[], metadata: string[], cs: boolean, currentDatabase = 'LocalDb') {
  const objects = [
    { fullName: subject, type: 'procedure' as const, bodyScript: sql },
    ...tables.map(fullName => ({ fullName, type: 'table' as const })),
  ];
  return sorted(buildModel(objects, metadata.map(targetName => ({ sourceName: subject, targetName })), objects, currentDatabase, true, undefined, cs).edges.map(({ source, target, type, deleteOnly }) => ({ source, target, type, ...(deleteOnly ? { deleteOnly: true } : {}) })));
}
function configuredRules() {
  return yaml.load(readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf8')) as { rules: Array<Record<string, unknown>> };
}

describe.each([false, true])('supported physical mutations preserve catalog identity (CS=%s)', cs => {
  it.each([
    ['UPDATE', '[@warehouse].[Target]', ' SET ID=1', 'write'],
    ['DELETE FROM', '[@warehouse].[Target]', '', 'delete'],
    ['UPDATE', '"@warehouse"."Target"', ' SET ID=1', 'write'],
    ['DELETE FROM', '"@warehouse"."Target"', '', 'delete'],
  ])('keeps a delimited schema beginning with @: %s %s', (verb, reference, suffix, kind) => {
    const sql = `${verb} ${reference}${suffix};`;
    expect(parseSqlBody(sql, undefined, cs).mutations).toEqual([{ parts: ['@warehouse', 'Target'], kind }]);
    expect(graph(sql, ['[@warehouse].[Target]'], ['[@warehouse].[Target]'], cs)).toEqual([
      edge(subject, '@warehouse.Target', cs, kind === 'delete'),
    ]);
  });

  it('excludes actual table variables while retaining a qualified object beginning with @', () => {
    const sql = 'DECLARE @rows TABLE(ID int); UPDATE @rows SET ID=1; DELETE FROM @rows; UPDATE dbo.[@Target] SET ID=1;';
    expect(parseSqlBody(sql, undefined, cs).mutations).toEqual([{ parts: ['dbo', '@Target'], kind: 'write' }]);
  });

  it.each([' ', ' /* action */ ', '\r\n'])('does not interpret a MERGE action followed by OUTPUT as deletion of a catalog table (%j)', gap => {
    const sql = `MERGE dbo.TargetC AS t USING dbo.Source AS s ON t.ID=s.ID WHEN MATCHED THEN${gap}DELETE OUTPUT $action; SELECT ID FROM dbo.[OUTPUT];`;
    expect(parseSqlBody(sql, undefined, cs).mutations).toEqual([{ parts: ['dbo', 'TargetC'], kind: 'write' }]);
    expect(graph(sql, ['dbo.TargetC', 'dbo.Source', 'dbo.[OUTPUT]'], ['dbo.TargetC', 'dbo.[OUTPUT]'], cs)).toEqual(sorted([
      edge(subject, 'dbo.TargetC', cs), edge('dbo.Source', subject, cs), edge('dbo.OUTPUT', subject, cs),
    ]));
  });

  it('still captures a real delimited OUTPUT-named table mutation', () => {
    expect(parseSqlBody('DELETE FROM dbo.[OUTPUT];', undefined, cs).mutations).toEqual([{ parts: ['dbo', 'OUTPUT'], kind: 'delete' }]);
  });

  it('retains OUTPUT as a target alias bound to a qualified table', () => {
    expect(parseSqlBody('DELETE OUTPUT FROM dbo.TargetC AS OUTPUT;', undefined, cs).mutations).toEqual([{ parts: ['dbo', 'TargetC'], kind: 'delete' }]);
  });

  it('retains a separate DELETE after a Unicode alias ending in THEN', () => {
    const sql = 'SELECT ID FROM dbo.Source AS αTHEN\nDELETE FROM dbo.TargetC;';
    expect(parseSqlBody(sql, undefined, cs).mutations).toEqual([{ parts: ['dbo', 'TargetC'], kind: 'delete' }]);
    expect(graph(sql, ['dbo.Source', 'dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual(sorted([
      edge('dbo.Source', subject, cs), edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs, true),
    ]));
  });

  it.each([
    'SELECT ID FROM dbo.TargetC; -- UPDATE dbo.TargetC SET ID=1;',
    'SELECT ID FROM dbo.TargetC; /* outer /* DELETE FROM dbo.TargetC */ INSERT INTO dbo.TargetC VALUES(1); */',
    "SELECT N'UPDATE dbo.TargetC SET ID=1; DELETE FROM dbo.TargetC;' AS note, ID FROM dbo.TargetC;",
  ])('keeps inert SQL from making a real read into a write: %s', sql => {
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual([edge('dbo.TargetC', subject, cs)]);
  });

  it('keeps real row removal distinct from commented data production', () => {
    const sql = 'DELETE FROM dbo.TargetC; /* INSERT INTO dbo.TargetC(ID) VALUES(1); */';
    expect(parseSqlBody(sql).targets).toEqual([]);
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual(sorted([edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs, true)]));
  });

  it.each(['DELETE FROM "dbo"."TargetC";', 'TRUNCATE TABLE "dbo"."TargetC";'])('marks real quoted row removal: %s', sql => {
    const reads = sql.startsWith('DELETE') ? [edge('dbo.TargetC', subject, cs)] : [];
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual(sorted([...reads, edge(subject, 'dbo.TargetC', cs, true)]));
  });

  it.each(['DELETE victim', 'UPDATE victim SET ID=1'])('binds a qualified FROM target without mutating an alias-name catalog twin: %s', command => {
    const sql = `${command} FROM dbo.TargetC AS victim JOIN dbo.victim AS other ON other.ID=victim.ID;`;
    expect(graph(sql, ['dbo.TargetC', 'dbo.victim'], ['dbo.TargetC', 'dbo.victim'], cs)).toEqual(sorted([
      edge('dbo.TargetC', subject, cs), edge('dbo.victim', subject, cs), edge(subject, 'dbo.TargetC', cs, command.startsWith('DELETE')),
    ]));
  });

  it('keeps a qualified remote read separate from same-named local removal', () => {
    const sql = 'DELETE FROM dbo.TargetC; SELECT ID FROM ArchiveDb.dbo.TargetC;';
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC', 'ArchiveDb.dbo.TargetC'], cs)).toEqual(sorted([
      edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs, true), edge('ArchiveDb.dbo.TargetC', subject, cs),
    ]));
  });

  it('retains removal metadata after an explicitly current-database reference becomes local', () => {
    expect(graph('DELETE FROM dbo.TargetC;', ['dbo.TargetC'], ['LocalDb.dbo.TargetC'], cs)).toEqual(sorted([
      edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs, true),
    ]));
  });

  it('records both removal and data production for DELETE OUTPUT INTO', () => {
    const sql = 'DELETE FROM dbo.TargetC OUTPUT deleted.ID INTO dbo.Archive(ID);';
    expect(parseSqlBody(sql, undefined, cs).targets).toEqual([key('dbo.Archive', cs)]);
    expect(parseSqlBody(sql, undefined, cs)).toHaveProperty('mutations', [
      { parts: ['dbo', 'TargetC'], kind: 'delete' }, { parts: ['dbo', 'Archive'], kind: 'write' },
    ]);
    expect(graph(sql, ['dbo.TargetC', 'dbo.Archive'], ['dbo.TargetC', 'dbo.Archive'], cs)).toEqual(sorted([
      edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs, true), edge(subject, 'dbo.Archive', cs),
    ]));
  });

  it('preserves native mutation direction when configured target extraction is disabled', () => {
    const rules = configuredRules();
    for (const rule of rules.rules) if (rule.category === 'target') rule.enabled = false;
    expect(loadRules(rules).errors).toEqual([]);
    const sql = 'UPDATE dbo.TargetC SET ID=1;';
    expect(parseSqlBody(sql).targets).toEqual([]);
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual([edge(subject, 'dbo.TargetC', cs)]);
  });

  it('preserves configured dependencies while capturing physical removal before custom rewrite', () => {
    const rules = configuredRules();
    rules.rules.push({ name: 'review_delete_as_select', enabled: true, priority: 2, category: 'preprocessing', pattern: '\\bDELETE\\s+FROM\\s+', flags: 'gi', replacement: 'SELECT * FROM ', description: 'Configured dependency rewrite; physical SQL remains DELETE.' });
    expect(loadRules(rules).errors).toEqual([]);
    const sql = 'DELETE FROM dbo.TargetC;';
    expect(parseSqlBody(sql, undefined, cs).sources).toEqual([key('dbo.TargetC', cs)]);
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual(sorted([
      edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs, true),
    ]));
  });

  it('preserves custom configured target meaning independently of physical mutations', () => {
    const rules = configuredRules();
    rules.rules.push({ name: 'review_select_target', enabled: true, priority: 80, category: 'target', pattern: '\\bFROM\\s+(dbo\\.TargetC)', flags: 'gi', description: 'User-configured target classification.' });
    expect(loadRules(rules).errors).toEqual([]);
    const sql = 'SELECT ID FROM dbo.TargetC;';
    expect(parseSqlBody(sql, undefined, cs).targets).toEqual([key('dbo.TargetC', cs)]);
    expect(parseSqlBody(sql, undefined, cs)).toHaveProperty('mutations', []);
    expect(graph(sql, ['dbo.TargetC'], ['dbo.TargetC'], cs)).toEqual(sorted([edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs)]));
  });

  it('does not infer an omitted schema or write a distinct local schema/object', () => {
    // db..object is explicitly outside the supported binding scope; protect the qualified decoy read.
    const sql = 'DELETE ArchiveDb..TargetC; SELECT ID FROM ArchiveDb.TargetC;';
    expect(graph(sql, ['ArchiveDb.TargetC'], ['ArchiveDb.TargetC'], cs)).toEqual([edge('ArchiveDb.TargetC', subject, cs)]);
  });

  it.each(['[dot..schema].[Target.part]', '"dot..schema"."Target.part"'])('keeps literal dots inside a complete qualified mutation name: %s', reference => {
    const sql = `UPDATE ${reference} SET ID=1;`;
    const target = '[dot..schema].[Target.part]';
    const objects = [{ fullName: subject, type: 'procedure' as const, bodyScript: sql }, { fullName: target, type: 'table' as const }];
    const model = buildModel(objects, [{ sourceName: subject, targetName: target }], objects, 'LocalDb', true, undefined, cs);
    expect(model.edges).toEqual([{ source: key(subject, cs), target: cs ? target : target.toLowerCase(), type: 'body' }]);
    expect(parseSqlBody(sql, undefined, cs)).toHaveProperty('mutations', [{ parts: ['dot..schema', 'Target.part'], kind: 'write' }]);
  });

  it('lets a real INSERT dominate removal only after binding the same local object', () => {
    const sql = 'DELETE FROM dbo.TargetC; INSERT INTO LocalDb.dbo.TargetC(ID) VALUES(1);';
    expect(graph(sql, ['dbo.TargetC'], ['LocalDb.dbo.TargetC'], cs)).toEqual(sorted([edge('dbo.TargetC', subject, cs), edge(subject, 'dbo.TargetC', cs)]));
  });
});

const realUrl = 'https://real.blob.core.windows.net/container/data.csv';
const fakeUrl = 'https://fake.blob.core.windows.net/container/ghost.csv';
const bulk = (url: string) => `SELECT * FROM OPENROWSET(BULK '${url}', SINGLE_CLOB) AS r;`;
it.each([`/* ${bulk(fakeUrl)} */`, `/* outer /* ${bulk(fakeUrl)} */ still comment */`, `-- ${bulk(fakeUrl)}\n`])('excludes external paths from a comment: %s', comment => {
  expect(extractExternalRefs(comment + '\n' + bulk(realUrl))).toEqual([{ url: realUrl, kind: 'openrowset' }]);
});
it.each(['\n', '\r\n', '\r'])('preserves a real external path after a line-comment terminator %j', newline => {
  expect(extractExternalRefs('-- ignored' + newline + bulk(realUrl))).toEqual([{ url: realUrl, kind: 'openrowset' }]);
});
it('keeps comment markers inside an actual external path literal', () => {
  const url = 'https://real.blob.core.windows.net/container/a/*b--c.csv';
  expect(extractExternalRefs(bulk(url))).toEqual([{ url, kind: 'openrowset' }]);
});
it.each(['\n', '\r\n', '\r'])('shares newline termination with raw DDL search for %j', newline => {
  const comment = '-- ignored', sql = comment + newline + 'SELECT Target FROM dbo.Real;';
  const mask = sqlCommentMask(sql);
  expect(Array.from(mask)).toEqual([...Array<number>(comment.length).fill(SQL_LINE_COMMENT), ...Array<number>(sql.length - comment.length).fill(SQL_CODE)]);
  const hits = searchBodyScripts([{ id: subject, schema: 'gen', name: 'Subject', type: 'procedure', bodyScript: sql }], /Target/g);
  expect(hits.map(hit => hit.commented ?? false)).toEqual([false]);
});
