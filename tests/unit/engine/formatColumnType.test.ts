/**
 * `formatColumnType` unit-conflation regression: a dacpac `TypeSpecifier.Length` is
 * already a character count, while a DMV `max_length` is a byte count that nvarchar/nchar must
 * still be halved to read as characters. `lengthInChars` tells the shared formatter which unit it
 * received. The DMV (byte count) path is covered by `formats column types` in
 * `tests/unit/parser/dmvExtractor.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { formatColumnType } from '../../../src/engine/types';

describe('formatColumnType — dacpac (character count) path', () => {
  it.each([
    ['nvarchar', '100', 'nvarchar(100)'],
    ['nchar', '10', 'nchar(10)'],
    ['nvarchar', '-1', 'nvarchar(max)'],
    ['varchar', '100', 'varchar(100)'],
  ])('renders %s length %s as %s without halving', (type, length, expected) => {
    expect(formatColumnType(type, length, '', '', true)).toBe(expected);
  });
});
