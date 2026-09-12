/**
 * `formatColumnType` unit-conflation regression (P1-113): a dacpac `TypeSpecifier.Length` is
 * already a character count, while a DMV `max_length` is a byte count that nvarchar/nchar must
 * still be halved to read as characters. `lengthInChars` tells the shared formatter which unit it
 * received; both paths must keep rendering their declared length correctly.
 */
import { describe, expect, it } from 'vitest';
import { formatColumnType } from '../../../src/engine/types';

describe('formatColumnType — dacpac (character count) path', () => {
  it('renders a declared nvarchar(100) as nvarchar(100), not nvarchar(50)', () => {
    expect(formatColumnType('nvarchar', '100', '', '', true)).toBe('nvarchar(100)');
  });

  it('renders nchar(10) unchanged', () => {
    expect(formatColumnType('nchar', '10', '', '', true)).toBe('nchar(10)');
  });

  it('renders nvarchar(max) (-1) as nvarchar(max)', () => {
    expect(formatColumnType('nvarchar', '-1', '', '', true)).toBe('nvarchar(max)');
  });

  it('leaves a non-unicode varchar(100) unaffected', () => {
    expect(formatColumnType('varchar', '100', '', '', true)).toBe('varchar(100)');
  });
});

describe('formatColumnType — DMV (byte count) path, unchanged', () => {
  it('halves a max_length of 200 for nvarchar to nvarchar(100)', () => {
    expect(formatColumnType('nvarchar', '200', '', '')).toBe('nvarchar(100)');
  });

  it('renders nvarchar(max) (-1) as nvarchar(max)', () => {
    expect(formatColumnType('nvarchar', '-1', '', '')).toBe('nvarchar(max)');
  });

  it('leaves a non-unicode varchar(100) unaffected', () => {
    expect(formatColumnType('varchar', '100', '', '')).toBe('varchar(100)');
  });
});
