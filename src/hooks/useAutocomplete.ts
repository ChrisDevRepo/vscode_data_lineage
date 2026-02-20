import { useState, useRef, useEffect, useCallback } from 'react';
import type { AutocompleteNode } from '../utils/autocomplete';
import { useClickOutside } from './useClickOutside';

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
  useClickOutside([dropdownRef, inputRef], isOpen, close);

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
