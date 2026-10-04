/** Catalog fallback must compare complete mutation targets, never an identifier prefix. */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';
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
