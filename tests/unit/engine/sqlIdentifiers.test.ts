/**
 * Identifier-normalization tests for `src/utils/sql.ts`: the delimiter strip and the qualified-name
 * split must agree with T-SQL, where `]]` inside a bracketed name is one literal `]`.
 */
import { describe, expect, it } from 'vitest';
import { splitSqlName, stripBrackets } from '../../../src/utils/sql';

describe('stripBrackets', () => {
  it('unwraps a plain bracketed identifier', () => {
    expect(stripBrackets('[a]')).toBe('a');
  });

  it('unescapes a doubled bracket to the single literal character', () => {
    expect(stripBrackets('[a]]b]')).toBe('a]b');
  });

  it('unwraps every part of a qualified name', () => {
    expect(stripBrackets('[dbo].[Table]')).toBe('dbo.Table');
    expect(stripBrackets('[dbo].[a]]b]')).toBe('dbo.a]b');
  });

  it('unwraps double-quoted identifiers and leaves undelimited text alone', () => {
    expect(stripBrackets('"dbo"."Table"')).toBe('dbo.Table');
    expect(stripBrackets('dbo.Table')).toBe('dbo.Table');
  });

  it('drops stray delimiters from an unbalanced name', () => {
    expect(stripBrackets('dbo].[Table')).toBe('dbo.Table');
  });
});

describe('splitSqlName', () => {
  it('keeps a doubled bracket inside the part it belongs to', () => {
    expect(splitSqlName('[dbo].[a]]b]')).toEqual(['[dbo]', '[a]]b]']);
  });

  it('does not split on a dot that follows an escaped bracket inside a name', () => {
    expect(splitSqlName('[dbo].[a]].b]')).toEqual(['[dbo]', '[a]].b]']);
  });

  it('splits an ordinary qualified name', () => {
    expect(splitSqlName('[schema].[obj.with.dot]')).toEqual(['[schema]', '[obj.with.dot]']);
    expect(splitSqlName('db.schema.obj')).toEqual(['db', 'schema', 'obj']);
  });
});
