// @vitest-environment jsdom
/**
 * Parity contract: an AI-authored description reaches the renderer as the model's own bytes.
 *
 * @remarks
 * The Copilot chat window renders model markdown through `marked` + the vendored
 * `markedKatexExtension` + DOMPurify and applies no pre-render text handling. Our React overlay uses
 * the same code, so the only way the two surfaces can disagree is a transform of our own between the
 * tool call and the renderer. These tests pin that there is none: section text is assembled
 * byte-identical, and rendering the assembled document yields the same math HTML as rendering the
 * model's text directly.
 */
import { describe, expect, it } from 'vitest';
import { orderAndAssemble } from '../../../src/ai/tools/presentResult';
import { renderAiMarkdown } from '../../../src/components/markdown/renderAiMarkdown';
import { MATH_PARITY_CASES } from '../helpers/mathParityCases';

/** Rendered math spans, as a comparable projection of the HTML. */
function mathHtml(markdown: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = renderAiMarkdown(markdown);
  return Array.from(host.querySelectorAll('.katex')).map(el => el.getAttribute('data-latex') ?? el.textContent ?? '');
}

describe('assembled description — the model\'s bytes reach the renderer', () => {
  for (const { name, markdown } of MATH_PARITY_CASES) {
    it(`passes section text through byte-identical: ${name}`, () => {
      const { description } = orderAndAssemble([{ label: 'Result', text: markdown }]);
      expect(description).toContain(markdown);
    });
  }

  for (const { name, markdown } of MATH_PARITY_CASES) {
    it(`renders the assembled document like the raw text: ${name}`, () => {
      const { description } = orderAndAssemble([{ label: 'Result', text: markdown }]);
      expect(mathHtml(description)).toEqual(mathHtml(markdown));
    });
  }
});

/**
 * The engine writes the `### Objects` link header and the overlay decodes the href on click, so the
 * two must agree on the encoding. A bracketed SQL identifier may legally contain `%` or `)`, which
 * raw would throw a `URIError` in the click handler, resolve to a different id, or terminate the
 * markdown link before the href is complete.
 */
describe('focus-node object links round-trip to the id the overlay resolves', () => {
  /** The overlay's own decode step, mirrored from `AiDescriptionOverlay.handleMarkdownClick`. */
  function resolvedIds(markdown: string): string[] {
    const host = document.createElement('div');
    host.innerHTML = renderAiMarkdown(markdown);
    return Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href^="#focus-node:"]'))
      .map(anchor => decodeURIComponent(anchor.getAttribute('href')!.slice('#focus-node:'.length)));
  }

  function assembleLinkFor(id: string, name: string): string {
    const { description } = orderAndAssemble(
      [{ label: 'Result', text: 'Body.', node_ids: [id] }],
      { nodeMap: new Map([[id, { id, name }]]) },
    );
    return description;
  }

  const ids: ReadonlyArray<readonly [string, string]> = [
    ['[dbo].[factsales]', 'FactSales'],
    ['[dbo].[discount%]', 'Discount%'],
    ['[dbo].[rate%20card]', 'Rate%20Card'],
    ['[dbo].[foo)bar]', 'Foo)Bar'],
    ['[dbo].[order (eu)]', 'Order (EU)'],
  ];

  for (const [id, name] of ids) {
    it(`resolves back to ${id}`, () => {
      expect(resolvedIds(assembleLinkFor(id, name))).toEqual([id]);
    });
  }

  it('emits exactly one link per node id and survives sanitization', () => {
    const description = assembleLinkFor('[dbo].[discount%]', 'Discount%');
    expect(description).toContain('### Objects ');
    expect(resolvedIds(description)).toHaveLength(1);
  });
});

describe('intro and closing reach the renderer unchanged', () => {
  for (const { name, markdown } of MATH_PARITY_CASES) {
    it(`carries intro and closing byte-identical: ${name}`, () => {
      const { description } = orderAndAssemble(
        [{ label: 'Result', text: 'Body.' }],
        { intro: markdown, closing: markdown },
      );
      expect(description).toContain(markdown);
    });
  }
});
