import { memo, useMemo, useCallback } from 'react';
import { FloatingPortal, useFloating, offset, flip, shift, size, autoUpdate } from '@floating-ui/react';
import { ObjectType } from '../engine/types';
import { filterSuggestions } from '../utils/autocomplete';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { SuggestionList } from './ui/SuggestionList';
import { Tooltip } from './ui/Tooltip';

interface SearchWithAutocompleteProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onExecuteSearch?: (name: string, schema?: string) => void;
  onStartTrace?: (nodeId: string) => void;
  allNodes?: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  selectedSchemas: Set<string>;
  types: Set<ObjectType>;
}

export const SearchWithAutocomplete = memo(function SearchWithAutocomplete({
  searchTerm,
  onSearchChange,
  onExecuteSearch,
  onStartTrace,
  allNodes = [],
  selectedSchemas,
  types,
}: SearchWithAutocompleteProps) {
  const filteredNodes = useMemo(
    () => allNodes.filter(n => (n.schema === '' || selectedSchemas.has(n.schema)) && types.has(n.type)),
    [allNodes, selectedSchemas, types],
  );
  const suggestions = useMemo(
    () => filterSuggestions(filteredNodes, searchTerm),
    [filteredNodes, searchTerm],
  );

  const {
    selectedIndex,
    setSelectedIndex,
    isOpen,
    setIsOpen,
    inputRef,
    dropdownRef,
    handleArrowKeys,
  } = useAutocomplete(suggestions, searchTerm);

  const { refs, floatingStyles } = useFloating({
    open: isOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        apply({ rects, elements }) {
          Object.assign(elements.floating.style, { minWidth: `${rects.reference.width}px`, width: '360px', maxWidth: '420px' });
        },
      }),
    ],
  });

  // Merge dropdownRef (outside-click detection) with floating ref (portal positioning)
  const mergedDropdownRef = useCallback((node: HTMLDivElement | null) => {
    (dropdownRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    refs.setFloating(node);
  }, [dropdownRef, refs]);

  useKeyboardShortcut('/', () => inputRef.current?.focus(), true);

  return (
    <div className="relative" ref={refs.setReference}>
      <input
        ref={inputRef}
        type="text"
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => {
          handleArrowKeys(e);
          if (e.key === 'Enter' && onExecuteSearch) {
            e.preventDefault();
            if (suggestions.length > 0) {
              const selected = suggestions[selectedIndex];
              onExecuteSearch(selected.name, selected.schema);
            } else if (searchTerm.trim()) {
              onExecuteSearch(searchTerm.trim());
            }
            onSearchChange('');
            setIsOpen(false);
          } else if (e.key === 'Escape') {
            onSearchChange('');
            setIsOpen(false);
          }
        }}
        placeholder="Quick Jump..."
        className="h-9 w-full pl-3 pr-9 text-sm rounded transition-colors focus:outline-none ln-input"
      />
      {searchTerm ? (
        <button
          onClick={() => { onSearchChange(''); setIsOpen(false); }}
          className="absolute right-0 top-0 h-9 w-9 flex items-center justify-center ln-text-muted hover:opacity-70"
          aria-label="Clear search"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      ) : (
        <div className="absolute right-0 top-0 h-9 w-9 flex items-center justify-center pointer-events-none ln-text-placeholder">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
        </div>
      )}

      {isOpen && (
        <FloatingPortal>
          <SuggestionList
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            onSelect={(node) => {
              if (onExecuteSearch) {
                onExecuteSearch(node.name, node.schema);
                onSearchChange('');
                setIsOpen(false);
              }
            }}
            onHover={setSelectedIndex}
            dropdownRef={mergedDropdownRef}
            portal
            style={floatingStyles}
            renderAction={onStartTrace ? (node) => (
              <Tooltip content="Start Trace">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartTrace(node.id);
                    onSearchChange('');
                    setIsOpen(false);
                  }}
                  className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded hover:opacity-70 ln-text-link"
                >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5" />
                </svg>
              </button>
              </Tooltip>
            ) : undefined}
          />
        </FloatingPortal>
      )}
    </div>
  );
});
