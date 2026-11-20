import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';
import katex from 'katex';
import { Marked, type Token, type Tokens } from 'marked';
import { markedKatexExtension } from './markedKatexExtension';

/** Leading text of the engine-assembled `### Objects <links>` footnote line. */
const OBJECTS_HEADING_PREFIX = 'Objects ';

/** Unnumbered heading of the engine-assembled CT column chain, collapsed as supporting evidence. */
const COLUMN_CHAIN_HEADING = 'Column Chain';

/** `id` prefix the section-chip navigation scrolls to; the engine numbers `## N` sections. */
export const AI_SECTION_ID_PREFIX = 'ln-ai-sec-';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** A SQL line holding only a `--` comment (an omission marker or a recap). */
const SQL_COMMENT_LINE = /^\s*--/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Aligns a quoted SQL excerpt for display: the indentation its code lines share with the source
 * body is removed, and each comment-only line takes the indentation of the next code line (or the
 * previous one at the end). Text and line order stay as captured.
 */
export function alignSqlExcerpt(sql: string): string {
  const lines = sql.split('\n');
  const isCode = (line: string): boolean => line.trim() !== '' && !SQL_COMMENT_LINE.test(line);
  const codeIndents = lines.filter(isCode).map(indentOf);
  if (codeIndents.length === 0) return sql;
  const shared = Math.min(...codeIndents);
  const aligned = lines.map(line => (isCode(line) ? line.slice(shared) : line));
  return aligned.map((line, index) => {
    if (!SQL_COMMENT_LINE.test(line)) return line;
    const anchor = aligned.slice(index + 1).find(isCode) ?? aligned.slice(0, index).reverse().find(isCode) ?? '';
    return ' '.repeat(indentOf(anchor)) + line.trimStart();
  }).join('\n');
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

const marked = new Marked({ gfm: true, breaks: false })
  .use(markedKatexExtension(katex))
  .use({
    hooks: {
      // The chain section (up to the next `#`/`##` heading) becomes one closed evidence token.
      processAllTokens(tokens: Token[]): Token[] {
        const at = tokens.findIndex(t => t.type === 'heading' && t.depth === 2 && t.text === COLUMN_CHAIN_HEADING);
        if (at < 0) return tokens;
        const next = tokens.findIndex((t, i) => i > at && t.type === 'heading' && t.depth <= 2);
        const end = next < 0 ? tokens.length : next;
        const raw = tokens.slice(at, end).map(t => t.raw).join('');
        tokens.splice(at, end - at, { type: 'columnEvidence', raw, tokens: tokens.slice(at + 1, end) });
        return tokens;
      },
    },
    extensions: [{
      name: 'columnEvidence',
      renderer(token: Tokens.Generic): string {
        const rows = (token.tokens ?? []).flatMap(t => (t.type === 'table' ? t.rows : []));
        const outputs = rows.filter(row => row[0]?.text).length;
        const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
        return `<details class="ln-ai-column-evidence"><summary>Column evidence: ${count(outputs, 'output')}, ${count(rows.length, 'link')}</summary>\n${this.parser.parse(token.tokens ?? [])}</details>\n`;
      },
    }],
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(token.text);
      },
      // A SQL block is aligned and marked for the overlay's Monaco colorizer (`colorizeSql.ts`); other blocks keep the default.
      code(token: Tokens.Code): string | false {
        if (token.lang?.trim().toLowerCase() !== 'sql') return false;
        return `<pre><code class="language-sql" data-lang="sql">${escapeHtml(alignSqlExcerpt(token.text))}</code></pre>\n`;
      },
      heading(token: Tokens.Heading): string {
        const body = this.parser.parseInline(token.tokens);
        if (token.depth === 3 && body.startsWith(OBJECTS_HEADING_PREFIX)) {
          return `<p class="ln-ai-objects"><span class="ln-ai-objects-label">Objects</span>${body.slice(OBJECTS_HEADING_PREFIX.length)}</p>\n`;
        }
        if (token.depth === 2) {
          const sectionNumber = /^\s*(\d+)\s/.exec(token.text ?? '');
          if (sectionNumber) return `<h2 id="${AI_SECTION_ID_PREFIX}${sectionNumber[1]}">${body}</h2>\n`;
        }
        return `<h${token.depth}>${body}</h${token.depth}>\n`;
      },
    },
  });

const SANITIZE_CONFIG = { FORBID_ATTR: ['name'] };

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

/**
 * Renders an engine-assembled AI description to sanitized HTML. Math follows VS Code's chat rules:
 * `$…$` and `$$…$$`, with prose amounts excluded by surrounding-character guards; a KaTeX
 * expression that fails to parse degrades to its source text rather than throwing.
 */
export function renderAiMarkdown(description: string): string {
  return aiPurifier().sanitize(marked.parse(description, { async: false }), SANITIZE_CONFIG);
}
