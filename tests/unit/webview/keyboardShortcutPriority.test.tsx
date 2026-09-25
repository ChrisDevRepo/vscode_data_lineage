// @vitest-environment jsdom
//
// Esc follows one step-back order: a higher-priority active registration for the same key wins
// over a lower-priority one, instead of independent capture-phase listeners racing each other, and
// the Esc a filled text field consumes never also exits the surrounding mode.
import { StrictMode, act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useKeyboardShortcut } from '../../../src/hooks/useKeyboardShortcut';
import { SearchWithAutocomplete } from '../../../src/components/SearchWithAutocomplete';

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

function mount(element: ReactElement): void {
  act(() => root.render(<StrictMode>{element}</StrictMode>));
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

/** Stands in for GraphCanvas's pinned-column Esc step: priority 10, active only while pinned. */
function ColumnHost({ pinned, onUnpin }: { pinned: boolean; onUnpin: () => void }) {
  useKeyboardShortcut('Escape', onUnpin, false, { priority: 10, active: pinned });
  return null;
}

/** Stands in for App's mode-exit Esc step: default priority, always active. */
function TraceHost({ onExitTrace }: { onExitTrace: () => void }) {
  useKeyboardShortcut('Escape', onExitTrace);
  return null;
}

describe('Esc step-back order — pinned column inside an active trace', () => {
  it('the first Esc unpins the column and leaves the trace active; the next Esc exits the trace', () => {
    let pinned = true;
    let traceExited = 0;
    const unpin = () => { pinned = false; rerender(); };
    const exitTrace = () => { traceExited++; };

    function Scene() {
      return (
        <>
          <ColumnHost pinned={pinned} onUnpin={unpin} />
          <TraceHost onExitTrace={exitTrace} />
        </>
      );
    }
    function rerender() { mount(<Scene />); }

    mount(<Scene />);

    pressEscape();
    expect(pinned, 'first Esc unpins the column').toBe(false);
    expect(traceExited, 'the trace stays active — the higher-priority step wins the first Esc').toBe(0);

    pressEscape();
    expect(traceExited, 'once nothing higher-priority is active, Esc reaches the mode-exit step').toBe(1);
  });

  it('an inactive high-priority registration never blocks a lower-priority one', () => {
    let exited = 0;
    mount(
      <>
        <ColumnHost pinned={false} onUnpin={() => { throw new Error('must not fire while inactive'); }} />
        <TraceHost onExitTrace={() => { exited++; }} />
      </>
    );

    pressEscape();
    expect(exited).toBe(1);
  });
});

/**
 * Stands in for PathFinderBar's input plus App's mode-exit step: a local Escape handler clears a
 * non-empty field and stops there; the app-level step only sees a genuinely empty field, matching
 * PathFinderBar's own local clear-then-blur handler.
 */
function TextFieldScene({ onExit }: { onExit: () => void }) {
  const [value, setValue] = useState('target');
  useKeyboardShortcut('Escape', onExit, false, { allowEmptyTextEntry: true });
  return (
    <input
      data-testid="field"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        if (value) {
          e.stopPropagation();
          setValue('');
        }
      }}
    />
  );
}

describe('Esc step-back order — a non-empty text field blocks mode-exit, an empty one does not', () => {
  it('the first Esc clears the field and leaves the mode active; the next Esc exits the mode', () => {
    let exited = 0;
    mount(<TextFieldScene onExit={() => { exited++; }} />);
    const field = host.querySelector('[data-testid="field"]') as HTMLInputElement;

    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(field.value, 'first Esc clears the field').toBe('');
    expect(exited, 'a non-empty field at dispatch time blocks the mode-exit step').toBe(0);

    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(exited, 'an empty field no longer blocks — Esc reaches the mode-exit step').toBe(1);
  });
});

/** Stands in for App's mode-exit Esc step: passes the text-entry guard once the focused field is empty. */
function ModeExitHost({ onExit }: { onExit: () => void }) {
  useKeyboardShortcut('Escape', onExit, false, { allowEmptyTextEntry: true });
  return null;
}

describe('Esc step-back order — Quick Jump inside an active mode', () => {
  it('the Esc that clears a filled Quick Jump stops at the field; Esc in the empty field exits the mode', () => {
    let exited = 0;
    mount(
      <>
        <SearchWithAutocomplete visibleNodeIds={new Set()} onExecuteSearch={() => {}} />
        <ModeExitHost onExit={() => { exited++; }} />
      </>
    );
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Quick Jump..."]')!;
    input.focus();
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'abc');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // A trusted keydown gets a microtask checkpoint between listeners, so React has already cleared
    // the field when the document-level shortcut listener runs; the clearing Esc must not reach it.
    let reachedDocument = 0;
    const probe = (e: KeyboardEvent) => { if (e.key === 'Escape') reachedDocument++; };
    document.addEventListener('keydown', probe);
    try {
      const pressInInput = () => act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });

      pressInInput();
      expect(input.value, 'first Esc clears the field').toBe('');
      expect(reachedDocument, 'the clearing Esc stops at the field').toBe(0);
      expect(exited, 'the clearing Esc does not exit the mode').toBe(0);

      pressInInput();
      expect(reachedDocument, 'Esc in the empty field propagates').toBe(1);
      expect(exited, 'Esc in the empty field steps back out of the mode').toBe(1);
    } finally {
      document.removeEventListener('keydown', probe);
    }
  });
});
