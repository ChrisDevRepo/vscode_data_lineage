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

/** Internal event name for dropdown orchestration. */
const DROPDOWN_OPEN_EVENT = 'ln:dropdown:open';

/**
 * Shared hook for standard dropdown behavior including positioning and orchestration.
 *
 * @remarks
 * This hook provides a comprehensive set of features for UI dropdowns:
 * 1. **Floating UI Integration**: Precise positioning with flip and shift middleware.
 * 2. **Auto-Close**: Closes on Escape key or clicks outside the menu.
 * 3. **Mutual Exclusion**: Ensures that opening one dropdown automatically closes 
 *    all other active dropdowns using a custom event bridge.
 * 4. **Interaction Mapping**: Provides ARIA-compliant props for trigger and content.
 *
 * @param placement - Floating UI placement — default 'bottom-start' (left-aligned below trigger).
 *                    Use 'bottom-end' for right-aligned dropdowns.
 * @returns An object containing visibility state, toggles, positioning styles, and prop getters.
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
