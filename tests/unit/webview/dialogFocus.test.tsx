// @vitest-environment jsdom
/**
 * Pins focus handling of the Help panel (a modal dialog: focus moves in on open and back to the
 * opener on close) and the exclusion-rules popup (focus lands in its input and returns on Escape).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

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
    await flush();
    const dialog = document.querySelector('[role="dialog"][aria-label="Data Lineage help"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.contains(document.activeElement)).toBe(true);

    render(false);
    await flush();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('exclusion rules popup focus', () => {
  it('focuses the pattern input on open and returns focus to the trigger on Escape', async () => {
    act(() => {
      root.render(<ExclusionDropdown exclusionPatterns={[]} onAddPattern={() => {}} onRemovePattern={() => {}} />);
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Exclusion rules"]')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    trigger.focus();
    act(() => trigger.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"][aria-label="Exclusion rules"]');
    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(dialog?.contains(document.activeElement)).toBe(true);

    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await flush();
    expect(document.querySelector('[role="dialog"][aria-label="Exclusion rules"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
