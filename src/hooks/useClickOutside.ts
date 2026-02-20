import { useEffect, type RefObject } from 'react';

/**
 * Close a dropdown/overlay when clicking outside one or more refs.
 * The callback fires when a mousedown lands outside ALL provided refs.
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null>[],
  isActive: boolean,
  onClickOutside: () => void,
): void {
  useEffect(() => {
    if (!isActive) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInside = refs.some(ref => ref.current?.contains(target));
      if (!isInside) onClickOutside();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [refs, isActive, onClickOutside]);
}
