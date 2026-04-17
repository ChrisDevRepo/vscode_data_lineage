import React, { memo, useState } from 'react';
import type { SchemaInfo } from '../engine/types';
import { getSchemaColor } from '../utils/schemaColors';

/**
 * Props for the {@link SchemaSelector} component.
 */
interface SchemaSelectorProps {
  /** Array of schema information objects to display in the list. */
  schemas: SchemaInfo[];
  /** A set of currently selected schema names. */
  selectedSchemas: Set<string>;
  /** Callback function to toggle the selection of a specific schema. */
  onToggle: (name: string) => void;
  /** Callback function to select all schemas in the current filtered list. */
  onSelectAll: (names: string[]) => void;
  /** Callback function to clear all schemas in the current filtered list. */
  onClearAll: (names: string[]) => void;
}

/**
 * A searchable multi-select list component for filtering the graph by database schemas.
 *
 * @remarks
 * This component provides a list of schemas with their corresponding node counts and colors.
 * It includes an integrated search bar (visible if there are more than 5 schemas) and "All/None" quick actions.
 * Selection state is managed via a `Set` for efficient lookups.
 *
 * @param props - The component properties.
 * @returns A {@link React.JSX.Element} representing the schema selection interface.
 */
export const SchemaSelector = memo(function SchemaSelector({
  schemas,
  selectedSchemas,
  onToggle,
  onSelectAll,
  onClearAll,
}: SchemaSelectorProps) {
  const [searchTerm, setSearchTerm] = useState('');
  
  /**
   * Filters the schema list based on the user's search term.
   */
  const filteredSchemas = searchTerm
    ? schemas.filter((s) => s.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : schemas;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium ln-text">Schemas</label>
        <div className="flex items-center gap-2">
          <button 
            className="text-[10px] hover:underline ln-text-link" 
            onClick={() => onSelectAll(filteredSchemas.map(s => s.name))}
          >
            All
          </button>
          <span className="text-[10px] ln-text-muted">|</span>
          <button 
            className="text-[10px] hover:underline ln-text-link" 
            onClick={() => onClearAll(filteredSchemas.map(s => s.name))}
          >
            None
          </button>
        </div>
      </div>
      {schemas.length > 5 && (
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search schemas..."
          className="w-full h-7 px-2 text-xs rounded ln-input mb-1"
        />
      )}
      <div className="space-y-0.5 h-52 overflow-y-auto p-1.5 rounded ln-schema-list">
        {filteredSchemas.map((schema) => {
          const color = getSchemaColor(schema.name);
          return (
            <label
              key={schema.name}
              className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded transition-colors ln-list-item"
            >
              <input
                type="checkbox"
                checked={selectedSchemas.has(schema.name)}
                onChange={() => onToggle(schema.name)}
                className="rounded ln-checkbox"
              />
              <span
                className="inline-block rounded-full flex-shrink-0"
                style={{ width: 8, height: 8, backgroundColor: color }}
              />
              <span className="text-xs flex-1 truncate">{schema.name}</span>
              <span className="text-[10px] tabular-nums ln-text-muted">{schema.nodeCount}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
});
