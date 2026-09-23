import { memo, useMemo, useCallback, useState } from 'react';
import { FloatingPortal, useFloating, offset, flip, shift, size, autoUpdate } from '@floating-ui/react';
import type { ObjectType } from '../engine/types';
import { filterSuggestions, type AutocompleteNode } from '../utils/autocomplete';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { SuggestionList } from './ui/SuggestionList';
import { Tooltip } from './ui/Tooltip';
import { disabledControl } from './ui/disabledControl';
import { SHORTCUT_KEYS } from '../ui/keyboardShortcuts';

interface SearchWithAutocompleteProps {
  /** Callback to execute a node search/jump; `schema` disambiguates results with the same name. */
  onExecuteSearch?: (name: string, schema?: string) => void;
  /** Optional callback to initiate a trace directly from the search result. */
  onStartTrace?: (nodeId: string) => void;
  /** When set, the Start Trace action renders disabled with this reason instead of starting a trace. */
  startTraceDisabledReason?: string;
  /** Flattened list of all nodes in the project for autocomplete suggestions. */
  allNodes?: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  /** Authoritative set of node IDs currently rendered in the graph; partitions suggestions into "In View" and "Other". */
  visibleNodeIds: Set<string>;
  /** IDs of working-set nodes collapsed inside a schema cluster; forms a third suggestion partition when provided. */
  collapsedSchemaNodeIds?: Set<string>;
}

/** Searches graph nodes and partitions autocomplete results by their rendered visibility. */
export const SearchWithAutocomplete = memo(function SearchWithAutocomplete({
  onExecuteSearch,
  onStartTrace,
  startTraceDisabledReason,
  allNodes = [],
  visibleNodeIds,
  collapsedSchemaNodeIds,
}: SearchWithAutocompleteProps) {
  const [searchTerm, setSearchTerm] = useState('');

  const allSuggestions = useMemo(
    () => filterSuggestions(allNodes, searchTerm),
    [allNodes, searchTerm],
  );

  const { suggestions, collapsedSuggestions, otherSuggestions } = useMemo(() => {
    const rendered: typeof allSuggestions = [];
    const collapsed: typeof allSuggestions = [];
    const filtered: typeof allSuggestions = [];
    for (const n of allSuggestions) {
      if (!visibleNodeIds.has(n.id)) filtered.push(n);
      else if (collapsedSchemaNodeIds?.has(n.id)) collapsed.push(n);
      else rendered.push(n);
    }
    return { suggestions: rendered, collapsedSuggestions: collapsed, otherSuggestions: filtered };
  }, [allSuggestions, visibleNodeIds, collapsedSchemaNodeIds]);

  const allVisibleSuggestions = useMemo(
    () => [...suggestions, ...collapsedSuggestions, ...otherSuggestions],
    [suggestions, collapsedSuggestions, otherSuggestions],
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

  const mergedDropdownRef = useCallback((node: HTMLDivElement | null) => {
    dropdownRef.current = node;
    refs.setFloating(node);
  }, [dropdownRef, refs]);

  useKeyboardShortcut(SHORTCUT_KEYS.quickJump, () => inputRef.current?.focus(), true);

  const closeSearch = useCallback(() => {
    setSearchTerm('');
    setIsOpen(false);
  }, [setIsOpen]);

  const executeSearch = useCallback((name: string, schema?: string) => {
    onExecuteSearch?.(name, schema);
    closeSearch();
  }, [onExecuteSearch, closeSearch]);

  const selectSuggestion = useCallback((node: AutocompleteNode) => {
    executeSearch(node.name, node.schema);
  }, [executeSearch]);

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
              selectSuggestion(allVisibleSuggestions[selectedIndex]);
            } else if (searchTerm.trim()) {
              executeSearch(searchTerm.trim());
            }
          } else if (e.key === 'Escape') {
            closeSearch();
          }
        }}
        placeholder="Quick Jump..."
        className="h-9 w-full pl-3 pr-9 text-sm rounded-sm transition-colors focus:outline-hidden ln-input"
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
            collapsedSuggestions={collapsedSuggestions}
            otherSuggestions={otherSuggestions}
            selectedIndex={selectedIndex}
            onSelect={selectSuggestion}
            onHover={setSelectedIndex}
            dropdownRef={mergedDropdownRef}
            portal
            style={floatingStyles}
            renderAction={onStartTrace ? (node) => {
              const trigger = disabledControl(
                (e: React.MouseEvent) => {
                  e.stopPropagation();
                  onStartTrace(node.id);
                  setSearchTerm('');
                  setIsOpen(false);
                },
                !!startTraceDisabledReason,
                startTraceDisabledReason,
                'Start Trace',
              );
              return (
                <Tooltip content={trigger.tooltip}>
                  <button
                    onClick={trigger.onClick}
                    disabled={trigger.disabled}
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-sm hover:opacity-70 ln-text-link disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40"
                  >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5" />
                  </svg>
                </button>
                </Tooltip>
              );
            } : undefined}
          />
        </FloatingPortal>
      )}
    </div>
  );
});
