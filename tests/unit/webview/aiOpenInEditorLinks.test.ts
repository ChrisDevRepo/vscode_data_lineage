// @vitest-environment jsdom
//
// Pins `stripFocusNodeLinks`: a focus-node link opened in the editor or replayed into chat is
// reduced to its label, and ordinary links and plain text pass through unchanged.
import { describe, expect, it } from 'vitest';
import { stripFocusNodeLinks } from '../../../src/engine/shared/bridgeContract';

describe('stripFocusNodeLinks', () => {
  it('reduces a focus-node link to its label', () => {
    expect(stripFocusNodeLinks('See [dbo.Orders](#focus-node:dbo.Orders) for detail.'))
      .toBe('See dbo.Orders for detail.');
  });

  it('rewrites every focus-node link in the document', () => {
    const input = '[A](#focus-node:a) joins [B](#focus-node:b) on id.';
    expect(stripFocusNodeLinks(input)).toBe('A joins B on id.');
  });

  it('reduces a link with an empty label or id', () => {
    expect(stripFocusNodeLinks('[](#focus-node:x)[Y](#focus-node:)')).toBe('Y');
  });

  it('leaves an ordinary markdown link untouched', () => {
    const input = 'See the [docs](https://example.com/docs) for more.';
    expect(stripFocusNodeLinks(input)).toBe(input);
  });

  it('leaves plain text with no links untouched', () => {
    const input = 'No links here, just prose about dbo.Orders.';
    expect(stripFocusNodeLinks(input)).toBe(input);
  });
});
