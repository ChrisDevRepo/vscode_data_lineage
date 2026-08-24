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
