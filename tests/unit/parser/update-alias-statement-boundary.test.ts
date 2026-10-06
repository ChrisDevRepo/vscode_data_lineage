import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import type { ExtractedObject } from '../../../src/engine/types';
import { loadRules, parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules, rootPath } from '../helpers/testUtils';

beforeAll(() => loadParseRules());
afterAll(() => loadParseRules());

it('resolves independent update aliases without optional semicolons', () => {
  const parsed = parseSqlBody(`UPDATE t SET Value=1 FROM dbo.FirstTable t
UPDATE t SET Value=2 FROM dbo.SecondTable t`);
  expect(parsed.targets).toEqual(expect.arrayContaining(['[dbo].[firsttable]', '[dbo].[secondtable]']));
});

it('keeps both procedure write edges when catalog dependencies are unavailable', () => {
  const objects: ExtractedObject[] = [
    { fullName: 'dbo.FirstTable', type: 'table' },
    { fullName: 'dbo.SecondTable', type: 'table' },
    { fullName: 'dbo.Writer', type: 'procedure', bodyScript: 'UPDATE t SET Value=1 FROM dbo.FirstTable t\nUPDATE t SET Value=2 FROM dbo.SecondTable t' },
  ];
  const model = buildModel(objects, [], objects);
  expect(model.edges.map(edge => [edge.source, edge.target])).toEqual(expect.arrayContaining([
    ['[dbo].[writer]', '[dbo].[firsttable]'],
    ['[dbo].[writer]', '[dbo].[secondtable]'],
  ]));
});

it.each([false, true])('ignores nested and quoted statement words (CS=%s)', cs => {
  const parsed = parseSqlBody(`UPDATE t SET Value=1 FROM dbo.FirstTable t WHERE t.Value=(SELECT MAX(Value) FROM dbo.Source) AND t.Value <> 'UPDATE x FROM dbo.False x' /* UPDATE z FROM dbo.False z */
UPDATE t SET Value=2 FROM dbo.SecondTable t`, undefined, cs);
  expect(parsed.targets).toEqual(cs ? ['[dbo].[FirstTable]', '[dbo].[SecondTable]'] : ['[dbo].[firsttable]', '[dbo].[secondtable]']);
});

it.each([false, true])('later SELECT aliases do not obscure the UPDATE target (CS=%s)', cs => {
  const parsed = parseSqlBody('UPDATE t SET Value=1 FROM dbo.FirstTable t\nSELECT t.Value FROM dbo.SecondTable t', undefined, cs);
  expect(parsed.targets).toEqual([cs ? '[dbo].[FirstTable]' : '[dbo].[firsttable]']);
});

it('does not invent an unresolved alias target at an unterminated expression', () => {
  expect(parseSqlBody('UPDATE absent SET Value=(SELECT 1 FROM dbo.FirstTable t').targets).toEqual([]);
});

const qualified = (name: string, cs: boolean) => cs ? `[dbo].[${name}]` : `[dbo].[${name.toLowerCase()}]`;

it.each([false, true])('keeps the UPDATE write when a nested JOIN reuses the alias (CS=%s)', cs => {
  const parsed = parseSqlBody('UPDATE a SET col = 1 FROM dbo.Target a JOIN (SELECT id FROM dbo.Other a) s ON s.id = a.id', undefined, cs);
  expect(parsed.targets).toEqual([qualified('Target', cs)]);
  expect(parsed.sources).toEqual(expect.arrayContaining([qualified('Other', cs)]));
});

it.each([false, true])('keeps the UPDATE write when an EXISTS subquery reuses the alias (CS=%s)', cs => {
  const parsed = parseSqlBody('UPDATE a SET col = 1 FROM dbo.Target a WHERE EXISTS (SELECT 1 FROM dbo.Other a)', undefined, cs);
  expect(parsed.targets).toEqual([qualified('Target', cs)]);
  expect(parsed.sources).toEqual(expect.arrayContaining([qualified('Other', cs)]));
});

it.each([false, true])('drops the UPDATE write when two depth-0 bindings share the alias (CS=%s)', cs => {
  const parsed = parseSqlBody('UPDATE a SET col = 1 FROM dbo.Target a JOIN dbo.Other a', undefined, cs);
  expect(parsed.targets).toEqual([]);
  expect(parsed.sources).toEqual(expect.arrayContaining([qualified('Target', cs), qualified('Other', cs)]));
});

it('keeps the procedure write edge when a nested JOIN reuses the UPDATE alias', () => {
  const objects: ExtractedObject[] = [
    { fullName: 'dbo.Target', type: 'table' },
    { fullName: 'dbo.Other', type: 'table' },
    { fullName: 'dbo.Writer', type: 'procedure', bodyScript: 'UPDATE a SET col = 1 FROM dbo.Target a JOIN (SELECT id FROM dbo.Other a) s ON s.id = a.id' },
  ];
  const model = buildModel(objects, [], objects);
  expect(model.edges.map(edge => [edge.source, edge.target])).toEqual(expect.arrayContaining([
    ['[dbo].[writer]', '[dbo].[target]'],
    ['[dbo].[other]', '[dbo].[writer]'],
  ]));
});

it.each([
  'UPDATE Target SET col = 1 FROM dbo.Target INNER JOIN dbo.Other ON Other.id = Target.id',
  'UPDATE Target SET col = 1 FROM dbo.Target LEFT OUTER JOIN dbo.Other o ON o.id = Target.id',
  'UPDATE Target SET col = 1 FROM dbo.Target CROSS APPLY dbo.Other(Target.id) f',
])('resolves an unaliased UPDATE table followed by a join keyword: %s', sql => {
  expect(parseSqlBody(sql).targets).toEqual(['[dbo].[target]']);
});

it('keeps a bracketed reserved word as an UPDATE alias', () => {
  expect(parseSqlBody('UPDATE [left] SET col = 1 FROM dbo.Target [left] JOIN dbo.Other o ON o.id = [left].id').targets)
    .toEqual(['[dbo].[target]']);
});

it('resolves the alias under a custom rule file that keeps the 1.2.3 pattern, whose capture is the FROM table', () => {
  const config = yaml.load(readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8')) as { rules: Array<{ name: string; pattern: string }> };
  const rule = config.rules.find(candidate => candidate.name === 'extract_update_alias_target')!;
  rule.pattern = '\\bUPDATE\\s+(?!\\[?[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*\\]?\\s*\\.)\\[?[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*\\]?\\s+SET\\b(?:(?!\\bFROM\\b|\\bSELECT\\b)[^;]){0,3000}?\\bFROM\\s+((?:(?:\\[(?:[^\\]]|\\]\\])+\\]|[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*)\\.)*(?:\\[(?:[^\\]]|\\]\\])+\\]|[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*))(?:(?<=\\])(?![\\].])|(?=$|[\\s,;()]))';
  expect(loadRules(config).errors).toEqual([]);
  try {
    expect(parseSqlBody('UPDATE t SET t.Value = s.Value FROM dbo.Source s JOIN dbo.Target t ON t.Id = s.Id').targets)
      .toEqual(['[dbo].[target]']);
  } finally {
    loadParseRules();
  }
});
