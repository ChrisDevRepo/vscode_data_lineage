/** Detection of damaged math escapes in the decoded report text of one tool argument. */
import { lexMathSpans } from '../../components/markdown/markedKatexExtension';

/** A C0 control character other than newline (a JSON `\t`, `\f` or `\b` that ate a backslash). */
const CONTROL = /[\u0000-\u0009\u000b-\u001f]/;

/** The body of each `\text{…}` in a span, braces balanced. */
function textBodies(span: string): string[] {
  const bodies: string[] = [];
  for (const start of span.matchAll(/\\text\{/g)) {
    let depth = 1,
      end = start.index + start[0].length;
    for (; end < span.length && depth > 0; end++)
      depth += span[end] === '{' ? 1 : span[end] === '}' ? -1 : 0;
    bodies.push(span.slice(start.index + start[0].length, end - 1));
  }
  return bodies;
}

/**
 * True when a math span the renderer lexes holds a control character, or a `\text{}` body holds an
 * unescaped `_` or a `\@`.
 */
export function hasDamagedMath(text: string): boolean {
  return lexMathSpans(text).some(
    (span) =>
      CONTROL.test(span) ||
      textBodies(span).some((body) => /(?<!\\)_|\\@/.test(body)),
  );
}
