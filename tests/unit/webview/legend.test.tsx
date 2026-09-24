// @vitest-environment jsdom
//
// Legend placement: beside an open sidebar, beside a collapsed panel's reopen rail, or at the edge.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Legend } from '../../../src/components/Legend';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

function legendLeft(inset?: 'sidebar' | 'rail'): string {
  act(() => root.render(<Legend schemas={['dbo']} inset={inset} />));
  return (host.querySelector('.ln-legend') as HTMLElement).style.left;
}

describe('Legend inset', () => {
  it('clears the reopen rail so it never covers the collapsed navigator button', () => {
    expect(legendLeft('rail')).toBe('52px');
  });

  it('sits at the edge with no inset and beside an open sidebar', () => {
    expect(legendLeft()).toBe('16px');
    expect(legendLeft('sidebar')).toContain('380px');
  });
});
