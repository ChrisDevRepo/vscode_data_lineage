import { memo, useState } from 'react';
import { Tooltip } from './ui/Tooltip';
import { ToolbarDropdown } from './ui/ToolbarDropdown';

interface SchemaFilterDropdownProps {
  /** All unique schema names available in the current project. */
  schemas: string[];
  /** Set of schema names currently selected for rendering. */
  selectedSchemas: Set<string>;
  /** Set of schema names currently "focused" (highlighted/prioritized) in the view. */
  focusSchemas: Set<string>;
  /**
   * Optional callback to toggle a schema's visibility.
   * @param schema - Name of the schema to toggle.
   */
  onToggleSchema?: (schema: string) => void;
  /**
   * Optional callback to select multiple schemas at once (e.g., "Select All").
   * @param schemas - Schemas to select.
   */
  onSelectAll?: (schemas: string[]) => void;
  /**
   * Optional callback to deselect multiple schemas at once.
   * @param schemas - Schemas to deselect.
   */
  onSelectNone?: (schemas: string[]) => void;
  /**
   * Callback to toggle a schema's focus state.
   * @param schema - Name of the schema to focus or unfocus.
   */
  onToggleFocusSchema: (schema: string) => void;
  /** Whether the current filter state is "narrowed" (affects visual indicators). */
  isNarrowed?: boolean;
}

const SCHEMA_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
  </svg>
);

/**
 * Filters and focuses graph schemas with individual and bulk selection controls.
 */
export const SchemaFilterDropdown = memo(function SchemaFilterDropdown({
  schemas,
  selectedSchemas,
  focusSchemas,
  onToggleSchema,
  onSelectAll,
  onSelectNone,
  onToggleFocusSchema,
  isNarrowed = false,
}: SchemaFilterDropdownProps) {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredSchemas = schemas.filter(s =>
    s.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <ToolbarDropdown
      tooltipContent="Filter Schemas"
      isNarrowed={isNarrowed}
      icon={SCHEMA_ICON}
      panelWidth="w-96"
      panelRole="listbox"
      ariaLabel="Filter schemas"
      panelClassName="max-h-96 flex flex-col"
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search schemas..."
          className="flex-1 h-8 px-2 text-sm rounded-sm ln-input"
        />
        {onSelectAll && onSelectNone && (
          <>
            <Tooltip content="Select all visible schemas">
              <button
                onClick={() => onSelectAll(filteredSchemas)}
                className="px-2 h-8 text-xs rounded-sm ln-btn-secondary whitespace-nowrap"
              >All</button>
            </Tooltip>
            <Tooltip content="Deselect all visible schemas">
              <button
                onClick={() => onSelectNone(filteredSchemas)}
                className="px-2 h-8 text-xs rounded-sm ln-btn-secondary whitespace-nowrap"
              >None</button>
            </Tooltip>
          </>
        )}
      </div>

      <div className="overflow-y-auto flex-1">
        {filteredSchemas.map((schema) => (
          <div key={schema} className="flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors ln-list-item">
            {onToggleSchema && (
              <input
                type="checkbox"
                checked={selectedSchemas.has(schema)}
                onChange={() => onToggleSchema(schema)}
                className="w-4 h-4 rounded-sm border cursor-pointer ln-checkbox"
              />
            )}
            <Tooltip content={focusSchemas.has(schema) ? 'Unfocus schema' : 'Focus schema'}>
              <button
                onClick={() => onToggleFocusSchema(schema)}
                className="p-1 rounded-sm transition-colors"
                style={{ color: focusSchemas.has(schema) ? 'var(--vscode-symbolIcon-functionForeground)' : 'var(--ln-fg-muted)' }}
              >
                {focusSchemas.has(schema) ? '⭐' : '☆'}
              </button>
            </Tooltip>
            <span className="flex-1 text-sm ln-text">{schema}</span>
          </div>
        ))}
      </div>
    </ToolbarDropdown>
  );
});
