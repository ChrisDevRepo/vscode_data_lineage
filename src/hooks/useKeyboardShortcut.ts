import { useEffect, useRef } from 'react';
import { isTextEntryTarget } from '../ui/keyboardShortcuts';

/**
 * Custom hook for registering global keyboard shortcuts within the VS Code webview context.
 * 
 * @remarks
 * This hook manages event listener registration and cleanup, ensuring that callbacks
 * are always current without triggering unnecessary effect re-runs. It ignores key
 * events that carry a Ctrl/Cmd/Alt modifier (so bare-letter shortcuts never collide
 * with native chords like Ctrl+C) and events originating from text-entry surfaces
 * (`input`, `textarea`, or any `contenteditable` element). Matching is case-insensitive.
 *
 * @param key - The key or array of keys that should trigger the callback. Compared case-insensitively against `KeyboardEvent.key`.
 * @param callback - The function to execute when a matching key is pressed.
 * @param preventDefault - Whether to call `e.preventDefault()` on matching key events. Defaults to `false`.
 * 
 * @example
 * ```tsx
 * useKeyboardShortcut('Escape', () => setIsOpen(false), true);
 * useKeyboardShortcut(['Enter', 'n'], () => handleCreate(), false);
 * ```
 */
export function useKeyboardShortcut(
  key: string | string[],
  callback: () => void,
  preventDefault = false,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const keys = (Array.isArray(key) ? key : [key]).map(k => k.toLowerCase());
    const handler = (e: KeyboardEvent) => {
      // Bare-key shortcuts only — never hijack native chords (Ctrl+C, Cmd+F, Alt+…).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!keys.includes(e.key.toLowerCase())) return;
      if (isTextEntryTarget(e.target)) return;
      if (preventDefault) e.preventDefault();
      callbackRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(key) ? key.join('\0') : key, preventDefault]);
}
