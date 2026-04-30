import { memo, useMemo, useCallback, useState } from 'react';
import { FloatingPortal, useFloating, offset, flip, shift, size, autoUpdate } from '@floating-ui/react';
import type { ObjectType } from '../engine/types';
import { filterSuggestions } from '../utils/autocomplete';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { SuggestionList } from './ui/SuggestionList';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the {@link SearchWithAutocomplete} component.
 */
interface SearchWithAutocompleteProps {
  /** 
   * Callback to execute a node search/jump. 
   * @param name The name of the object to search for.
   * @param schema Optional schema name to disambiguate results.
   */
  onExecuteSearch?: (name: string, schema?: string) => void;
  /** 
   * Optional callback to initiate a trace directly from the search result. 
   * @param nodeId The ID of the node to trace.
   */
  onStartTrace?: (nodeId: string) => void;
  /** Flattened list of all nodes in the project for autocomplete suggestions. */
  allNodes?: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  /** 
   * Authoritative set of node IDs currently rendered in the graph. 
   * Used to partition suggestions into "In View" and "Other" (filtered out).
   */
  visibleNodeIds: Set<string>;
}

/**
 * A search input component with real-time autocomplete suggestions for rapid graph navigation.
 * 
 * Capabilities:
 * - **Quick Jump**: Instantly focus/zoom to any node by name.
 * - **Visual Partitioning**: Separates search results into "In View" (visible nodes) and 
 *   "Other" (nodes hidden by current filters).
 * - **Trace Shortcut**: Provides an inline action to start an interactive trace from a result.
 * - **Keyboard Optimization**: Supports the `/` hotkey for focus and `Enter`/`ArrowKeys` for selection.
 * 
 * Architectural Remark: This component is optimized for performance by managing its own 
 * local `searchTerm` state. It only triggers expensive parent re-renders when a selection 
 * is finalized.
 */
export const SearchWithAutocomplete = memo(function SearchWithAutocomplete({
  onExecuteSearch,
  onStartTrace,
  allNodes = [],
  visibleNodeIds,
}: SearchWithAutocompleteProps) {
  // Search term is local state — keystrokes only re-render this component,
  // not the entire App/GraphCanvas tree. The parent is notified only on Enter.
  const [searchTerm, setSearchTerm] = useState('');

  const inViewIds = visibleNodeIds;
  const allSuggestions = useMemo(
    () => filterSuggestions(allNodes, searchTerm),
    [allNodes, searchTerm],
  );
  const suggestions = useMemo(
    () => allSuggestions.filter(n => inViewIds.has(n.id)),
    [allSuggestions, inViewIds],
  );
  const otherSuggestions = useMemo(
    () => allSuggestions.filter(n => !inViewIds.has(n.id)),
    [allSuggestions, inViewIds],
  );

  const allVisibleSuggestions = useMemo(
    () => [...suggestions, ...otherSuggestions],
    [suggestions, otherSuggestions],
  );
  const {
    selectedIndex,
    setSelectedIndex,
    isOpen,
    setIsOpen,
    inputRef,
    dropdownRef,
    handleArrowKeys,
  } = useAutocomplete(allVisibleSuggestions, searchTerm);

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
        onChange={(e) => setSearchTerm(e.target.value)}
        onKeyDown={(e) => {
          handleArrowKeys(e);
          if (e.key === 'Enter' && onExecuteSearch) {
            e.preventDefault();
            if (allVisibleSuggestions.length > 0) {
              const selected = allVisibleSuggestions[selectedIndex];
              onExecuteSearch(selected.name, selected.schema);
            } else if (searchTerm.trim()) {
              onExecuteSearch(searchTerm.trim());
            }
            setSearchTerm('');
            setIsOpen(false);
          } else if (e.key === 'Escape') {
            setSearchTerm('');
            setIsOpen(false);
          }
        }}
        placeholder="Quick Jump..."
        className="h-9 w-full pl-3 pr-9 text-sm rounded transition-colors focus:outline-none ln-input"
      />
      {searchTerm ? (
        <button
          onClick={() => { setSearchTerm(''); setIsOpen(false); }}
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
            otherSuggestions={otherSuggestions}
            selectedIndex={selectedIndex}
            onSelect={(node) => {
              if (onExecuteSearch) {
                onExecuteSearch(node.name, node.schema);
                setSearchTerm('');
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
                    setSearchTerm('');
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
