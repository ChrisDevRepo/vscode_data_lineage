// @vitest-environment jsdom
//
// Pins the status banner text: an error shows its full message on screen, other types shorten long
// text and keep the full text in a tooltip.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusMessage } from '../../../src/components/ui/StatusMessage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const LONG = `Local Docker AW: Failed to connect to localhost:14333 - self-signed certificate in certificate chain. ${'x'.repeat(80)} END`;

describe('StatusMessage', () => {
  it('shows a long error message in full', () => {
    act(() => root.render(<StatusMessage text={LONG} type="error" />));
    expect(host.querySelector('.ln-status-body')?.textContent).toBe(LONG);
  });

  it('shortens long info text', () => {
    act(() => root.render(<StatusMessage text={LONG} type="info" />));
    expect(host.querySelector('.ln-status-body')?.textContent?.endsWith('…')).toBe(true);
  });
});
