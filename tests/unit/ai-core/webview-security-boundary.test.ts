// @vitest-environment jsdom
/** Security boundary: untrusted AI markup stays inert, and webview policy denies ambient script/network/form access. */
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { renderAiMarkdown } from '../../../src/components/markdown/renderAiMarkdown';
import { buildWebviewCsp } from '../../../src/utils/cspBuilder';

describe('AI description HTML boundary', () => {
  it.each([
    [
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">',
      'script, [onerror]',
    ],
    [
      '<a href="https://example.com" style="position:fixed;inset:0">x</a> <form><input></form>',
      'a, form, input, [style]',
    ],
    ['### Objects [<style>*{display:none}</style>](#focus-node:x)', 'style'],
    ['[click](javascript:alert(1))', 'a[href^="javascript:"]'],
  ])('does not render active content from %s', (markdown, selector) => {
    const host = document.createElement('div');
    host.innerHTML = renderAiMarkdown(markdown);
    expect(host.querySelector(selector)).toBeNull();
    if (markdown.includes('<'))
      expect(host.textContent).toContain(markdown.match(/<[^>]+>/)![0]);
  });

  it('keeps only section ids without changing the shared sanitizer', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAiMarkdown(
      '## 1 Sales\n\n<img id="vscode" name="vscode" src="x">',
    );
    expect(host.querySelector('h2')?.id).toBe('ln-ai-sec-1');
    expect(host.querySelector('[id]:not(h2), [name]')).toBeNull();
    expect(DOMPurify.sanitize('<p id="kept" name="kept">x</p>')).toBe(
      '<p id="kept" name="kept">x</p>',
    );
  });
});

describe('webview CSP security boundary', () => {
  const policy = new Map(
    buildWebviewCsp({
      nonce: 'security-fixture',
      cspSource: 'https://webview.example',
    })
      .split(';')
      .filter((part) => part.trim())
      .map((part) => {
        const [directive, ...sources] = part.trim().split(/\s+/);
        return [directive, sources] as const;
      }),
  );

  it('denies unlisted resources and external connections', () => {
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('connect-src') ?? policy.get('default-src')).toEqual([
      "'none'",
    ]);
  });

  it('allows scripts only from the webview source or the generated nonce', () => {
    expect(new Set(policy.get('script-src'))).toEqual(
      new Set(["'nonce-security-fixture'", 'https://webview.example']),
    );
  });

  it('forbids form submission', () => {
    expect(policy.get('form-action')).toEqual(["'none'"]);
  });
});

describe('AI description formulas', () => {
  const render = (markdown: string) => {
    const host = document.createElement('div');
    host.innerHTML = renderAiMarkdown(markdown);
    return host;
  };

  it('renders a valid formula through KaTeX', () => {
    const host = render('Rate $a^2$ applies.');
    expect(host.querySelector('.vscode-katex-container .katex')).not.toBeNull();
    expect(host.querySelector('.ln-ai-formula-error')).toBeNull();
  });

  it.each([
    ['before $\\text{#X}$ after', '$\\text{#X}$'],
    [
      'before\n\n$$\n\\begin{cases} a \\\\ b\n$$\n\nafter',
      '$$\n\\begin{cases} a \\\\ b\n$$',
    ],
  ])('shows the unrendered formula in %j visibly', (markdown, source) => {
    const host = render(markdown);
    const errors = host.querySelectorAll('.ln-ai-formula-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toBe(source);
    expect(errors[0].getAttribute('title')).toMatch(
      /^Formula could not be rendered: \S/,
    );
    expect(host.textContent?.startsWith('before')).toBe(true);
    expect(host.textContent?.trimEnd().endsWith('after')).toBe(true);
  });

  it('escapes the unrendered source and keeps sibling formulas', () => {
    const host = render('$x<y$ and $\\text{#&<b>}$ and $z^2$');
    const errors = host.querySelectorAll('.ln-ai-formula-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toBe('$\\text{#&<b>}$');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelectorAll('.vscode-katex-container')).toHaveLength(2);
  });
});
