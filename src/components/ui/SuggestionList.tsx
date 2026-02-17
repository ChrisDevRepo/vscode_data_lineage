import type { ReactNode, RefObject } from 'react';
import type { AutocompleteNode } from '../../utils/autocomplete';
import { TYPE_LABELS } from '../../utils/schemaColors';

interface SuggestionListProps {
  suggestions: AutocompleteNode[];
  selectedIndex: number;
  onSelect: (node: AutocompleteNode) => void;
  onHover: (index: number) => void;
  dropdownRef: RefObject<HTMLDivElement | null>;
  className?: string;
  renderAction?: (node: AutocompleteNode) => ReactNode;
}

export function SuggestionList({
  suggestions,
  selectedIndex,
  onSelect,
  onHover,
  dropdownRef,
  className = 'w-full',
  renderAction,
}: SuggestionListProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      ref={dropdownRef}
      className={`absolute top-full mt-1 rounded-md shadow-lg z-30 overflow-hidden ln-dropdown ${className}`}
    >
      {suggestions.map((node, index) => (
        <div
          key={node.id}
          className={`px-3 py-2 text-sm cursor-pointer transition-colors ln-list-item flex items-center justify-between gap-2 ${
            index === selectedIndex ? 'ln-list-item-selected' : ''
          }`}
          onClick={() => onSelect(node)}
          onMouseEnter={() => onHover(index)}
        >
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{node.name}</div>
            <div className="text-xs ln-text-muted">
              {node.schema} &middot; {TYPE_LABELS[node.type]}
            </div>
          </div>
          {renderAction?.(node)}
        </div>
      ))}
    </div>
  );
}
