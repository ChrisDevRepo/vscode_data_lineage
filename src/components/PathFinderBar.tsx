import { memo, useState, useEffect, useCallback } from 'react';
import type { ObjectType } from '../engine/types';
import { filterSuggestions } from '../utils/autocomplete';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { SuggestionList } from './ui/SuggestionList';
import { CloseIcon } from './ui/CloseIcon';

interface PathFinderBarProps {
  sourceNodeName: string;
  allNodes: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  pathResult: { found: boolean; nodeCount: number; edgeCount: number } | null;
  onFindPath: (targetNodeId: string) => boolean;
  onClose: () => void;
}

export const PathFinderBar = memo(function PathFinderBar({
  sourceNodeName,
  allNodes,
  pathResult,
  onFindPath,
  onClose,
}: PathFinderBarProps) {
  const [input, setInput] = useState('');
  const [noConnection, setNoConnection] = useState(false);

  const suggestions = filterSuggestions(allNodes, input);

  const {
    selectedIndex,
    setSelectedIndex,
    isOpen,
    setIsOpen,
    inputRef,
    dropdownRef,
    handleArrowKeys,
  } = useAutocomplete(suggestions, input);

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  const handleSelect = useCallback((nodeId: string) => {
    const found = onFindPath(nodeId);
    setNoConnection(!found);
    setInput('');
    setIsOpen(false);
  }, [onFindPath, setIsOpen]);

  return (
    <div className="ln-trace-config flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm font-medium ln-text">From:</span>
          <span className="text-sm font-semibold ln-text-link">{sourceNodeName}</span>
        </div>

        <span className="text-sm ln-text-muted flex-shrink-0">&rarr;</span>

        <div className="relative flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setNoConnection(false); }}
            onKeyDown={(e) => {
              handleArrowKeys(e);
              if (e.key === 'Enter') {
                e.preventDefault();
                if (suggestions.length > 0) {
                  handleSelect(suggestions[selectedIndex].id);
                }
              } else if (e.key === 'Escape') {
                setInput('');
                setIsOpen(false);
              }
            }}
            placeholder="Type target node..."
            className="h-9 w-56 pl-3 pr-3 text-sm rounded transition-colors focus:outline-none ln-input"
          />

          {isOpen && (
            <SuggestionList
              suggestions={suggestions}
              selectedIndex={selectedIndex}
              onSelect={(node) => handleSelect(node.id)}
              onHover={setSelectedIndex}
              dropdownRef={dropdownRef}
              className="w-72"
            />
          )}
        </div>

        {/* Result status */}
        {pathResult && pathResult.found && (
          <span className="text-xs ln-text-muted flex-shrink-0">
            <span className="font-bold">{pathResult.nodeCount} nodes · {pathResult.edgeCount} edges</span>
          </span>
        )}
        {noConnection && (
          <span className="text-xs flex-shrink-0 ln-text-warning">
            No connection found
          </span>
        )}
      </div>

      <button
        onClick={onClose}
        className="h-8 w-8 flex items-center justify-center rounded transition-colors ln-btn-secondary flex-shrink-0"
        title="Close Path Finder"
      >
        <CloseIcon />
      </button>
    </div>
  );
});
