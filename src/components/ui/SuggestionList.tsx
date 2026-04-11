import type { CSSProperties, ReactNode, Ref } from 'react';
import type { AutocompleteNode } from '../../utils/autocomplete';
import { TYPE_LABELS } from '../../utils/schemaColors';
import { Tooltip } from './Tooltip';

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
  /** Nodes that exist in the model but are not visible in the current filtered view. */
  otherSuggestions?: AutocompleteNode[];
}

function SuggestionRow({
  node,
  index,
  selectedIndex,
  onSelect,
  onHover,
  renderAction,
  dimmed = false,
}: {
  node: AutocompleteNode;
  index: number;
  selectedIndex: number;
  onSelect: (node: AutocompleteNode) => void;
  onHover: (index: number) => void;
  renderAction?: (node: AutocompleteNode) => ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div
      key={node.id}
      className={`px-2 py-1.5 cursor-pointer transition-colors ln-list-item flex items-center justify-between gap-2 ${
        index === selectedIndex ? 'ln-list-item-selected' : ''
      }`}
      style={dimmed ? { opacity: 0.5 } : undefined}
      onClick={() => onSelect(node)}
      onMouseEnter={() => onHover(index)}
    >
      <Tooltip content={`${node.schema}.${node.name}`} asChild>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{node.name}</div>
          <div className="text-[10px] leading-tight ln-text-muted">
            {node.schema} &middot; {TYPE_LABELS[node.type]}
          </div>
        </div>
      </Tooltip>
      {dimmed && (
        <Tooltip content="Not visible in current view">
          <span className="text-[10px] ln-text-dim select-none flex-shrink-0">{'\u2298'}</span>
        </Tooltip>
      )}
      {renderAction?.(node)}
    </div>
  );
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
  otherSuggestions = [],
}: SuggestionListProps) {
  if (suggestions.length === 0 && otherSuggestions.length === 0) return null;

  return (
    <div
      ref={dropdownRef}
      className={`${portal ? 'z-50' : 'absolute top-full mt-1 z-30'} rounded-md shadow-lg overflow-hidden ln-dropdown ${className}`}
      style={style}
    >
      {suggestions.map((node, index) => (
        <SuggestionRow
          key={node.id}
          node={node}
          index={index}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onHover={onHover}
          renderAction={renderAction}
        />
      ))}
      {otherSuggestions.length > 0 && (
        <>
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide ln-text-dim border-t ln-border">
            Not in current view {'\u2298'}
          </div>
          {otherSuggestions.map((node, i) => (
            <SuggestionRow
              key={node.id}
              node={node}
              index={suggestions.length + i}
              selectedIndex={selectedIndex}
              onSelect={onSelect}
              onHover={onHover}
              renderAction={renderAction}
              dimmed
            />
          ))}
        </>
      )}
    </div>
  );
}
