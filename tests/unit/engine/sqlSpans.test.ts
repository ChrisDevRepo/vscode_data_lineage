/**
 * Pins `sqlCommentMask`: quoted spans stay code, block comments nest, and line comments end at the
 * newline.
 */
import { describe, expect, it } from 'vitest';
import { SQL_BLOCK_COMMENT, SQL_CODE, SQL_LINE_COMMENT, sqlCommentMask } from '../../../src/engine/shared/sqlSpans';

/** Renders a mask as one character per input character: `.` code, `B` block, `L` line. */
function render(sql: string): string {
  const glyph = { [SQL_CODE]: '.', [SQL_BLOCK_COMMENT]: 'B', [SQL_LINE_COMMENT]: 'L' } as Record<number, string>;
  return Array.from(sqlCommentMask(sql), v => glyph[v]).join('');
}

describe('sqlCommentMask', () => {
  it('leaves delimiters inside quoted spans as code', () => {
    for (const sql of ["'p/*q'", '"a/*b"', '[x/*y]', "'a--b'", '"a--b"', '[a--b]']) {
      expect(render(sql), sql).toBe('.'.repeat(sql.length));
    }
  });

  it('honours doubled escapes inside quoted spans', () => {
    expect(render("'it''s' /**/")).toBe('........BBBB');
    expect(render('[a]]b] --x')).toBe('.......LLL');
    expect(render('"a""b" /**/')).toBe('.......BBBB');
  });

  it('nests block comments and runs an unterminated one to the end', () => {
    expect(render('a/* /* */ */b')).toBe('.BBBBBBBBBBB.');
    expect(render('a /* open')).toBe('..BBBBBBB');
  });

  it('ends a line comment at the newline and ignores delimiters inside comments', () => {
    expect(render('a --/*\nb')).toBe('..LLLL..');
    expect(render("/* ' */x")).toBe('BBBBBBB.');
  });
});
