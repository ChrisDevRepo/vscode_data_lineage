/** Mask value of a character outside any comment, including string literals and quoted identifiers. */
export const SQL_CODE = 0;
/** Mask value of a character inside a `/* … *\/` block comment, delimiters included. */
export const SQL_BLOCK_COMMENT = 1;
/** Mask value of a character inside a `--` line comment, up to but excluding the newline. */
export const SQL_LINE_COMMENT = 2;
/** Mask value of a character inside a `'…'`, `"…"` or `[…]` span, delimiters included; set only on request. */
export const SQL_LITERAL = 3;

/**
 * Classifies every character of a T-SQL text as code, block comment or line comment.
 *
 * @remarks
 * Block comments nest; `'…'`, `"…"` and `[…]` hide comment delimiters and honour their doubled
 * escapes; an unterminated block comment runs to the end of the text. The parser and the DDL
 * search share this one reading so both agree on what is commented out.
 *
 * @param options - `markLiterals` marks quoted spans {@link SQL_LITERAL} instead of {@link SQL_CODE}.
 * @returns One mask value per UTF-16 code unit of `sql`.
 */
export function sqlCommentMask(sql: string, options?: { readonly markLiterals?: boolean }): Uint8Array {
  const mask = new Uint8Array(sql.length);
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (depth > 0) {
      if (ch === '/' && next === '*') { depth++; mask[i] = mask[i + 1] = SQL_BLOCK_COMMENT; i += 2; continue; }
      if (ch === '*' && next === '/') { depth--; mask[i] = mask[i + 1] = SQL_BLOCK_COMMENT; i += 2; continue; }
      mask[i++] = SQL_BLOCK_COMMENT;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '[') {
      const end = skipQuoted(sql, i + 1, ch === '[' ? ']' : ch);
      if (options?.markLiterals) mask.fill(SQL_LITERAL, i, end);
      i = end;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') mask[i++] = SQL_LINE_COMMENT;
      continue;
    }
    if (ch === '/' && next === '*') {
      depth = 1;
      mask[i] = mask[i + 1] = SQL_BLOCK_COMMENT;
      i += 2;
      continue;
    }
    i++;
  }
  return mask;
}

/** Returns the index just past the closer of a quoted span opened before `i`; a doubled closer is an escape. */
function skipQuoted(sql: string, i: number, closer: string): number {
  while (i < sql.length) {
    if (sql[i] !== closer) { i++; continue; }
    if (sql[i + 1] === closer) { i += 2; continue; }
    return i + 1;
  }
  return i;
}
