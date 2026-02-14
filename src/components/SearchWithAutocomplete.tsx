import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { ObjectType } from '../engine/types';
import { TYPE_LABELS } from '../utils/schemaColors';
import { useClickOutside } from '../hooks/useClickOutside';

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
  const [isAutocompleteOpen, setIsAutocompleteOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);

  const autocompleteSuggestions = searchTerm.length >= 2 ? allNodes
    .filter(node =>
      selectedSchemas.has(node.schema) &&
      types.has(node.type) &&
      node.name.toLowerCase().includes(searchTerm.toLowerCase())
    )
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(searchTerm.toLowerCase());
      const bStarts = b.name.toLowerCase().startsWith(searchTerm.toLowerCase());
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 10) : [];

  useEffect(() => {
    setIsAutocompleteOpen(searchTerm.length >= 2 && autocompleteSuggestions.length > 0);
    setSelectedIndex(0);
  }, [searchTerm, autocompleteSuggestions.length]);

  const closeAutocomplete = useCallback(() => setIsAutocompleteOpen(false), []);
  useClickOutside([autocompleteRef, searchInputRef], isAutocompleteOpen, closeAutocomplete);

  return (
    <div className="relative">
      <input
        ref={searchInputRef}
        type="text"
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, autocompleteSuggestions.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
          } else if (e.key === 'Enter' && onExecuteSearch) {
            e.preventDefault();
            if (autocompleteSuggestions.length > 0) {
              const selected = autocompleteSuggestions[selectedIndex];
              onExecuteSearch(selected.name, selected.schema);
            } else if (searchTerm.trim()) {
              onExecuteSearch(searchTerm.trim());
            }
            onSearchChange('');
            setIsAutocompleteOpen(false);
          } else if (e.key === 'Escape') {
            onSearchChange('');
            setIsAutocompleteOpen(false);
          }
        }}
        placeholder="Quick Jump (type 2+ chars)..."
        className="h-9 w-64 pl-3 pr-9 text-sm rounded transition-colors focus:outline-none ln-input"
      />
      <div className="absolute right-0 top-0 h-9 w-9 flex items-center justify-center pointer-events-none ln-text-placeholder">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth="2"
          stroke="currentColor"
          className="w-4 h-4"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
      </div>

      {isAutocompleteOpen && autocompleteSuggestions.length > 0 && (
        <div
          ref={autocompleteRef}
          className="absolute top-full mt-1 w-full rounded-md shadow-lg z-30 overflow-hidden ln-dropdown"
        >
          {autocompleteSuggestions.map((node, index) => (
            <div
              key={node.id}
              className={`px-3 py-2 text-sm cursor-pointer transition-colors ln-list-item flex items-center justify-between gap-2 ${
                index === selectedIndex ? 'ln-list-item-selected' : ''
              }`}
              onClick={() => {
                if (onExecuteSearch) {
                  onExecuteSearch(node.name, node.schema);
                  onSearchChange('');
                  setIsAutocompleteOpen(false);
                }
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{node.name}</div>
                <div className="text-xs ln-text-muted">
                  {node.schema} · {TYPE_LABELS[node.type]}
                </div>
              </div>
              {onStartTrace && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartTrace(node.id);
                    onSearchChange('');
                    setIsAutocompleteOpen(false);
                  }}
                  className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded hover:opacity-70 ln-text-link"
                  title="Start Trace"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
