/** Catalog fallback must compare complete mutation targets, never an identifier prefix. */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { readFileSync } from 'fs';
import { loadParseRules, testPath } from '../helpers/testUtils';
import { quoteIdentifier } from '../../../src/utils/sql';

beforeAll(() => { loadParseRules(); });
type BuildObject = Parameters<typeof buildModel>[0][number];
const procedure = '[dbo].[Build]';
const key = (name: string, cs: boolean) => normalizeName(name, cs);

function edgesFor(body: string, names: readonly string[], cs: boolean) {
  const objects: BuildObject[] = [
    { fullName: procedure, type: 'procedure', bodyScript: body },
    ...names.map(name => ({ fullName: `[dbo].${quoteIdentifier(name)}`, type: 'table' as const })),
  ];
  return buildModel(objects, names.map(name => ({ sourceName: procedure, targetName: `[dbo].${quoteIdentifier(name)}` })), objects, undefined, false, undefined, cs)
    .edges.map(edge => [edge.source, edge.target]);
}

describe.each([false, true])('catalog write direction CS=%s', cs => {
  it.each([
    ['Foo', 'FooBar', '[dbo].[FooBar]'],
    ['Foo', 'FooBar', 'dbo.FooBar'],
    ['Foo', 'Fooé', '[dbo].[Fooé]'],
    ['Foo', 'Foo$Extra', '[dbo].[Foo$Extra]'],
    ['Foo]', 'Foo]Bar', '[dbo].[Foo]]Bar]'],
  ])('does not turn read of %s into a write to %s', (source, target, written) => {
    const edges = edgesFor(`INSERT INTO ${written} SELECT * FROM [dbo].${quoteIdentifier(source)};`, [source, target], cs);
    const focus = key(procedure, cs);
    const read = key(`[dbo].${quoteIdentifier(source)}`, cs);
    const write = key(`[dbo].${quoteIdentifier(target)}`, cs);
    expect(edges).not.toContainEqual([focus, read]);
    expect(edges).toContainEqual([read, focus]);
    expect(edges).toContainEqual([focus, write]);
  });

  it.each([
    'UPDATE Foo SET ID = 1;',
    'INSERT INTO Foo VALUES (1);',
    'DELETE FROM Foo;',
    'DELETE TOP (5) FROM Foo;',
    'DELETE TOP (5) PERCENT FROM Foo WHERE ID = 1;',
    'DELETE TOP(5)Foo;',
    'MERGE INTO Foo USING (SELECT 1 AS ID) AS s ON 1 = 0 WHEN NOT MATCHED THEN INSERT VALUES (s.ID);',
    'TRUNCATE TABLE Foo;',
    'UPDATE [Foo]]Bar] SET ID = 1;',
  ])('retains actual metadata-only write: %s', body => {
    const name = body.includes('Foo]]Bar') ? 'Foo]Bar' : 'Foo';
    const edges = edgesFor(body, [name], cs);
    expect(edges).toContainEqual([key(procedure, cs), key(`[dbo].${quoteIdentifier(name)}`, cs)]);
    expect(edges).not.toContainEqual([key(`[dbo].${quoteIdentifier(name)}`, cs), key(procedure, cs)]);
  });

  it('does not infer a write from an incomplete bracketed target', () => {
    const edges = edgesFor('UPDATE [dbo].[Foo SET ID=1;', ['Foo'], cs);
    expect(edges).not.toContainEqual([key(procedure, cs), key('[dbo].[Foo]', cs)]);
  });
  it('compares identifier case independently from keyword case', () => {
    const edges = edgesFor('uPdAtE foo SET ID=1;', ['Foo'], cs);
    if (cs) expect(edges).not.toContainEqual([procedure, '[dbo].[Foo]']);
    else expect(edges).toContainEqual([key(procedure, cs), '[dbo].[foo]']);
  });
});

describe.each([false, true])('delete-only write mark CS=%s', cs => {
  const target = key('[dbo].[Foo]', cs);
  const other = key('[dbo].[Bar]', cs);
  const build = (body: string, names: readonly string[]) => {
    const objects: BuildObject[] = [
      { fullName: procedure, type: 'procedure', bodyScript: body },
      ...names.map(name => ({ fullName: `[dbo].${quoteIdentifier(name)}`, type: 'table' as const })),
    ];
    return buildModel(objects, names.map(name => ({ sourceName: procedure, targetName: `[dbo].${quoteIdentifier(name)}` })), objects, undefined, false, undefined, cs).edges;
  };
  const writeEdge = (body: string, names: readonly string[], to: string) =>
    build(body, names).find(edge => edge.source === key(procedure, cs) && edge.target === to);

  it.each([
    'DELETE FROM [dbo].[Foo] WHERE ID < 5;',
    'DELETE [dbo].[Foo] WHERE ID < 5;',
    'TRUNCATE TABLE [dbo].[Foo];',
    'DELETE FROM [dbo].[Foo]; TRUNCATE TABLE [dbo].[Foo];',
  ])('marks a write that only removes rows: %s', body => {
    expect(writeEdge(body, ['Foo'], target)).toEqual({ source: key(procedure, cs), target, type: 'body', deleteOnly: true });
  });

  it.each([
    'DELETE FROM [dbo].[Foo]; INSERT INTO [dbo].[Foo] (ID) VALUES (1);',
    'INSERT INTO [dbo].[Foo] (ID) VALUES (1); TRUNCATE TABLE [dbo].[Foo];',
    'DELETE FROM [dbo].[Foo]; UPDATE [dbo].[Foo] SET ID = 1;',
    'MERGE INTO [dbo].[Foo] AS t USING (SELECT 1 AS ID) AS s ON t.ID = s.ID WHEN MATCHED THEN DELETE WHEN NOT MATCHED THEN INSERT (ID) VALUES (s.ID);',
    'MERGE INTO [dbo].[Foo] AS t USING (SELECT 1 AS ID) AS s ON t.ID = s.ID WHEN MATCHED THEN DELETE;',
    'TRUNCATE TABLE [dbo].[Foo]; INSERT INTO [MyDb].[dbo].[Foo] (ID) VALUES (1);',
    'TRUNCATE TABLE dbo.Foo; INSERT INTO MyDb.dbo.Foo (ID) VALUES (1);',
    'INSERT INTO [dbo].[Foo] (ID) VALUES (1);',
  ])('leaves the edge unmarked when the body also inserts, updates or merges: %s', body => {
    const edge = writeEdge(body, ['Foo'], target);
    expect(edge).toEqual({ source: key(procedure, cs), target, type: 'body' });
  });

  it('marks only the deleted table when OUTPUT INTO writes another', () => {
    const body = 'DELETE FROM [dbo].[Foo] OUTPUT deleted.ID INTO [dbo].[Bar] (ID) WHERE ID < 5;';
    expect(writeEdge(body, ['Foo', 'Bar'], target)).toMatchObject({ type: 'body', deleteOnly: true });
    expect(writeEdge(body, ['Foo', 'Bar'], other)).toEqual({ source: key(procedure, cs), target: other, type: 'body' });
  });

  it('never marks a read', () => {
    expect(build('SELECT * FROM [dbo].[Foo];', ['Foo']).some(edge => 'deleteOnly' in edge)).toBe(false);
  });

  it('keeps every edge of an archive body, the mark being the only addition', () => {
    const edges = build('INSERT INTO [dbo].[Bar] SELECT * FROM [dbo].[Foo]; DELETE FROM [dbo].[Foo];', ['Foo', 'Bar']);
    const proc = key(procedure, cs);
    expect(edges.map(({ source, target: to, type }) => `${source}>${to}:${type}`).sort()).toEqual([
      `${proc}>${other}:body`, `${proc}>${target}:body`, `${target}>${proc}:body`,
    ].sort());
    expect(edges.filter(edge => edge.deleteOnly).map(edge => `${edge.source}>${edge.target}`)).toEqual([`${proc}>${target}`]);
  });
});

it('reads and writes the table updated through a CTE that joins it to a GROUP BY derived table', () => {
  const body = readFileSync(testPath('sql', 'targeted', 'update_alias_03_cte_update.sql'), 'utf-8');
  const edges = edgesFor(body, ['Inventory', 'SalesOrderLine'], false);
  expect(edges.sort()).toEqual([['[dbo].[build]', '[dbo].[inventory]'], ['[dbo].[inventory]', '[dbo].[build]'], ['[dbo].[salesorderline]', '[dbo].[build]']]);
});
