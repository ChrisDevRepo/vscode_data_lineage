import type { CSSProperties, ReactNode, Ref } from 'react';
import type { AutocompleteNode } from '../../utils/autocomplete';
import { TYPE_LABELS } from '../../utils/schemaColors';

interface SuggestionListProps {
  suggestions: AutocompleteNode[];
  selectedIndex: number;
  onSelect: (node: AutocompleteNode) => void;
  onHover: (index: number) => void;
  dropdownRef: Ref<HTMLDivElement>;
  className?: string;
  renderAction?: (node: AutocompleteNode) => ReactNode;
  /** When true, skip absolute positioning classes (portal handles positioning). */
  portal?: boolean;
  /** Inline styles from Floating UI positioning. */
  style?: CSSProperties;
}

export function SuggestionList({
  suggestions,
  selectedIndex,
  onSelect,
  onHover,
  dropdownRef,
  className = 'w-full',
  renderAction,
  portal = false,
  style,
}: SuggestionListProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      ref={dropdownRef}
      className={`${portal ? 'z-50' : 'absolute top-full mt-1 z-30'} rounded-md shadow-lg overflow-hidden ln-dropdown ${className}`}
      style={style}
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
