import { useEffect, useRef } from 'react';

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
