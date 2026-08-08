import { memo, useMemo, useState } from 'react';
import type { SchemaInfo } from '../engine/types';
import { createSchemaColorMap, getSchemaDisplayColor, isExternalOnlyTypeBreakdown } from '../utils/schemaColors';

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
 * Provides searchable schema selection with counts, colors, and bulk actions.
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
  const schemaColorMap = useMemo(
    () => createSchemaColorMap(schemas.filter(s => !isExternalOnlyTypeBreakdown(s.types)).map(s => s.name)),
    [schemas]
  );

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
          className="w-full h-7 px-2 text-xs rounded-sm ln-input mb-1"
        />
      )}
      <div className="space-y-0.5 h-52 overflow-y-auto p-1.5 rounded-sm ln-schema-list">
        {filteredSchemas.map((schema) => {
          const color = getSchemaDisplayColor(schema.name, schemaColorMap, schema.types);
          return (
            <label
              key={schema.name}
              className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded-sm transition-colors ln-list-item"
            >
              <input
                type="checkbox"
                checked={selectedSchemas.has(schema.name)}
                onChange={() => onToggle(schema.name)}
                className="rounded-sm ln-checkbox"
              />
              <span
                className="inline-block rounded-full shrink-0"
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
