import { useState, useRef, useCallback, useEffect } from 'react';
import {
  useFloating,
  useInteractions,
  useDismiss,
  flip,
  shift,
  offset,
  autoUpdate,
  type Placement,
} from '@floating-ui/react';

/** Internal event name for dropdown orchestration. */
const DROPDOWN_OPEN_EVENT = 'ln:dropdown:open';

/**
 * Provides positioned dropdown state, dismissal, and mutual exclusion with other dropdowns.
 *
 * @remarks
 * A window event closes other active dropdowns when one opens. Floating UI supplies placement,
 * collision handling and dismissal; the caller's trigger calls `toggle` itself.
 *
 * @param placement - Floating UI placement; defaults to `bottom-start`.
 * @returns Visibility controls, positioning refs/styles, and the floating element's prop getter.
 */
export function useDropdown(placement: Placement = 'bottom-start') {
  const [isOpen, setIsOpen] = useState(false);
  const idRef = useRef<symbol>(Symbol());

  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

  useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent(DROPDOWN_OPEN_EVENT, { detail: idRef.current }));
    }
  }, [isOpen]);

  useEffect(() => {
    const onOtherOpen = (e: Event) => {
      if ((e as CustomEvent<symbol>).detail !== idRef.current) setIsOpen(false);
    };
    window.addEventListener(DROPDOWN_OPEN_EVENT, onOtherOpen);
    return () => window.removeEventListener(DROPDOWN_OPEN_EVENT, onOtherOpen);
  }, []);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const dismiss = useDismiss(context);
  const { getFloatingProps } = useInteractions([dismiss]);

  return {
    isOpen,
    close,
    toggle,
    refs,
    floatingStyles,
    context,
    getFloatingProps,
  };
}
