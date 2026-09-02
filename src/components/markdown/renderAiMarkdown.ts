import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked, type Tokens } from 'marked';
import { markedKatexExtension } from './markedKatexExtension';

/**
 * The `#focus-node:` scheme used by engine-assembled object links. These resolve only inside the
 * graph webview, so the click handler intercepts them rather than letting the browser navigate.
 */
export const FOCUS_NODE_HREF_PREFIX = '#focus-node:';

/** Leading text of the engine-assembled `### Objects <links>` heading. */
const OBJECTS_HEADING_PREFIX = 'Objects ';

const marked = new Marked({ gfm: true, breaks: false })
  .use(markedKatexExtension(katex))
  .use({
    renderer: {
      heading(token: Tokens.Heading): string {
        const body = this.parser.parseInline(token.tokens);
        if (token.depth === 3 && body.startsWith(OBJECTS_HEADING_PREFIX)) {
          return `<h3><span class="ln-ai-objects-label">Objects</span>${body.slice(OBJECTS_HEADING_PREFIX.length)}</h3>\n`;
        }
        return `<h${token.depth}>${body}</h${token.depth}>\n`;
      },
    },
  });

// KaTeX exposes each expression's source through `data-latex`; `style` is in DOMPurify's default allowlist.
const SANITIZE_CONFIG = { ADD_ATTR: ['data-latex'] };

/**
 * Renders an engine-assembled AI description to sanitized HTML.
 *
 * @remarks
 * Math follows the same delimiter rules VS Code applies to chat responses: `$…$` and `$$…$$`,
 * with prose amounts excluded by the surrounding-character guards. A KaTeX expression that fails
 * to parse degrades to its original source text rather than throwing.
 *
 * @param description - The assembled markdown document.
 * @returns Sanitized HTML ready for insertion into the overlay.
 */
export function renderAiMarkdown(description: string): string {
  return DOMPurify.sanitize(marked.parse(description, { async: false }), SANITIZE_CONFIG);
}
