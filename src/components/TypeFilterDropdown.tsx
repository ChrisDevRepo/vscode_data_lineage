import { memo } from 'react';
import type { ObjectType } from '../engine/types';
import { TYPE_LABELS, TYPE_COLORS } from '../utils/schemaColors';
import { ToolbarDropdown } from './ui/ToolbarDropdown';

interface TypeFilterDropdownProps {
  /** The set of object types (table, view, etc.) currently active in the filter. */
  types: Set<ObjectType>;
  /** Callback to toggle a specific object type in the filter. */
  onToggleType: (type: ObjectType) => void;
  /** Whether the filter is currently active (narrowing the results). */
  isNarrowed?: boolean;
}

const ALL_TYPES: ObjectType[] = ['table', 'view', 'procedure', 'function', 'external'];

const TYPE_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6Z" />
  </svg>
);

/**
 * A dropdown menu for filtering database objects by their type.
 *
 * Allows users to selectively show or hide tables, views, stored procedures,
 * functions, and external tables in the lineage graph.
 */
export const TypeFilterDropdown = memo(function TypeFilterDropdown({
  types,
  onToggleType,
  isNarrowed = false,
}: TypeFilterDropdownProps) {
  return (
    <ToolbarDropdown
      tooltipContent="Filter Types"
      isNarrowed={isNarrowed}
      icon={TYPE_ICON}
      panelWidth="w-56"
      panelRole="listbox"
      ariaLabel="Filter object types"
    >
      {ALL_TYPES.map((type) => (
        <div key={type} className="flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors ln-list-item">
          <input
            type="checkbox"
            checked={types.has(type)}
            onChange={() => onToggleType(type)}
            className="w-4 h-4 rounded-sm border cursor-pointer ln-checkbox"
          />
          <span className="text-sm" style={{ color: 'var(--ln-fg-dim)' }}>{TYPE_COLORS[type].icon}</span>
          <span className="text-sm ln-text">{TYPE_LABELS[type]}</span>
        </div>
      ))}
    </ToolbarDropdown>
  );
});
