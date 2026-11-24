// @vitest-environment jsdom
/**
 * Covers the chat's one markdown path: the chat message text goes through `renderAiMarkdown`, the
 * function the AI report overlay uses, so SQL blocks, KaTeX and sanitising behave identically.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownText } from '../../../src/components/chat/vendor/components/assistant-ui/elements/markdown-text';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

let partText = '';
vi.mock('@assistant-ui/react', () => ({ useMessagePartText: () => ({ text: partText, status: { type: 'complete' } }) }));

const api: VsCodeAPI = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

/** The chat's rendering of `text`, as markup. */
function chatMarkup(text: string): string {
  partText = text;
  return renderToStaticMarkup(<VsCodeProvider api={api}><MarkdownText /></VsCodeProvider>);
}

describe('chat MarkdownText', () => {
  it('renders a SQL block and a KaTeX formula', () => {
    const markup = chatMarkup('Loads\n\n```sql\n    SELECT 1\n    -- note\n```\n\nand $E = mc^2$.');
    expect(markup).toContain('<pre><code class="language-sql" data-lang="sql">SELECT 1\n-- note</code></pre>');
    expect(markup).toContain('<span class="vscode-katex-container" data-latex="E = mc^2"><span class="katex">');
    expect(markup).not.toContain('$E = mc^2$');
  });

  it('aligns the SQL excerpt as the overlay does', () => {
    const markup = chatMarkup('```sql\n    SELECT 1\n      FROM t\n```');
    expect(markup).toContain('SELECT 1\n  FROM t');
  });

  it('leaves no script element or event handler in the rendered text', () => {
    const markup = chatMarkup('hello <script>alert(1)</script> world\n\n<img src=x onerror="alert(2)">');
    const host = document.createElement('div');
    host.innerHTML = markup;
    expect(host.querySelector('script, img')).toBeNull();
    expect(host.querySelector('[onerror]')).toBeNull();
    expect(markup).not.toContain('<script');
  });

  it('re-renders the whole accumulated text when a delta arrives', () => {
    expect(chatMarkup('**bo')).not.toContain('<strong>');
    expect(chatMarkup('**bold**')).toContain('<strong>bold</strong>');
  });
});
