import { memo, useState } from 'react';
import { Button } from './ui/Button';

interface SchemaFilterDropdownProps {
  schemas: string[];
  selectedSchemas: Set<string>;
  focusSchemas: Set<string>;
  onToggleSchema?: (schema: string) => void;
  onToggleFocusSchema: (schema: string) => void;
}

export const SchemaFilterDropdown = memo(function SchemaFilterDropdown({
  schemas,
  selectedSchemas,
  focusSchemas,
  onToggleSchema,
  onToggleFocusSchema,
}: SchemaFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredSchemas = schemas.filter(s =>
    s.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="relative">
      <Button
        onClick={() => setIsOpen(!isOpen)}
        variant="icon"
        title="Filter Schemas"
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
            d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
          />
        </svg>
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-20" onMouseDown={() => setIsOpen(false)} />
          <div className="absolute top-full mt-2 w-80 rounded-md shadow-lg z-30 p-3 max-h-96 flex flex-col ln-dropdown">
            <div className="mb-2">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search schemas..."
                className="w-full h-8 px-2 text-sm rounded ln-input"
              />
            </div>

            <div className="overflow-y-auto flex-1">
              {filteredSchemas.map((schema) => (
                <div
                  key={schema}
                  className="flex items-center gap-2 px-2 py-1.5 rounded transition-colors ln-list-item"
                >
                  {onToggleSchema && (
                    <input
                      type="checkbox"
                      checked={selectedSchemas.has(schema)}
                      onChange={() => onToggleSchema(schema)}
                      className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
                    />
                  )}
                  <button
                    onClick={() => onToggleFocusSchema(schema)}
                    className="p-1 rounded transition-colors"
                    title={focusSchemas.has(schema) ? 'Unfocus schema' : 'Focus schema'}
                    style={{
                      color: focusSchemas.has(schema)
                        ? 'var(--vscode-symbolIcon-functionForeground)'
                        : 'var(--ln-fg-muted)',
                    }}
                  >
                    {focusSchemas.has(schema) ? '⭐' : '☆'}
                  </button>
                  <span className="flex-1 text-sm">{schema}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
