/** Identifier-normalization tests for `src/utils/sql.ts`: the delimiter strip and the qualified-name split must agree with T-SQL, where `]]` inside a bracketed name is one literal `]`. */
import { describe, expect, it } from 'vitest';
import { splitSqlName, stripBrackets } from '../../../src/utils/sql';
import { sqlIdentifierComparisonKey } from '../../../src/engine/shared/sqlIdentifier';

describe('sqlIdentifierComparisonKey', () => {
  it.each(['[]', '""', '[].x', 'x.[]', '"".x', 'x.""', '[a]..[b]'])(
    'rejects empty qualified identifier parts: %s',
    (input) => {
      expect(sqlIdentifierComparisonKey(input)).toBeNull();
    },
  );
  // The key is opaque, so expected values are other spellings of the same
  // T-SQL identity: an escaped delimiter is one literal character, so the
  // bracketed and the double-quoted spelling of each name must agree.
  it.each([
    ['[a]]b]', '"a]b"', '["a]b"]'],
    ['"a""b"', '[a"b]', '["a\\"b"]'],
    ['[]]]', '"]"', '[\"]\"]'],
    ['""""', '["]', '["\\\""]'],
    ['[dbo].[a]]b]', 'dbo."a]b"', '["dbo","a]b"]'],
  ])(
    'reads escaped delimiters as identifier content: %s is %s',
    (escaped, other, canonical) => {
      expect(sqlIdentifierComparisonKey(escaped)).toBe(canonical);
      expect(sqlIdentifierComparisonKey(other)).toBe(canonical);
    },
  );
  it.each([
    ['[a]]b]', '[ab]'],
    ['[a]]b]', '[a].[b]'],
    ['"a""b"', '"ab"'],
    ['[a.b]', '[a].[b]'],
  ])(
    'keeps an escaped delimiter or a dot as content distinct: %s is not %s',
    (left, right) => {
      expect(sqlIdentifierComparisonKey(left)).not.toBe(
        sqlIdentifierComparisonKey(right),
      );
    },
  );
  it('ignores delimiters, outside whitespace and case only where the source allows', () => {
    expect(sqlIdentifierComparisonKey('[dbo].[Foo]')).toBe('["dbo","foo"]');
    expect(sqlIdentifierComparisonKey(' dbo . foo ')).toBe('["dbo","foo"]');
    expect(sqlIdentifierComparisonKey('[dbo].[Foo]', true)).toBe(
      '["dbo","Foo"]',
    );
    expect(sqlIdentifierComparisonKey('dbo.foo', true)).toBe('["dbo","foo"]');
    expect(sqlIdentifierComparisonKey('"dbo"."Foo"', true)).toBe(
      '["dbo","Foo"]',
    );
  });
});

describe('stripBrackets', () => {
  it.each([
    ['[a]', 'a'],
    ['[a]]b]', 'a]b'],
    ['[dbo].[Table]', 'dbo.Table'],
    ['[dbo].[a]]b]', 'dbo.a]b'],
    ['"dbo"."Table"', 'dbo.Table'],
    ['"a""b"', 'a"b'],
    ['dbo.Table', 'dbo.Table'],
    // Stray delimiters of an unbalanced name are dropped.
    ['dbo].[Table', 'dbo.Table'],
  ])('unwraps %s to %s, unescaping doubled delimiters', (input, expected) => {
    expect(stripBrackets(input)).toBe(expected);
  });
});

describe('splitSqlName', () => {
  it.each([
    ['[dbo].[a]]b]', ['[dbo]', '[a]]b]']],
    // A dot after an escaped bracket stays inside the name.
    ['[dbo].[a]].b]', ['[dbo]', '[a]].b]']],
    ['[schema].[obj.with.dot]', ['[schema]', '[obj.with.dot]']],
    ['db.schema.obj', ['db', 'schema', 'obj']],
    // An escaped quote does not close a quoted identifier.
    ['"dbo"."a""b"', ['"dbo"', '"a""b"']],
  ])('splits %s into %j', (input, parts) => {
    expect(splitSqlName(input)).toEqual(parts);
  });
});
