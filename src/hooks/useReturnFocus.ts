import { useCallback, useLayoutEffect, useRef } from 'react';

/** Hands focus back to the control that opened an inline confirmation once Cancel closes it. */
export function useReturnFocus<K>(): {
  triggerRef: (key: K) => (element: HTMLElement | null) => void;
  returnFocus: (key: K) => void;
} {
  const triggers = useRef(new Map<K, HTMLElement>());
  const pending = useRef<{ key: K } | null>(null);

  useLayoutEffect(() => {
    if (!pending.current) return;
    const { key } = pending.current;
    pending.current = null;
    triggers.current.get(key)?.focus();
  });

  const triggerRef = useCallback(
    (key: K) => (element: HTMLElement | null) => {
      if (element) triggers.current.set(key, element);
      else triggers.current.delete(key);
    },
    [],
  );
  const returnFocus = useCallback((key: K) => {
    pending.current = { key };
  }, []);
  return { triggerRef, returnFocus };
}
