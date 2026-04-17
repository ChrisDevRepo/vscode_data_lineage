import { memo, useState, useEffect, useCallback } from 'react';
import { FloatingPortal, useFloating, offset, flip, shift, size, autoUpdate } from '@floating-ui/react';
import type { ObjectType } from '../engine/types';
import { filterSuggestions } from '../utils/autocomplete';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { SuggestionList } from './ui/SuggestionList';
import { CloseIcon } from './ui/CloseIcon';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the {@link PathFinderBar} component.
 */
interface PathFinderBarProps {
  /** The name of the node where the path search begins. */
  sourceNodeName: string;
  /** Flattened list of all nodes in the graph for target autocomplete. */
  allNodes: Array<{ id: string; name: string; schema: string; type: ObjectType }>;
  /** The result of the last path-finding operation, if any. */
  pathResult: { found: boolean; nodeCount: number; edgeCount: number } | null;
  /** 
   * Callback to execute the path search. 
   * @param targetNodeId The ID of the destination node.
   * @returns true if a path was found, false otherwise.
   */
  onFindPath: (targetNodeId: string) => boolean;
  /** Callback fired when the user closes the path finder interface. */
  onClose: () => void;
}

/**
 * A toolbar component for finding the shortest path between two nodes.
 * 
 * Features:
 * - Autocomplete search for the target node.
 * - Real-time validation of connectivity.
 * - Summary display of the path length (nodes and edges).
 * 
 * Architectural Note: This component is a "Transient Toolbar" that overlays the 
 * standard toolbar when the path-finding mode is active. It manages its own 
 * autocomplete state but delegates the actual graph traversal logic to the parent.
 */
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
          Object.assign(elements.floating.style, { minWidth: `${rects.reference.width}px`, width: '288px' });
        },
      }),
    ],
  });

  const mergedDropdownRef = useCallback((node: HTMLDivElement | null) => {
    (dropdownRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    refs.setFloating(node);
  }, [dropdownRef, refs]);

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

        <div className="relative flex-shrink-0" ref={refs.setReference}>
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
            <FloatingPortal>
              <SuggestionList
                suggestions={suggestions}
                selectedIndex={selectedIndex}
                onSelect={(node) => handleSelect(node.id)}
                onHover={setSelectedIndex}
                dropdownRef={mergedDropdownRef}
                portal
                style={floatingStyles}
              />
            </FloatingPortal>
          )}
        </div>

        {/* Result status */}
        {pathResult && pathResult.found && (
          <span className="text-xs ln-text-muted flex-shrink-0">
            <span className="font-bold">{pathResult.nodeCount} nodes · {pathResult.edgeCount} edges</span>
          </span>
        )}
        {noConnection && (
          <span role="status" className="text-xs flex-shrink-0 ln-text-warning">
            No connection found
          </span>
        )}
      </div>

      <Tooltip content="Close Path Finder">
        <button
          onClick={onClose}
          className="h-8 w-8 flex items-center justify-center rounded transition-colors ln-btn-secondary flex-shrink-0"
        >
          <CloseIcon />
        </button>
      </Tooltip>
    </div>
  );
});
