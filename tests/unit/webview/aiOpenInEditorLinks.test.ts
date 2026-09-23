// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { stripFocusNodeLinks } from '../../../src/bridge/messageHandlers';

describe('stripFocusNodeLinks', () => {
  it('reduces a focus-node link to its label', () => {
    expect(stripFocusNodeLinks('See [dbo.Orders](#focus-node:dbo.Orders) for detail.'))
      .toBe('See dbo.Orders for detail.');
  });

  it('rewrites every focus-node link in the document', () => {
    const input = '[A](#focus-node:a) joins [B](#focus-node:b) on id.';
    expect(stripFocusNodeLinks(input)).toBe('A joins B on id.');
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
