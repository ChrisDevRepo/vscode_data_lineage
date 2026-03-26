import { useState, useRef, useCallback, useEffect } from 'react';
import {
  useFloating,
  useInteractions,
  useDismiss,
  useClick,
  flip,
  shift,
  offset,
  autoUpdate,
  type Placement,
} from '@floating-ui/react';

const DROPDOWN_OPEN_EVENT = 'ln:dropdown:open';

/**
 * Shared dropdown behaviour: toggle, Escape-to-close, click-outside-to-close,
 * mutual exclusion (opening one closes all others), and Floating UI positioning.
 *
 * @param placement Floating UI placement — default 'bottom-start' (left-aligned below trigger).
 *                  Use 'bottom-end' for right-aligned dropdowns.
 */
export function useDropdown(placement: Placement = 'bottom-start') {
  const [isOpen, setIsOpen] = useState(false);
  const idRef = useRef<symbol>(Symbol());

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

  // When this dropdown opens, tell all others to close
  useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent(DROPDOWN_OPEN_EVENT, { detail: idRef.current }));
    }
  }, [isOpen]);

  // Close self when another dropdown opens
  useEffect(() => {
    const onOtherOpen = (e: Event) => {
      if ((e as CustomEvent<symbol>).detail !== idRef.current) setIsOpen(false);
    };
    window.addEventListener(DROPDOWN_OPEN_EVENT, onOtherOpen as EventListener);
    return () => window.removeEventListener(DROPDOWN_OPEN_EVENT, onOtherOpen as EventListener);
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
  const click = useClick(context, { toggle: false }); // toggle handled manually

  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, click]);

  return {
    isOpen,
    open,
    close,
    toggle,
    refs,
    floatingStyles,
    getReferenceProps,
    getFloatingProps,
  };
}
