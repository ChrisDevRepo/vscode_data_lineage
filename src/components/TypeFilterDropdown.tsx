import { memo, useState } from 'react';
import { ObjectType } from '../engine/types';
import { TYPE_LABELS, TYPE_COLORS } from '../utils/schemaColors';
import { Button } from './ui/Button';

interface TypeFilterDropdownProps {
  types: Set<ObjectType>;
  onToggleType: (type: ObjectType) => void;
}

const ALL_TYPES: ObjectType[] = ['table', 'view', 'procedure', 'function'];

export const TypeFilterDropdown = memo(function TypeFilterDropdown({
  types,
  onToggleType,
}: TypeFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        onClick={() => setIsOpen(!isOpen)}
        variant="icon"
        title="Filter Types"
        style={isOpen ? { background: 'var(--vscode-toolbar-activeBackground)' } : undefined}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 6h.008v.008H6V6Z"
          />
        </svg>
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-20" onMouseDown={() => setIsOpen(false)} />
          <div className="absolute top-full mt-2 w-56 rounded-md shadow-lg z-30 p-2 ln-dropdown">
            {ALL_TYPES.map((type) => (
              <div
                key={type}
                className="flex items-center gap-2 px-2 py-1.5 rounded transition-colors ln-list-item"
              >
                <input
                  type="checkbox"
                  checked={types.has(type)}
                  onChange={() => onToggleType(type)}
                  className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
                />
                <span className="text-sm" style={{ color: 'var(--ln-fg-dim)' }}>{TYPE_COLORS[type].icon}</span>
                <span className="text-sm">{TYPE_LABELS[type]}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
});
