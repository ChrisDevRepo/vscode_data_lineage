// @vitest-environment jsdom
/**
 * Pins that mode close buttons call their close callback with no arguments: a forwarded click event
 * reached `endTrace` as its `onComplete`, and `setTimeout` evaluated it as a string under the CSP.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeBanner } from '../../../src/components/ModeBanner';
import { PathFinderBar } from '../../../src/components/PathFinderBar';
import { InlineTraceControls } from '../../../src/components/InlineTraceControls';

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

function clickClose(selector: string): void {
  const btn = host.querySelector(selector) as HTMLButtonElement;
  expect(btn).not.toBeNull();
  act(() => btn.click());
}

describe('mode close buttons', () => {
  it('ModeBanner close calls onClose with no arguments', () => {
    const onClose = vi.fn();
    act(() => root.render(<ModeBanner variant="trace" icon="" title="Trace" subtitle="" onClose={onClose} />));
    clickClose('button.ln-mode-banner__close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]).toEqual([]);
  });

  it('PathFinderBar close calls onClose with no arguments', () => {
    const onClose = vi.fn();
    act(() => root.render(<PathFinderBar sourceNodeName="a" allNodes={[]} pathResult={null} onFindPath={() => false} onClose={onClose} />));
    clickClose('button[aria-label="Close Path Finder"]');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]).toEqual([]);
  });

  it('InlineTraceControls close calls onClose with no arguments', () => {
    const onClose = vi.fn();
    act(() => root.render(<InlineTraceControls {...({ startNodeId: 'a', startNodeName: 'a', onApply: () => {}, onClose } as unknown as ComponentProps<typeof InlineTraceControls>)} />));
    clickClose('button[aria-label="Close Trace Configuration"]');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]).toEqual([]);
  });
});
