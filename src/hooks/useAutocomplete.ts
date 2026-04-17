import { useState, useRef, useEffect, useCallback } from 'react';
import type { AutocompleteNode } from '../utils/autocomplete';

/**
 * Custom hook to manage the state and interactions of an autocomplete dropdown.
 * 
 * @remarks
 * This hook handles the visibility of the dropdown (based on input length), 
 * keyboard navigation (arrow keys), and "click outside" detection to close the menu.
 * It is designed to be composed with custom selection logic in the component.
 * 
 * @param suggestions - The list of matching nodes to display in the dropdown.
 * @param inputValue - The current raw value of the search input.
 * @returns An object containing indices, open state, refs, and key handlers.
 */
export function useAutocomplete(suggestions: AutocompleteNode[], inputValue: string) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsOpen(inputValue.length >= 2 && suggestions.length > 0);
    setSelectedIndex(0);
  }, [inputValue, suggestions.length]);

  const close = useCallback(() => setIsOpen(false), []);

  // Capture phase: fires before ReactFlow's pane stopPropagation
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside = dropdownRef.current?.contains(target) || inputRef.current?.contains(target);
      if (!inside) close();
    };
    document.addEventListener('mousedown', onMouseDown, { capture: true });
    return () => document.removeEventListener('mousedown', onMouseDown, { capture: true });
  }, [isOpen, close]);

  /** Handles ArrowDown/ArrowUp keys. Consumers compose this with their own Enter/Escape logic. */
  const handleArrowKeys = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
    },
    [suggestions.length],
  );

  return {
    selectedIndex,
    setSelectedIndex,
    isOpen,
    setIsOpen,
    inputRef,
    dropdownRef,
    handleArrowKeys,
  };
}
