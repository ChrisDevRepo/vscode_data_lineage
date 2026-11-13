/** Detection of damaged math escapes in the decoded report text of one tool argument. */
import { lexMathSpans } from '../../components/markdown/markedKatexExtension';

/** A C0 control character other than newline (a JSON `\t`, `\f` or `\b` that ate a backslash). */
const CONTROL = /[\u0000-\u0009\u000b-\u001f]/;

/** A TAB where `\text{` lost its backslash (a JSON `\t`), also when no span around it is lexed. */
const TAB_TEXT = /\t(?=ext\{)/;

/**
 * The body of each `\text{…}` in a span: braces balanced, a backslash-escaped character skipped,
 * an unclosed body to the end.
 */
function textBodies(span: string): string[] {
  const bodies: string[] = [];
  for (const start of span.matchAll(/\\text\{/g)) {
    const from = start.index + start[0].length;
    let depth = 1,
      end = from;
    for (; end < span.length; end++) {
      if (span[end] === '\\') end++;
      else if (span[end] === '{') depth++;
      else if (span[end] === '}' && --depth === 0) break;
    }
    bodies.push(span.slice(from, end));
  }
  return bodies;
}

/**
 * True when the text holds a TAB before `ext{`, a math span the renderer lexes holds a control
 * character, or a `\text{}` body holds an unescaped `_` or a `\@`.
 */
export function hasDamagedMath(text: string): boolean {
  return (
    TAB_TEXT.test(text) ||
    lexMathSpans(text).some(
      (span) =>
        CONTROL.test(span) ||
        textBodies(span).some((body) => /(?<!\\)_|\\@/.test(body)),
    )
  );
}
