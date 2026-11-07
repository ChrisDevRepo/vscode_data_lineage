import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';
import katex from 'katex';
import { Marked, type Tokens } from 'marked';
import { markedKatexExtension } from './markedKatexExtension';

/** Leading text of the engine-assembled `### Objects <links>` footnote line. */
const OBJECTS_HEADING_PREFIX = 'Objects ';

/** `id` prefix the section-chip navigation scrolls to; the engine numbers `## N` sections. */
export const AI_SECTION_ID_PREFIX = 'ln-ai-sec-';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const marked = new Marked({ gfm: true, breaks: false })
  .use(markedKatexExtension(katex))
  .use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string {
        return token.text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
      },
      heading(token: Tokens.Heading): string {
        const body = this.parser.parseInline(token.tokens);
        if (token.depth === 3 && body.startsWith(OBJECTS_HEADING_PREFIX)) {
          return `<p class="ln-ai-objects"><span class="ln-ai-objects-label">Objects</span>${body.slice(OBJECTS_HEADING_PREFIX.length)}</p>\n`;
        }
        if (token.depth === 2) {
          const sectionNumber = /^\s*(\d+)\s/.exec(token.text ?? '');
          if (sectionNumber)
            return `<h2 id="${AI_SECTION_ID_PREFIX}${sectionNumber[1]}">${body}</h2>\n`;
        }
        return `<h${token.depth}>${body}</h${token.depth}>\n`;
      },
    },
  });

const SANITIZE_CONFIG = { FORBID_ATTR: ['name'] };

/**
 * Currency `$` that remains after real math is classified.
 * LibreChat PR 9293 (`preprocessLaTeX`): https://github.com/danny-avila/LibreChat/pull/9293
 */
const CURRENCY_DOLLAR =
  /(?<![\\$])\$(?!\$)(?=\d+(?:,\d{3})*(?:\.\d+)?(?:[KMBkmb])?(?:\s|$|[^a-zA-Z\d]))/g;

/** Inclusive-start, exclusive-end code regions. LibreChat `findCodeBlockRegions`. */
function codeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let inlineStart = -1;
  let fenceStart = -1;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '`' && content[i + 1] === '`' && content[i + 2] === '`') {
      if (fenceStart === -1) {
        fenceStart = i;
        i += 2;
      } else {
        regions.push([fenceStart, i + 3]);
        fenceStart = -1;
        i += 2;
      }
    } else if (char === '`' && fenceStart === -1) {
      if (inlineStart === -1) inlineStart = i;
      else {
        regions.push([inlineStart, i + 1]);
        inlineStart = -1;
      }
    }
  }
  return regions;
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function displayDelimiters(text: string): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '$') {
      indexes.push(i);
      i++;
    }
  }
  return indexes;
}

/** Line-start `$$` openers paired with the next `$$`. A mid-line `$$` is not an opener. */
function displayPairs(text: string): Array<[number, number]> {
  const indexes = displayDelimiters(text);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < indexes.length; i++) {
    const open = indexes[i];
    if ((open !== 0 && text[open - 1] !== '\n') || i + 1 >= indexes.length)
      continue;
    pairs.push([open, indexes[i + 1]]);
    i++;
  }
  return pairs;
}

/** Puts a line-start `$$` span into the newline form `blockRule` already matches. */
function normalizeDisplayClosers(text: string): string {
  let out = '';
  let cursor = 0;
  for (const [open, close] of displayPairs(text)) {
    out += text.slice(cursor, open);
    const body = text.slice(open + 2, close);
    const openOwn = text[open + 2] === '\n';
    const closeOwn =
      text[close - 1] === '\n' &&
      (close + 2 === text.length || text[close + 2] === '\n');
    if ((openOwn && closeOwn) || body.length === 0)
      out += text.slice(open, close + 2);
    else {
      const afterOpen = openOwn ? '' : '\n';
      const beforeClose = text[close - 1] === '\n' ? '' : '\n';
      const afterClose =
        close + 2 === text.length || text[close + 2] === '\n' ? '' : '\n';
      out += `$$${afterOpen}${body}${beforeClose}$$${afterClose}`;
    }
    cursor = close + 2;
  }
  return out + text.slice(cursor);
}

function lineEnding(char: string | undefined): boolean {
  return char === '\n' || char === '\r';
}

function markdownSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

/**
 * Closing index of a Pandoc single-dollar span, or -1 when the span is rejected.
 * LibreChat `tokenizeMathSpan`: https://github.com/danny-avila/LibreChat/blob/main/client/src/utils/latex.ts
 * A rejected span stays byte-identical. Escaping first breaks `$65 \times 44$`
 * (LibreChat PR 11899): https://github.com/danny-avila/LibreChat/pull/11899
 */
function inlineMathClose(text: string, open: number): number {
  if (escaped(text, open)) return -1;
  if (open > 0 && text[open - 1] === '$' && !escaped(text, open - 1)) return -1;
  const next = text[open + 1];
  if (
    next === undefined ||
    next === '$' ||
    next === '`' ||
    markdownSpace(next) ||
    lineEnding(next)
  )
    return -1;
  let brace = 0;
  let previous = '';
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (lineEnding(char) || char === '`') return -1;
    if (char === '\\') {
      const escapedChar = text[i + 1];
      if (escapedChar === undefined || lineEnding(escapedChar)) return -1;
      previous = escapedChar;
      i++;
      continue;
    }
    if (char === '$') {
      if (markdownSpace(previous) || brace !== 0) return -1;
      const after = text[i + 1];
      if (
        after === '$' ||
        (after !== undefined && after >= '0' && after <= '9')
      )
        return -1;
      return i;
    }
    if (char === '{') brace++;
    if (char === '}') {
      if (brace === 0) return -1;
      brace--;
    }
    previous = char;
  }
  return -1;
}

function covers(
  spans: ReadonlyArray<readonly [number, number]>,
  index: number,
): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

function normalizeProse(text: string): string {
  if (!text.includes('$')) return text;
  const displayed = normalizeDisplayClosers(text);
  const displays = displayPairs(displayed).map(
    ([open, close]): [number, number] => [open, close + 2],
  );
  const inline: Array<[number, number]> = [];
  for (let i = 0; i < displayed.length; i++) {
    if (displayed[i] !== '$' || covers(displays, i)) continue;
    const close = inlineMathClose(displayed, i);
    if (close === -1) continue;
    inline.push([i, close + 1]);
    i = close;
  }
  const protectedSpans = displays.concat(inline);
  CURRENCY_DOLLAR.lastIndex = 0;
  return displayed.replace(CURRENCY_DOLLAR, (match, offset: number) =>
    covers(protectedSpans, offset) ? match : '\\$',
  );
}

/**
 * One content-preserving math normalization for the preview: classify real math,
 * escape only a remaining currency dollar, and split a glued `$$` closer onto its own line.
 * @internal
 */
export function normalizeAiMarkdownMath(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  const regions = codeRegions(markdown);
  let out = '';
  let cursor = 0;
  for (const [start, end] of regions) {
    out += normalizeProse(markdown.slice(cursor, start));
    out += markdown.slice(start, end);
    cursor = end;
  }
  return out + normalizeProse(markdown.slice(cursor));
}

let purifier: DOMPurifyInstance | null = null;

/**
 * The renderer's own sanitizer instance, created on first use. Its id hook keeps only numbered
 * section ids; a private instance keeps that hook off the shared `DOMPurify` other code uses.
 */
function aiPurifier(): DOMPurifyInstance {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    const id = node.getAttribute('id');
    if (!id) return;
    if (node.tagName === 'H2' && id.startsWith(AI_SECTION_ID_PREFIX)) return;
    node.removeAttribute('id');
  });
  return purifier;
}

/** Renders an engine-assembled AI description to sanitized HTML. */
export function renderAiMarkdown(description: string): string {
  return aiPurifier().sanitize(
    marked.parse(normalizeAiMarkdownMath(description), { async: false }),
    SANITIZE_CONFIG,
  );
}
