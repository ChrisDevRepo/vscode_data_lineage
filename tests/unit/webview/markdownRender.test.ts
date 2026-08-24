// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderAiMarkdown } from '../../../src/components/markdown/renderAiMarkdown';

// jsdom leaves `import.meta.url` as an http URL, so resolve from the Vitest root instead.
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
  it('renders GFM tables', () => {
    const rows = render(fixture).querySelectorAll('table tbody tr');
    expect(rows).toHaveLength(2);
  });

  it('renders fenced code blocks', () => {
    expect(render(fixture).querySelectorAll('pre code')).toHaveLength(1);
  });

  it('renders headings at their authored depth', () => {
    const host = render(fixture);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelectorAll('h2')).toHaveLength(3);
    expect(host.querySelectorAll('h3')).toHaveLength(4);
  });

  it('marks up the engine-assembled Objects heading', () => {
    const labels = render(fixture).querySelectorAll('h3 .ln-ai-objects-label');
    expect(labels).toHaveLength(3);
    expect(labels[0].textContent).toBe('Objects');
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

  it('drops javascript: hrefs', () => {
    const host = render('[click](javascript:alert(1))');
    expect(host.querySelector('a')?.getAttribute('href') ?? null).toBeNull();
  });
});

describe('renderAiMarkdown — the reported document', () => {
  let host: HTMLElement;
  beforeAll(() => { host = render(fixture); });

  it('renders every formula as math rather than literal dollar text', () => {
    // 4 display formulas plus 6 inline spans; none may survive as raw `$…$` prose.
    expect(host.querySelectorAll('.katex')).toHaveLength(10);
    expect(host.textContent).not.toContain('$\\rightarrow$');
    expect(host.textContent).not.toContain('$\\text{RawQty} = 0$');
  });

  it('renders the two adjacent SourceSystem formulas as separate display blocks', () => {
    expect(host.querySelectorAll('.katex-display')).toHaveLength(4);
  });
});
