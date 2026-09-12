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
        // The engine emits the object-link list as an `### Objects` transport line at the END of a
        // section; render it as a small muted footnote paragraph, not a heading — the links then
        // share one small size with the "Objects" label instead of heading-scale text.
        if (token.depth === 3 && body.startsWith(OBJECTS_HEADING_PREFIX)) {
          return `<p class="ln-ai-objects"><span class="ln-ai-objects-label">Objects</span>${body.slice(OBJECTS_HEADING_PREFIX.length)}</p>\n`;
        }
        // Numbered `## N {label}` section headings carry a stable id so the report's section chips
        // can scroll to them. Unnumbered headings (e.g. the engine's `## Column Chain` preface)
        // take no chip and keep their plain form.
        if (token.depth === 2) {
          const sectionNumber = /^\s*(\d+)\s/.exec(token.text ?? '');
          if (sectionNumber) return `<h2 id="${AI_SECTION_ID_PREFIX}${sectionNumber[1]}">${body}</h2>\n`;
        }
        return `<h${token.depth}>${body}</h${token.depth}>\n`;
      },
    },
  });

// KaTeX exposes each expression's source through `data-latex`; `style` is in DOMPurify's default allowlist.
const SANITIZE_CONFIG = { ADD_ATTR: ['data-latex'] };

// Default DOMPurify allows `id` on every tag. Only numbered section headings need it
// (`ln-ai-sec-N`); any other id is stripped so a model-supplied attribute cannot clobber
// `window.vscode` or other globals in the webview.
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
 * @param description - The assembled markdown document.
 * @returns Sanitized HTML ready for insertion into the overlay.
 */
export function renderAiMarkdown(description: string): string {
  return DOMPurify.sanitize(marked.parse(description, { async: false }), SANITIZE_CONFIG);
}
