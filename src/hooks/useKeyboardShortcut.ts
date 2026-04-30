import { useEffect, useRef } from 'react';

/**
 * Custom hook for registering global keyboard shortcuts within the VS Code webview context.
 * 
 * @remarks
 * This hook manages event listener registration and cleanup, ensuring that callbacks
 * are always current without triggering unnecessary effect re-runs. It automatically
 * ignores key events originating from input and textarea elements to prevent
 * interference with standard text entry.
 * 
 * @param key - The key or array of keys that should trigger the callback. Matches against `KeyboardEvent.key`.
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
    const keys = Array.isArray(key) ? key : [key];
    const handler = (e: KeyboardEvent) => {
      if (!keys.includes(e.key)) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (preventDefault) e.preventDefault();
      callbackRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(key) ? key.join('\0') : key, preventDefault]);
}
