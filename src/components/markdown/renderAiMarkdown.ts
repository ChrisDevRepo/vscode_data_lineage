import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked, type Tokens } from 'marked';
import { markedKatexExtension } from './markedKatexExtension';

/**
 * The `#focus-node:` scheme used by engine-assembled object links. These resolve only inside the
 * graph webview, so the click handler intercepts them rather than letting the browser navigate.
 */
export const FOCUS_NODE_HREF_PREFIX = '#focus-node:';

/** Leading text of the engine-assembled `### Objects <links>` footnote line. */
const OBJECTS_HEADING_PREFIX = 'Objects ';

/** `id` prefix the section-chip navigation scrolls to; the engine numbers `## N` sections. */
export const AI_SECTION_ID_PREFIX = 'ln-ai-sec-';

const marked = new Marked({ gfm: true, breaks: false })
  .use(markedKatexExtension(katex))
  .use({
    renderer: {
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

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return;
  const id = node.getAttribute('id');
  if (!id) return;
  if (node.tagName === 'H2' && id.startsWith(AI_SECTION_ID_PREFIX)) return;
  node.removeAttribute('id');
});

/**
 * Renders an engine-assembled AI description to sanitized HTML.
 *
 * @remarks
 * Math follows the same delimiter rules VS Code applies to chat responses: `$…$` and `$$…$$`,
 * with prose amounts excluded by the surrounding-character guards. A KaTeX expression that fails
 * to parse degrades to its original source text rather than throwing.
 *
 * @returns Sanitized HTML ready for insertion into the overlay.
 */
export function renderAiMarkdown(description: string): string {
  return DOMPurify.sanitize(marked.parse(description, { async: false }), SANITIZE_CONFIG);
}
