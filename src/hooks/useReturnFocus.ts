import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Hands focus back to the control that opened an inline confirmation once Cancel closes it. The
 * confirmation replaces its trigger, which remounts on Cancel, so focus would fall to the body.
 * Attach `triggerRef(key)` to each trigger and call `returnFocus(key)` in the Cancel handler; the
 * trigger takes focus in the commit that closes the confirmation, and one not mounted then is not
 * focused later.
 */
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

  const triggerRef = useCallback((key: K) => (element: HTMLElement | null) => {
    if (element) triggers.current.set(key, element);
    else triggers.current.delete(key);
  }, []);
  const returnFocus = useCallback((key: K) => { pending.current = { key }; }, []);
  return { triggerRef, returnFocus };
}
