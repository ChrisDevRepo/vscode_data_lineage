import { beforeAll, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import type { ExtractedObject } from '../../../src/engine/types';
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => loadParseRules());

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
