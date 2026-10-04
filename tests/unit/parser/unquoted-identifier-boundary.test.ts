/** SQL extraction must preserve the complete regular or delimited catalog identity. */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { quoteIdentifier } from '../../../src/utils/sql';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(loadParseRules);

describe.each([false, true])('complete SQL identifiers under CS=%s', cs => {
  const key = (name: string) => normalizeName(`[dbo].${quoteIdentifier(name)}`, cs);
  it.each(['Fooé', 'Foo$Extra'])('does not fabricate a write to the prefix of %s', name => {
    const procedure = '[dbo].[Build]';
    const body = `INSERT INTO dbo.${name} SELECT * FROM [dbo].[Foo];`;
    const objects = [
      { fullName: procedure, type: 'procedure' as const, bodyScript: body },
      ...['Foo', name].map(n => ({ fullName: `[dbo].${quoteIdentifier(n)}`, type: 'table' as const })),
    ];
    const model = buildModel(objects, objects.slice(1).map(o => ({ sourceName: procedure, targetName: o.fullName })), objects, undefined, false, undefined, cs);
    const edges = model.edges.map(e => [e.source, e.target]);
    expect(edges).not.toContainEqual([key('Build'), key('Foo')]);
    expect(edges).toContainEqual([key('Foo'), key('Build')]);
    expect(edges).toContainEqual([key('Build'), key(name)]);
  });

  it.each(['Foo', 'FooBar', 'Fooé', 'Foo$Extra', 'écriture', '資料', '_Foo', 'Foo@Next', 'Foo#Next'])('preserves %s in source, target and exec extraction', name => {
    const parsed = parseSqlBody(`INSERT INTO dbo.${name} SELECT * FROM dbo.${name}; EXEC dbo.${name};`, undefined, cs);
    expect(parsed.targets).toEqual([key(name)]);
    expect(parsed.sources).toEqual([key(name)]);
    expect(parsed.execCalls).toEqual([key(name)]);
  });

  it.each(['Fooé', 'Foo$Extra', 'Foo]Bar', 'Foo With Spaces'])('preserves bracketed and escaped %s', name => {
    const qualified = `[dbo].${quoteIdentifier(name)}`;
    const parsed = parseSqlBody(`INSERT INTO ${qualified} SELECT * FROM ${qualified};`, undefined, cs);
    expect(parsed.targets).toEqual([key(name)]);
    expect(parsed.sources).toEqual([key(name)]);
  });

  it.each(['dbo.[Foo', 'dbo.9Foo', 'dbo.$Foo', 'dbo.Foo.', 'dbo.Fooé.'])('does not turn malformed identifier %s into a prefix write', name => {
    expect(parseSqlBody(`INSERT INTO ${name} VALUES (1);`, undefined, cs).targets).toEqual([]);
  });

  it('retains Unicode/$ identities through CTE aliases, UPDATE bindings and comma-join normalization', () => {
    expect(parseSqlBody('WITH c$é AS (SELECT * FROM dbo.Fooé) UPDATE c$é SET ID=1;', undefined, cs).targets).toEqual([key('Fooé')]);
    const alias = parseSqlBody('UPDATE a$é SET ID=1 FROM dbo.Fooé a$é;', undefined, cs);
    expect(alias.targets).toEqual([key('Fooé')]);
    expect(parseSqlBody('SELECT * FROM dbo.Fooé a$é, dbo.Foo$Extra b WHERE a$é.ID=b.ID;', undefined, cs).sources).toEqual([key('Fooé'), key('Foo$Extra')]);
  });
});

// Brackets finish their token without whitespace before the following SQL keyword.
describe.each([false, true])('delimited SQL token boundaries under CS=%s', cs => {
  const key = (name: string) => normalizeName(`[dbo].${quoteIdentifier(name)}`, cs);
  it('retains both sources when JOIN follows a closing bracket immediately', () => {
    expect(parseSqlBody('SELECT * FROM dbo.[Foo]JOIN dbo.[Bar] ON 1=1;', undefined, cs).sources).toEqual([key('Foo'), key('Bar')]);
  });
  it('retains a bracketed INSERT target immediately followed by VALUES', () => {
    expect(parseSqlBody('INSERT INTO dbo.[Foo]VALUES(1);', undefined, cs).targets).toEqual([key('Foo')]);
  });
  it('retains a bracketed source immediately followed by a WITH hint', () => {
    expect(parseSqlBody('SELECT * FROM dbo.[Foo]WITH(NOLOCK);', undefined, cs).sources).toEqual([key('Foo')]);
  });
  it('retains escaped and Unicode/$ names at a delimited keyword boundary', () => {
    expect(parseSqlBody('INSERT INTO dbo.[Foo]]é$]VALUES(1);', undefined, cs).targets).toEqual([key('Foo]é$')]);
  });
  it.each(['dbo.[Foo]]', 'dbo.[Foo]]Bar', 'dbo.[Foo].'])('does not backtrack an incomplete delimited name %s to Foo', name => {
    expect(parseSqlBody(`INSERT INTO ${name} VALUES(1);`, undefined, cs).targets).toEqual([]);
  });
});
