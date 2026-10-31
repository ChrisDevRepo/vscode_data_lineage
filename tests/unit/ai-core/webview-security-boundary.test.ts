// @vitest-environment jsdom
/** Security boundary: untrusted AI markup stays inert, and webview policy denies ambient script/network/form access. */
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { renderAiMarkdown } from '../../../src/components/markdown/renderAiMarkdown';
import { buildWebviewCsp } from '../../../src/utils/cspBuilder';

describe('AI description HTML boundary', () => {
  it('shows raw HTML from the model as inert text instead of rendering it', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAiMarkdown(
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">',
    );
    expect(host.querySelector('script, img, [onerror]')).toBeNull();
    expect(host.textContent).toContain('<script>');
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

  // Our policy choice; the webview host enforces it.
  it('denies by default, allows scripts only by nonce or webview source, and forbids connections and forms', () => {
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.has('connect-src')).toBe(false);
    expect(new Set(policy.get('script-src'))).toEqual(
      new Set(["'nonce-security-fixture'", 'https://webview.example']),
    );
    expect(policy.get('form-action')).toEqual(["'none'"]);
  });

  it('allows workers only from blob: URLs, for the inline layout worker', () => {
    expect(policy.get('worker-src')).toEqual(['blob:']);
  });
});
