// @vitest-environment jsdom
//
// Pins `renderAiMarkdown`: math delimiter rules, block structure, link sanitization, and a full
// reported document.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DOMPurify from 'dompurify';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderAiMarkdown } from '../../../src/components/markdown/renderAiMarkdown';

const fixture = readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'markdown', 'spImportOrders.md'),
  'utf8',
);

function render(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderAiMarkdown(markdown);
  return host;
}

describe('renderAiMarkdown — delimiter rules', () => {
  it('renders single-dollar inline math', () => {
    expect(render('a `X` $\\rightarrow$ `Y`').querySelectorAll('.katex')).toHaveLength(1);
  });

  it('renders inline math wrapped in parentheses', () => {
    expect(render('clamping ($\\text{RawQty} = 0$) is silent').querySelectorAll('.katex')).toHaveLength(1);
  });

  it('renders comparison math with no space after the opening delimiter', () => {
    expect(render('amounts $< 0$ or $> 10,000,000$').querySelectorAll('.katex')).toHaveLength(2);
  });

  it('leaves prose currency alone', () => {
    for (const prose of ['costs $5 and $10', 'between $20,000 and $30,000', 'a $5M write-down']) {
      expect(render(prose).querySelectorAll('.katex'), prose).toHaveLength(0);
    }
  });

  it('renders block math on its own lines as display math', () => {
    expect(render('text\n\n$$\nE = mc^2\n$$\n\nmore').querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('renders double-dollar math as display math', () => {
    expect(render('$$ \\text{RawQty} = 0 $$').querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('degrades unparseable math to its original source without throwing', () => {
    const host = render('broken $\\frac{1$ here');
    expect(host.querySelectorAll('.katex')).toHaveLength(0);
    expect(host.textContent).toContain('\\frac{1');
  });
});

describe('renderAiMarkdown — structure', () => {
  it('keeps a rule explanation, displayed formula, consequence and SQL witness in reading order', () => {
    const host=render('**Rules and branches.** Negative quantities are corrected before the validated rows are inserted.\n\n$$ RawQty = 0 $$\n\nRawQty is the imported quantity; this correction removes the negative sign from the stored value.\n\n```sql\nUPDATE #RawBatch SET RawQty = 0 WHERE RawQty < 0;\n```');
    const math=host.querySelector('.katex-display')!;
    const block=math.closest('p')??math;
    expect(block.previousElementSibling?.textContent).toContain('Negative quantities are corrected');
    expect(block.nextElementSibling?.textContent).toContain('removes the negative sign');
    expect(block.nextElementSibling?.nextElementSibling?.tagName).toBe('PRE');
    expect(host.querySelector('code')?.textContent).toContain('WHERE RawQty < 0');
    expect(host.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
  });

  it('keeps an inline formula and its short description together in a transformation table', () => {
    const host=render('**Rules and branches.** The correction applies only to negative quantities.\n\n| Formula | Meaning |\n| --- | --- |\n| $RawQty = 0$ | Replace a negative imported quantity with zero. |\n\nThe amount remains unchanged by this quantity correction.');
    const row=host.querySelector('tbody tr')!;
    expect(row.querySelectorAll('td')).toHaveLength(2);
    expect(row.querySelector('td .katex')).not.toBeNull();
    expect(row.querySelectorAll('td')[1].textContent).toBe('Replace a negative imported quantity with zero.');
    expect(host.querySelectorAll('.katex-display')).toHaveLength(0);
    expect(host.querySelector('table')?.previousElementSibling?.textContent).toContain('only to negative quantities');
    expect(host.querySelector('table')?.nextElementSibling?.textContent).toContain('amount remains unchanged');
  });

  it('gives numbered section headings a stable id for chip navigation', () => {
    const host = render(fixture);
    const ids = Array.from(host.querySelectorAll<HTMLHeadingElement>('h2[id]')).map(h => h.id);
    expect(ids).toEqual(['ln-ai-sec-1', 'ln-ai-sec-2', 'ln-ai-sec-3']);
  });

  it('leaves unnumbered headings without a section id', () => {
    const host = render('## Column Chain\n\n| a |\n| --- |\n| 1 |');
    expect(host.querySelector('h2')?.getAttribute('id') ?? null).toBeNull();
  });

  it('marks up the engine-assembled Objects footnote', () => {
    const footnotes = render(fixture).querySelectorAll('p.ln-ai-objects');
    expect(footnotes).toHaveLength(3);
    expect(footnotes[0].querySelector('.ln-ai-objects-label')?.textContent).toBe('Objects');
    expect(footnotes[0].querySelectorAll('a[href^="#focus-node:"]')).toHaveLength(2);
  });
});

describe('renderAiMarkdown — links and sanitization', () => {
  it('preserves focus-node hrefs through sanitization', () => {
    const links = render(fixture).querySelectorAll<HTMLAnchorElement>('a[href^="#focus-node:"]');
    expect(links).toHaveLength(4);
    expect(decodeURIComponent(links[0].getAttribute('href')!)).toBe('#focus-node:[ai].[saporders]');
  });

  it('strips script elements and inline event handlers', () => {
    const host = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('onerror') ?? null).toBeNull();
  });

  it('renders raw HTML from the description as literal text', () => {
    const host = render('<a href="https://example.com" style="position:fixed;inset:0">x</a>\n\ninline <form><input></form> tag');
    expect(host.querySelector('a, form, input, [style]')).toBeNull();
    expect(host.textContent).toContain('<a href="https://example.com"');
    expect(host.textContent).toContain('<form><input></form>');
  });

  it('renders raw HTML inside object-link text as literal text', () => {
    const host = render('### Objects [<style>*{display:none}</style>](#focus-node:x)');
    expect(host.querySelector('style')).toBeNull();
    expect(host.textContent).toContain('<style>');
  });

  it('drops javascript: hrefs', () => {
    const host = render('[click](javascript:alert(1))');
    expect(host.querySelector('a')?.getAttribute('href') ?? null).toBeNull();
  });

  it('keeps numbered section ids and strips any other id', () => {
    const host = render('## 1 Sales\n\n<img id="vscode" src="x">');
    expect(host.querySelector('h2')?.id).toBe('ln-ai-sec-1');
    expect(host.querySelector('img')?.getAttribute('id') ?? null).toBeNull();
  });

  it('configures a private sanitizer, leaving the shared DOMPurify instance untouched', () => {
    render('## 1 Sales');
    expect(DOMPurify.sanitize('<p id="kept" name="kept">x</p>')).toBe('<p id="kept" name="kept">x</p>');
    expect(render('## 1 Sales').querySelector('h2')?.id, 'the renderer still keeps its section ids').toBe('ln-ai-sec-1');
  });
});

describe('renderAiMarkdown — the reported document', () => {
  let host: HTMLElement;
  beforeAll(() => { host = render(fixture); });

  it('renders every formula as math rather than literal dollar text', () => {
    expect(host.querySelectorAll('.katex')).toHaveLength(10);
    expect(host.textContent).not.toContain('$\\rightarrow$');
    expect(host.textContent).not.toContain('$\\text{RawQty} = 0$');
  });

  it('renders the two adjacent SourceSystem formulas as separate display blocks', () => {
    expect(host.querySelectorAll('.katex-display')).toHaveLength(4);
  });
});
