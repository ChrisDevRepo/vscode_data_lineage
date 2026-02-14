import { memo, useState, useRef, useEffect, useCallback } from 'react';
import type { ObjectType } from '../engine/types';
import { TYPE_LABELS } from '../utils/schemaColors';
import { useClickOutside } from '../hooks/useClickOutside';
import { filterSuggestions } from '../utils/autocomplete';

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [noConnection, setNoConnection] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const suggestions = filterSuggestions(allNodes, input);

  useEffect(() => {
    setIsOpen(input.length >= 2 && suggestions.length > 0);
    setSelectedIndex(0);
  }, [input, suggestions.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const closeDropdown = useCallback(() => setIsOpen(false), []);
  useClickOutside([dropdownRef, inputRef], isOpen, closeDropdown);

  const handleSelect = useCallback((nodeId: string) => {
    const found = onFindPath(nodeId);
    setNoConnection(!found);
    setInput('');
    setIsOpen(false);
  }, [onFindPath]);

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
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
              } else if (e.key === 'Enter') {
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

          {isOpen && suggestions.length > 0 && (
            <div
              ref={dropdownRef}
              className="absolute top-full mt-1 w-72 rounded-md shadow-lg z-30 overflow-hidden ln-dropdown"
            >
              {suggestions.map((node, index) => (
                <div
                  key={node.id}
                  className={`px-3 py-2 text-sm cursor-pointer transition-colors ln-list-item ${
                    index === selectedIndex ? 'ln-list-item-selected' : ''
                  }`}
                  onClick={() => handleSelect(node.id)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="font-medium truncate">{node.name}</div>
                  <div className="text-xs ln-text-muted">
                    {node.schema} · {TYPE_LABELS[node.type]}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Result status */}
        {pathResult && pathResult.found && (
          <span className="text-xs ln-text-muted flex-shrink-0">
            <span className="font-bold">{pathResult.nodeCount} nodes · {pathResult.edgeCount} edges</span>
          </span>
        )}
        {noConnection && (
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--ln-text-warning)' }}>
            No connection found
          </span>
        )}
      </div>

      <button
        onClick={onClose}
        className="h-8 w-8 flex items-center justify-center rounded transition-colors ln-btn-secondary flex-shrink-0"
        title="Close Path Finder"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
});
