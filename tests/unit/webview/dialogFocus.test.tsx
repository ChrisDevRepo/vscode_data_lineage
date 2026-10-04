// @vitest-environment jsdom
/**
 * Pins focus handling of the Help panel (a modal dialog: focus moves in on open, the first Escape
 * closes it, focus returns to the opener) and the exclusion-rules popup (focus lands in its input
 * and returns on Escape).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpModal } from '../../../src/components/HelpModal';
import { ExclusionDropdown } from '../../../src/components/ExclusionDropdown';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

// `@floating-ui/react`'s `FloatingFocusManager` moves focus via `requestAnimationFrame`
// (see `enqueueFocus` in its bundle), not synchronously with render, so an activeElement
// assertion must poll for that move instead of racing it with a fixed-duration sleep.
const focusSettled = (assertion: () => void) => act(() => vi.waitFor(assertion, { timeout: 2000, interval: 10 }));

describe('Help panel focus', () => {
  it('moves focus into the modal dialog on open and back to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const render = (isOpen: boolean) => act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <HelpModal isOpen={isOpen} onClose={() => {}} />
        </VsCodeProvider>
      );
    });
    render(true);
    await focusSettled(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Data Lineage help"]');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.contains(document.activeElement)).toBe(true);
    });

    render(false);
    await focusSettled(() => { expect(document.activeElement).toBe(opener); });
    opener.remove();
  });
});

describe('Help panel Escape', () => {
  it('closes on the first Escape pressed where focus lands on open', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <HelpModal isOpen onClose={onClose} />
        </VsCodeProvider>
      );
    });
    await focusSettled(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Data Lineage help"]');
      expect(dialog?.contains(document.activeElement)).toBe(true);
    });
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('exclusion rules popup focus', () => {
  it('focuses the pattern input on open and returns focus to the trigger on Escape', async () => {
    await act(async () => {
      root.render(<ExclusionDropdown exclusionPatterns={[]} onAddPattern={() => {}} onRemovePattern={() => {}} />);
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Exclusion rules"]')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => { trigger.focus(); });
    await act(async () => { trigger.click(); });
    await focusSettled(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Exclusion rules"]');
      expect(document.activeElement?.tagName).toBe('INPUT');
      expect(dialog?.contains(document.activeElement)).toBe(true);
    });

    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await focusSettled(() => {
      expect(document.querySelector('[role="dialog"][aria-label="Exclusion rules"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
